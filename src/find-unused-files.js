#!/usr/bin/env node
/* eslint-disable no-console */

/*
	opus-ui-app-cleaner

	Static reachability analysis for the Legoz Opus UI workspace: reports every JSON
	file that nothing reachable references. See lib/scan-core.js for the reference
	forms handled, and README.md for the full story.

	Entry points ("roots") are:
	  1. The app root dashboard (legoz/app/dashboard/index.json) and its startup value
	  2. Viewport values from the menu dataset (--entrypoints file)
	  3. All JS/JSX under legoz/src
	  4. Theme + config JSON of the app and every ensemble
*/

const fs = require('fs');
const path = require('path');
const { createScanner } = require('./helpers/scan-core');
const { resolveAppDir } = require('./helpers/app-config');

//Run artifacts (reports, backups, trash) live at the tool root, above src/.
const TOOL_ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(TOOL_ROOT, 'output');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

//---------------------------------------------------------------- CLI args
const args = { _: [] };
process.argv.slice(2).forEach(a => {
	if (a.startsWith('--')) {
		const eq = a.indexOf('=');
		if (eq === -1)
			args[a.slice(2)] = true;
		else
			args[a.slice(2, eq)] = a.slice(eq + 1);
	} else
		args._.push(a);
});

if (args.help) {
	console.log(`
Usage: node index.js [options]

Options:
  --entrypoints=<file>   Menu dataset viewport values (txt: one per line, or JSON
                         array of strings / objects). Default: ./entrypoints.txt
                         if it exists, otherwise ./entrypoints.sample.txt
  --field=<name>         When the entrypoints file holds JSON objects, the field
                         containing the viewport value (default: loc_nme, value)
  --app=<dir>            App root (default: appPath from ../config.json)
  --out=<dir>            Output directory for reports (default: this folder)
  --explain=<file>       Print the reference chain that makes <file> used
                         (workspace-relative or absolute path)
  --includeJs            Also report unreferenced .js/.jsx files in ensembles
  --help                 Show this help
`);
	process.exit(0);
}

const OUT_DIR = path.resolve(args.out || OUTPUT_DIR);

const scanner = createScanner({ appDir: resolveAppDir(args) });
const { APP, APP_DIR, absFromRel, ensembles, files, norm, key, rel, scanFile, processRef, registerSrcFiles, parseEntrypointsFile } = scanner;

//---------------------------------------------------------------- reachability state
const usedBy = new Map(); //key -> { referrer, via } (first edge that reached it)
const queue = [];
const diag = {
	unresolvedRefs: [],
	dynamicRefs: []
};

const markUsed = (p, referrer, via) => {
	const k = key(p);
	if (usedBy.has(k))
		return;

	usedBy.set(k, { referrer, via });
	queue.push(k);
};

//---------------------------------------------------------------- roots
const ROOT = '(root)';

//1. App root dashboard — the packager/runtime entry; the rest must prove reachability.
const appIndex = path.join(APP_DIR, 'dashboard', 'index.json');
if (fs.existsSync(appIndex))
	markUsed(appIndex, ROOT, 'app startup dashboard');

//2. Theme + config files: merged/applied by the packager regardless of dashboards.
for (const f of files.values()) {
	if (f.kind === 'json' && f.isTheme)
		markUsed(f.path, ROOT, 'theme/config (auto-merged by packager)');
}

//3. legoz/src — registered components/actions can reference ensemble traits.
for (const f of registerSrcFiles())
	markUsed(f, ROOT, 'legoz/src source code');

//4. Menu dataset entry points.
const loadEntrypoints = () => {
	let epPath = args.entrypoints;
	if (!epPath) {
		for (const cand of ['entrypoints.txt', 'entrypoints.json', 'entrypoints.sample.txt']) {
			if (fs.existsSync(path.join(TOOL_ROOT, cand))) {
				epPath = path.join(TOOL_ROOT, cand);
				break;
			}
		}
	}

	if (!epPath) {
		console.warn('\nWARNING: no entrypoints file found. Dashboards opened only from the');
		console.warn('menu dataset will be reported as unused. Provide --entrypoints=<file>.\n');
		return [];
	}

	epPath = path.resolve(epPath);
	console.log(`Entrypoints: ${epPath}`);

	return parseEntrypointsFile(epPath, args.field);
};

const entryValues = loadEntrypoints();
const rootFile = { path: ROOT, relPath: '(menu dataset)', ensemble: null, kind: 'json' };
const missingEntrypoints = [];

for (const v of entryValues) {
	const before = diag.unresolvedRefs.length;
	processRef(v, rootFile, (p, via) => markUsed(p, ROOT, via), diag);
	if (diag.unresolvedRefs.length > before)
		missingEntrypoints.push(v);
}

//---------------------------------------------------------------- BFS
const bfsSinkFor = referrerKey => (p, via) => markUsed(p, files.get(referrerKey)?.path ?? ROOT, via);

while (queue.length) {
	const k = queue.shift();
	scanFile(k, bfsSinkFor(k), diag);
}

//---------------------------------------------------------------- explain mode
if (args.explain) {
	const target = path.isAbsolute(args.explain)
		? args.explain
		: (absFromRel(args.explain) ?? args.explain);
	const k = key(target);

	if (!files.has(k)) {
		console.log(`Not in inventory: ${args.explain}`);
	} else if (!usedBy.has(k)) {
		console.log(`UNUSED — nothing reachable references ${rel(target)}`);
	} else {
		console.log(`Reference chain for ${rel(target)}:\n`);
		let cur = k;
		const seen = new Set();
		while (cur && cur !== ROOT && !seen.has(cur)) {
			seen.add(cur);
			const edge = usedBy.get(cur);
			const f = files.get(cur);
			console.log(`  ${f ? f.relPath : cur}`);
			if (!edge || edge.referrer === ROOT) {
				console.log(`    <- ${edge ? edge.via : '?'}`);
				break;
			}
			console.log(`    <- referenced as "${edge.via}" by:`);
			cur = key(edge.referrer);
		}
	}
	process.exit(0);
}

//---------------------------------------------------------------- report
const unusedJson = [];
const unusedJs = [];

for (const f of files.values()) {
	if (f.ensemble === '(src)' || usedBy.has(key(f.path)))
		continue;

	if (f.kind === 'json')
		unusedJson.push(f);
	else
		unusedJs.push(f);
}

//Second pass: scan the unused files themselves to find which unused files are only
// referenced by OTHER unused files. The remainder — "subtree roots" — are the true
// dead ends to review; deleting a root frees its whole descendant subtree.
const unusedKeys = new Set(unusedJson.map(f => key(f.path)));
const referencedByUnused = new Set();

for (const f of unusedJson) {
	const selfKey = key(f.path);
	scanFile(selfKey, p => {
		const k = key(p);
		if (unusedKeys.has(k) && k !== selfKey)
			referencedByUnused.add(k);
	}, null);
}

const subtreeRoots = unusedJson.filter(f => !referencedByUnused.has(key(f.path)));

const byEnsemble = list => {
	const groups = {};
	for (const f of list)
		(groups[f.ensemble] ??= []).push(f.relPath);
	Object.values(groups).forEach(g => g.sort());
	return groups;
};

const jsonInventory = [...files.values()].filter(f => f.kind === 'json');
const usedJsonCount = jsonInventory.filter(f => usedBy.has(key(f.path))).length;

console.log('\n================ Unused JSON summary ================\n');
const groups = byEnsemble(unusedJson);
const ensembleOrder = [...ensembles.map(e => e.name), '(app)'];

const rootGroups = byEnsemble(subtreeRoots);

for (const name of ensembleOrder) {
	const total = jsonInventory.filter(f => f.ensemble === name).length;
	const unused = groups[name]?.length ?? 0;
	const roots = rootGroups[name]?.length ?? 0;
	if (total > 0)
		console.log(`  ${name.padEnd(28)} ${String(total).padStart(5)} json  ${String(unused).padStart(5)} unused  ${String(roots).padStart(5)} dead-end roots`);
}

console.log(`\n  TOTAL: ${jsonInventory.length} JSON files, ${usedJsonCount} used, ${unusedJson.length} unused (${subtreeRoots.length} dead-end roots)`);
console.log('  A "dead-end root" is an unused file no other unused file references — review these;');
console.log('  the rest of the unused files hang off them as descendants.');
console.log(`  Unresolved references: ${diag.unresolvedRefs.length} (likely typos or deleted files)`);
console.log(`  Dynamic references:    ${diag.dynamicRefs.length} (contain %prp%/{state} — not statically resolvable)`);
if (missingEntrypoints.length)
	console.log(`  Entrypoint values that resolve to no file: ${missingEntrypoints.length}`);

const report = {
	generatedAt: new Date().toISOString(),
	app: norm(APP),
	entrypointsUsed: entryValues.length,
	stats: {
		totalJson: jsonInventory.length,
		usedJson: usedJsonCount,
		unusedJson: unusedJson.length,
		unusedSubtreeRoots: subtreeRoots.length
	},
	missingEntrypoints,
	unusedSubtreeRootsByEnsemble: rootGroups,
	unusedJsonByEnsemble: groups,
	unusedJs: args.includeJs ? byEnsemble(unusedJs) : undefined,
	unresolvedRefs: diag.unresolvedRefs,
	dynamicRefs: diag.dynamicRefs
};

fs.mkdirSync(OUT_DIR, { recursive: true });
const reportPath = path.join(OUT_DIR, 'unused-report.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, '\t'));

const listPath = path.join(OUT_DIR, 'unused-files.txt');
fs.writeFileSync(listPath, unusedJson.map(f => f.relPath).sort().join('\n') + '\n');

const rootsPath = path.join(OUT_DIR, 'unused-roots.txt');
fs.writeFileSync(rootsPath, subtreeRoots.map(f => f.relPath).sort().join('\n') + '\n');

console.log(`\n  Report:     ${reportPath}`);
console.log(`  Flat list:  ${listPath}`);
console.log(`  Roots only: ${rootsPath}`);
console.log('\n  Tip: node index.js --explain=<workspace-relative-path> shows why a file is considered used.\n');
