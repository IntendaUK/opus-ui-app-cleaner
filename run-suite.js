#!/usr/bin/env node
/* eslint-disable no-console */

/*
	cleanup-suite

	Runs the whole code-base cleanup in the right order:

	  1. check-refs --update-baseline     record pre-existing issues
	  2. find-unused-files.js            unused-file analysis
	  3. delete-files.js                   move unused JSON out of the workspace
	  4. delete-accept-prps.js             strip acceptPrps nothing consumes
	  5. collapse-wrapper-traits.js        remove pure passthrough traits
	  6. dedupe-identical-traits.js        one canonical copy per duplicate trait
	  7. unused-traitprps.js               strip dead call-site traitPrps
	  8. merge-single-use-traits.js        inline single-use traits (to fixpoint)
	  9. check-refs.js                     FAIL if the cleanup created new issues
	 10. redundant-prps.js                 report (manual review)
	 11. unused-theme-keys.js              report (manual review)

	Why this order: dead files go first so nothing later wastes work on them (and
	dead referrers don't inflate reference counts); acceptPrps cleanup before
	dedupe/merge because stripping unused props makes more files identical and
	unblocks morph/required-prp merges; collapse + dedupe before merge so shared
	traits stay shared instead of being inlined per copy.

	Without --apply this runs everything in DRY-RUN/report mode (steps that would
	mutate print what they would do; later steps then see the unchanged workspace,
	so their numbers are a lower bound). With --apply it mutates for real — run it
	on committed ensembles; reverting = git reset --hard in every ensemble (plus
	legoz).

	With --apply the suite also:
	  - clears its OWN internal state from the previous run first (trash/backup
	    dirs + reports — the ensembles are never touched by this);
	  - repeats all steps in PASSES until a full pass changes nothing (each pass
	    unlocks work for the next: deletions make traits single-use, merges expose
	    unused files, …). Cap with --maxPasses (default 6).

	Usage:
	  node run-suite.js               # dry-run/report everything (single pass)
	  node run-suite.js --apply       # full cleanup, loops to convergence
	  node run-suite.js --apply --skip=dedupe,collapse   # skip named steps
*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { parseArgs } = require('./lib/json-doc');

const args = parseArgs();

if (args.help) {
	console.log(`
Usage: node run-suite.js [options]

Options:
  --apply               Mutate the workspace (default: dry-run/report everything).
                        Clears the suite's internal state first, then repeats all
                        steps until a full pass changes nothing.
  --maxPasses=<n>       Convergence pass cap with --apply (default 6)
  --skip=<names>        Comma-separated step names to skip. Steps: baseline,
                        unused, delete, acceptprps, collapse, dedupe, traitprps,
                        merge, srcactions, check, redundant, themekeys
  --entrypoints=<file>  Menu dataset passed to every step that takes one
  --workspace=<dir>     Workspace root (default: two levels up from this script)
  --help                Show this help
`);
	process.exit(0);
}

const APPLY = !!args.apply;
const SKIP = new Set((args.skip ? String(args.skip).split(',') : []).map(s => s.trim().toLowerCase()));

const passthrough = [];
if (args.entrypoints)
	passthrough.push(`--entrypoints=${args.entrypoints}`);
if (args.workspace)
	passthrough.push(`--workspace=${args.workspace}`);

//Each step: name, script, args for dry mode, args for apply mode (null = skip in
// that mode), and whether a non-zero exit should stop the suite.
const steps = [
	{
		name: 'baseline',
		title: 'Record pre-existing reference issues',
		script: 'check-refs.js',
		dry: ['--update-baseline'],
		apply: ['--update-baseline']
	},
	{
		name: 'unused',
		title: 'Unused-file analysis',
		script: 'find-unused-files.js',
		dry: [],
		apply: []
	},
	{
		name: 'delete',
		title: 'Move unused JSON out of the workspace',
		script: 'delete-files.js',
		dry: ['--dry-run'],
		apply: []
	},
	{
		name: 'acceptprps',
		title: 'Strip unused acceptPrps',
		script: 'delete-accept-prps.js',
		dry: ['--dry-run'],
		apply: []
	},
	{
		name: 'collapse',
		title: 'Collapse passthrough wrapper traits',
		script: 'collapse-wrapper-traits.js',
		dry: [],
		apply: ['--apply']
	},
	{
		name: 'dedupe',
		title: 'Deduplicate identical traits',
		script: 'dedupe-identical-traits.js',
		dry: [],
		apply: ['--apply']
	},
	{
		name: 'traitprps',
		title: 'Strip dead call-site traitPrps',
		script: 'unused-traitprps.js',
		dry: [],
		apply: ['--apply']
	},
	{
		name: 'merge',
		title: 'Inline single-use traits',
		script: 'merge-single-use-traits.js',
		dry: [],
		apply: ['--apply', '--ignore-trash']
	},
	{
		name: 'srcactions',
		title: 'Convert declarative scripts to srcActions',
		script: 'convert-scripts-to-srcactions.js',
		dry: [],
		apply: ['--apply']
	},
	{
		name: 'check',
		title: 'Verify no new reference issues',
		script: 'check-refs.js',
		dry: null, //meaningless before mutations happened
		apply: [],
		gate: true
	},
	{
		name: 'redundant',
		title: 'Report: prps equal to component defaults',
		script: 'redundant-prps.js',
		dry: [],
		apply: []
	},
	{
		name: 'themekeys',
		title: 'Report: theme keys nothing references',
		script: 'unused-theme-keys.js',
		dry: [],
		apply: []
	}
];

//Total character size of all workspace sources the cleanup touches (ensemble +
// legoz/app .json/.js) — measured before and after so the summary shows the
// net saving of the whole run.
const WORKSPACE_ROOT = path.resolve(args.workspace || path.join(__dirname, '..', '..'));
const measureWorkspaceChars = () => {
	let chars = 0;
	const walk = dir => {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.'))
				continue;
			const p = path.join(dir, e.name);
			if (e.isDirectory())
				walk(p);
			else if (/\.(json|js)$/.test(e.name))
				chars += fs.statSync(p).size;
		}
	};
	for (const e of fs.readdirSync(WORKSPACE_ROOT, { withFileTypes: true })) {
		if (e.isDirectory() && e.name.startsWith('l2_'))
			walk(path.join(WORKSPACE_ROOT, e.name));
	}
	walk(path.join(WORKSPACE_ROOT, 'legoz', 'app'));
	return chars;
};

//---------------------------------------------------------------- self-clean
//Internal state from a PREVIOUS run (trash, backups, reports, baseline). The
// ensembles themselves are never touched here — git is their undo path.
const INTERNAL_STATE = [
	'deleted-files', 'merged-traits-backup', 'collapse-backup', 'dedupe-backup',
	'convert-backup', 'check-refs-baseline.json', 'convert-report.json',
	'merge-report.json', 'collapse-report.json', 'dedupe-report.json',
	'unused-report.json', 'unused-traitprps-report.json',
	'deleted-accept-prps-manifest.json', 'redundant-prps.json',
	'unused-theme-keys.json', 'unused-files.txt', 'unused-roots.txt'
];

const selfClean = () => {
	const cleared = [];
	for (const name of INTERNAL_STATE) {
		const p = path.join(__dirname, name);
		if (fs.existsSync(p)) {
			fs.rmSync(p, { recursive: true, force: true });
			cleared.push(name);
		}
	}
	return cleared;
};

//Content hash over the same file set as the size measure — a pass that leaves
// the hash unchanged did nothing, so the suite has converged.
const workspaceHash = () => {
	const h = crypto.createHash('md5');
	const walk = dir => {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.'))
				continue;
			const p = path.join(dir, e.name);
			if (e.isDirectory())
				walk(p);
			else if (/\.(json|js)$/.test(e.name)) {
				h.update(p);
				h.update(fs.readFileSync(p));
			}
		}
	};
	for (const e of fs.readdirSync(WORKSPACE_ROOT, { withFileTypes: true })) {
		if (e.isDirectory() && e.name.startsWith('l2_'))
			walk(path.join(WORKSPACE_ROOT, e.name));
	}
	walk(path.join(WORKSPACE_ROOT, 'legoz', 'app'));
	return h.digest('hex');
};

const results = [];
const startedAt = Date.now();

console.log(`\n############ cleanup-suite (${APPLY ? 'APPLY' : 'DRY-RUN'}) ############`);
if (APPLY) {
	const cleared = selfClean();
	if (cleared.length)
		console.log(`Cleared internal state from the previous run: ${cleared.join(', ')}`);
	console.log('Mutating the workspace. Revert = git reset --hard in every ensemble + legoz.\n');
}

const charsBefore = measureWorkspaceChars();

const MAX_PASSES = Math.max(1, Number(args.maxPasses ?? 6));
let failed = false;
let converged = !APPLY; //dry-run is a single informational pass by definition
let passes = 0;

for (let pass = 1; pass <= (APPLY ? MAX_PASSES : 1) && !failed; pass++) {
	passes = pass;
	const hashBefore = APPLY ? workspaceHash() : null;

	if (APPLY)
		console.log(`\n######## Pass ${pass} ########`);

	for (const step of steps) {
		const stepArgs = APPLY ? step.apply : step.dry;

		if (SKIP.has(step.name) || stepArgs === null) {
			results.push({ pass, step: step.name, status: 'skipped' });
			continue;
		}

		console.log(`\n======== [pass ${pass}] [${step.name}] ${step.title} ========`);
		const t0 = Date.now();

		try {
			execFileSync(process.execPath, [path.join(__dirname, step.script), ...stepArgs, ...passthrough], {
				stdio: 'inherit',
				cwd: __dirname
			});
			results.push({ pass, step: step.name, status: 'ok', seconds: Math.round((Date.now() - t0) / 1000) });
		} catch (err) {
			results.push({ pass, step: step.name, status: 'FAILED', seconds: Math.round((Date.now() - t0) / 1000) });

			if (step.gate) {
				console.error(`\nSTOP: ${step.script} found NEW issues introduced by the cleanup.`);
				console.error('Nothing after this step ran. Inspect the output above; the backup folders');
				console.error('and git can restore any state.');
			} else
				console.error(`\nSTOP: ${step.script} failed — aborting the suite.`);

			failed = true;
			break;
		}
	}

	if (!failed && APPLY && workspaceHash() === hashBefore) {
		converged = true;
		console.log(`\nPass ${pass} changed nothing — converged.`);
		break;
	}
}

if (APPLY && !failed && !converged)
	console.error(`\nWARNING: still changing after ${MAX_PASSES} passes — re-run or raise --maxPasses.`);

//---------------------------------------------------------------- summary
console.log('\n############ Suite summary ############\n');
if (APPLY)
	console.log(`  Passes: ${passes}${converged ? ' (converged)' : ''}\n`);
let lastPass = 0;
for (const r of results) {
	if (APPLY && r.pass !== lastPass) {
		if (lastPass !== 0)
			console.log('');
		lastPass = r.pass;
	}
	console.log(`  ${r.status === 'ok' ? 'OK  ' : (r.status === 'skipped' ? 'SKIP' : 'FAIL')}  [p${r.pass}] ${r.step}${r.seconds !== undefined ? `  (${r.seconds}s)` : ''}`);
}

console.log(`\n  Total: ${Math.round((Date.now() - startedAt) / 1000)}s`);

const charsAfter = measureWorkspaceChars();
const charsSaved = charsBefore - charsAfter;
const savedPct = charsBefore ? (charsSaved / charsBefore * 100).toFixed(1) : '0.0';
console.log(`\n  Workspace size (l2_* + legoz/app, .json+.js): ${charsBefore.toLocaleString('en-US')} chars before, ${charsAfter.toLocaleString('en-US')} after (${charsSaved >= 0 ? 'saved' : 'grew'} ${Math.abs(charsSaved).toLocaleString('en-US')} = ${Math.abs(Number(savedPct))}%)`);

if (APPLY) {
	console.log(`
  Next steps:
    1. Run the app and click through the menu dashboards.
    2. Review the two report-only outputs (redundant-prps.json, unused-theme-keys.json).
    3. Commit each ensemble (deletion + cleanup can be one commit or per-phase —
       the per-tool reports in this folder document exactly what changed).
  (deleted-files/ and *-backup/ dirs stay as the undo record until the NEXT
   --apply run, which clears them automatically.)
`);
} else {
	console.log(`
  Dry-run note: later steps saw the UNCHANGED workspace, so their numbers are a
  lower bound — e.g. the merge step will inline more once deletion/dedupe have
  actually run. Pass --apply for the real cleanup (on committed ensembles).
`);
}

process.exit(results.some(r => r.status === 'FAILED') ? 1 : 0);
