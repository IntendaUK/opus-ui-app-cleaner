#!/usr/bin/env node
/* eslint-disable no-console */

/*
	check-refs — fast reference lint, suitable for CI.

	Checks, across the whole workspace:
	  1. every JSON file parses
	  2. every @ensemble/... and ./... reference resolves to an existing file
	  3. every entrypoint (menu dataset) value resolves to a dashboard file

	Known pre-existing issues live in check-refs-baseline.json — the check only
	FAILS (exit 1) on issues not in the baseline, so it can gate changes without
	first requiring the historical debt to be fixed.

	Usage:
	  node check-refs.js                     # exit 1 on NEW issues vs the baseline
	  node check-refs.js --update-baseline   # accept all current issues as known
	  node check-refs.js --strict            # ignore the baseline, fail on anything
*/

const fs = require('fs');
const path = require('path');
const { createScanner } = require('./helpers/scan-core');
const { resolveAppDir } = require('./helpers/app-config');
const { defaultEntrypointsPath } = require('./helpers/trait-refs');
const { parseArgs } = require('./helpers/json-doc');

//Run artifacts (reports, backups, trash) live at the tool root, above src/.
const TOOL_ROOT = path.join(__dirname, '..');

const args = parseArgs();

if (args.help) {
	console.log(`
Usage: node check-refs.js [options]

Options:
  --update-baseline      Write all current issues to check-refs-baseline.json
  --strict               Ignore the baseline; any issue fails
  --app=<dir>            App root (default: appPath from ../config.json)
  --entrypoints=<file>   Menu dataset (default: entrypoints.txt / sample)
  --field=<name>         Field for JSON entrypoints files
  --help                 Show this help
`);
	process.exit(0);
}

const BASELINE_PATH = path.join(TOOL_ROOT, 'check-refs-baseline.json');

const scanner = createScanner({ appDir: resolveAppDir(args) });
const { files, registerSrcFiles, scanFile, processRef, parseEntrypointsFile } = scanner;

registerSrcFiles();

const issues = [];

//1 + 2: parse validity and unresolved refs (scan-core reports parse failures to the
// console; catch them ourselves for a structured result).
for (const [k, f] of files) {
	if (f.kind === 'json') {
		try {
			JSON.parse(fs.readFileSync(f.path, 'utf-8').replace(/^﻿/, ''));
		} catch (err) {
			issues.push({ type: 'invalid-json', file: f.relPath, detail: String(err.message).slice(0, 120) });
			continue;
		}
	}

	const diag = { unresolvedRefs: [], dynamicRefs: [] };
	scanFile(k, () => {}, diag);
	for (const u of diag.unresolvedRefs)
		issues.push({ type: 'unresolved-ref', file: u.in, detail: u.ref });
}

//3: entrypoints
const epPath = args.entrypoints ? path.resolve(args.entrypoints) : defaultEntrypointsPath(TOOL_ROOT);
if (epPath) {
	const rootFile = { path: '(menu dataset)', relPath: '(menu dataset)', ensemble: null, kind: 'json' };
	for (const v of parseEntrypointsFile(epPath, args.field)) {
		const diag = { unresolvedRefs: [], dynamicRefs: [] };
		processRef(v, rootFile, () => {}, diag);
		for (const u of diag.unresolvedRefs)
			issues.push({ type: 'entrypoint-miss', file: '(menu dataset)', detail: u.ref });
	}
}

const issueKey = i => `${i.type}|${i.file}|${i.detail}`;

if (args['update-baseline']) {
	fs.writeFileSync(BASELINE_PATH, JSON.stringify({
		updatedAt: new Date().toISOString(),
		issues: issues.map(issueKey).sort()
	}, null, '\t'));
	console.log(`Baseline updated: ${issues.length} known issue(s) recorded in ${BASELINE_PATH}`);
	process.exit(0);
}

let baseline = new Set();
if (!args.strict && fs.existsSync(BASELINE_PATH)) {
	try {
		baseline = new Set(JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8')).issues ?? []);
	} catch {}
}

//A pre-existing dangling ref can MOVE to a different file when cleanup tools
// inline/repoint content — same broken ref, new location. Match those by
// type+detail (ignoring the file) and downgrade to a warning.
const baselineDetails = new Set([...baseline].map(k => {
	const parts = k.split('|');
	return `${parts[0]}|${parts.slice(2).join('|')}`;
}));

//A ref whose target sits in ./deleted-files/ was broken BY the intentional
// unused-file deletion (referrer is dead code that only JSON deletion left
// behind, e.g. dev-harness JS) — warning, not failure.
const trashDir = path.join(TOOL_ROOT, 'deleted-files');
const targetIsTrashed = ref => {
	if (!ref.startsWith('@'))
		return false;
	const slash = ref.indexOf('/');
	if (slash === -1)
		return false;
	const e = scanner.ensemblesByName.get(ref.slice(1, slash));
	if (!e)
		return false;
	const relPath = scanner.rel(path.join(e.root, ref.slice(slash + 1) + '.json'));
	return fs.existsSync(path.join(trashDir, relPath));
};

const fresh = [];
const moved = [];
const trashed = [];

for (const i of issues) {
	if (baseline.has(issueKey(i)))
		continue;
	if (baselineDetails.has(`${i.type}|${i.detail}`))
		moved.push(i);
	else if (i.type === 'unresolved-ref' && targetIsTrashed(i.detail))
		trashed.push(i);
	else
		fresh.push(i);
}

const fixed = [...baseline].filter(k => !issues.some(i => issueKey(i) === k));

console.log(`check-refs: ${issues.length} issue(s) total, ${baseline.size} baselined, ${fresh.length} NEW`);
if (moved.length)
	console.log(`${moved.length} pre-existing issue(s) moved to a new file (not failures):`);
for (const i of moved)
	console.log(`  [moved] ${i.detail}   now in ${i.file}`);
if (trashed.length)
	console.log(`${trashed.length} ref(s) point at intentionally deleted files (referrers are dead code — not failures):`);
for (const i of trashed)
	console.log(`  [deleted-target] ${i.detail}   in ${i.file}`);
if (fixed.length)
	console.log(`${fixed.length} baselined issue(s) no longer occur — consider --update-baseline`);

if (fresh.length) {
	console.log('\nNEW issues:');
	for (const i of fresh)
		console.log(`  [${i.type}] ${i.detail}   in ${i.file}`);
	process.exit(1);
}

console.log('OK');
