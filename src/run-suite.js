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
const { parseArgs } = require('./helpers/json-doc');
const { resolveAppDir, readEnsembles } = require('./helpers/app-config');

//All run artifacts (reports, backups, trash, baseline) live in output/ at the
// tool root, above src/.
const TOOL_ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(TOOL_ROOT, 'output');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

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
  --app=<dir>           App root (default: appPath from ../config.json)
  --workspace=<dir>     Legacy: app assumed at <workspace>/legoz
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
if (args.app)
	passthrough.push(`--app=${args.app}`);

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
const APP_ROOT = resolveAppDir(args);
//Every registered ensemble + the app's app/ folder — the cleanup's whole world.
const CLEANUP_ROOTS = [...readEnsembles(APP_ROOT).map(e => e.root), path.join(APP_ROOT, 'app')];
const measureWorkspace = () => {
	let chars = 0;
	let files = 0;
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
				chars += fs.statSync(p).size;
				files++;
			}
		}
	};
	CLEANUP_ROOTS.forEach(walk);
	return { chars, files };
};

//---------------------------------------------------------------- self-clean
//All run artifacts (trash, backups, reports, baseline) live in output/ —
// clearing state from a previous run means wiping that one folder. The
// ensembles themselves are never touched here — git is their undo path.
const selfClean = () => {
	if (!fs.existsSync(OUTPUT_DIR))
		return false;
	fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
	fs.mkdirSync(OUTPUT_DIR, { recursive: true });
	return true;
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
	CLEANUP_ROOTS.forEach(walk);
	return h.digest('hex');
};

const results = [];
const startedAt = Date.now();

console.log(`\n############ cleanup-suite (${APPLY ? 'APPLY' : 'DRY-RUN'}) ############`);
if (APPLY) {
	if (selfClean())
		console.log('Cleared output/ from the previous run.');
	console.log('Mutating the workspace. Revert = git reset --hard in every ensemble + legoz.\n');
}

const before = measureWorkspace();

//Cumulative conversion totals — convert-report.json is overwritten per pass,
// so the suite sums it after each pass.
const conversionTotals = { scripts: 0, linesBefore: 0, linesAfter: 0 };
const accumulateConversionTotals = () => {
	const reportPath = path.join(OUTPUT_DIR, 'convert-report.json');
	if (!fs.existsSync(reportPath))
		return;
	try {
		const r = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
		conversionTotals.scripts += r.stats?.scripts ?? 0;
		conversionTotals.linesBefore += r.stats?.scriptLines?.before ?? 0;
		conversionTotals.linesAfter += r.stats?.scriptLines?.after ?? 0;
	} catch {
		//Report unreadable — totals stay partial.
	}
};

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

	accumulateConversionTotals();

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

const after = measureWorkspace();
const charsSaved = before.chars - after.chars;
const savedPct = before.chars ? (charsSaved / before.chars * 100).toFixed(1) : '0.0';
console.log('');
console.log(`  Files (.json+.js):  ${before.files.toLocaleString('en-US')} before, ${after.files.toLocaleString('en-US')} after (${(before.files - after.files).toLocaleString('en-US')} fewer)`);
console.log(`  Characters:         ${before.chars.toLocaleString('en-US')} before, ${after.chars.toLocaleString('en-US')} after (${charsSaved >= 0 ? 'saved' : 'grew'} ${Math.abs(charsSaved).toLocaleString('en-US')} = ${Math.abs(Number(savedPct))}%)`);
console.log(`  Scripts converted:  ${conversionTotals.scripts.toLocaleString('en-US')} declarative scripts became JS files`);
console.log(`  Script lines:       ${conversionTotals.linesBefore.toLocaleString('en-US')} declarative before, ${conversionTotals.linesAfter.toLocaleString('en-US')} generated JS after`);

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
