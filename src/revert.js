#!/usr/bin/env node
/* eslint-disable no-console */

/*
	revert — undoes a cleanup run by restoring every ensemble (and legoz/app)
	to its committed git state, then clears this tool's internal run state
	(reports, backups, trash) since it no longer matches the workspace.

	  node revert.js            # revert everything
	  node revert.js --dry      # show what would be reverted, change nothing
	  node revert.js --app=<dir>   # default: appPath from ./config.json
*/

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseArgs } = require('./helpers/json-doc');
const { resolveAppDir, readEnsembles } = require('./helpers/app-config');

//Run artifacts (reports, backups, trash) live at the tool root, above src/.
const TOOL_ROOT = path.join(__dirname, '..');

const args = parseArgs();
const DRY = !!args.dry;
const APP_ROOT = resolveAppDir(args);

const git = (cwd, ...gitArgs) => execFileSync('git', gitArgs, { cwd, stdio: 'pipe' });

const isGitRepo = dir => {
	try {
		git(dir, 'rev-parse', '--is-inside-work-tree');
		return true;
	} catch {
		return false;
	}
};

//Same list as run-suite.js — run artifacts that are meaningless after a revert.
const INTERNAL_STATE = [
	'deleted-files', 'merged-traits-backup', 'collapse-backup', 'dedupe-backup',
	'convert-backup', '.convert-check', 'check-refs-baseline.json',
	'convert-report.json', 'merge-report.json', 'collapse-report.json',
	'dedupe-report.json', 'unused-report.json', 'unused-traitprps-report.json',
	'deleted-accept-prps-manifest.json', 'redundant-prps.json',
	'unused-theme-keys.json', 'unused-files.txt', 'unused-roots.txt'
];

console.log(`\n############ revert (${DRY ? 'DRY-RUN' : 'REVERTING'}) ############\n`);

let reverted = 0;
let skipped = 0;

//Registered ensembles first, then the app's app/ folder.
for (const e of readEnsembles(APP_ROOT)) {
	if (!isGitRepo(e.root)) {
		console.log(`  SKIP  ${e.name} (not a git repo)`);
		skipped++;
		continue;
	}

	if (DRY) {
		const status = git(e.root, 'status', '--porcelain').toString().trim();
		console.log(`  ${status ? 'WOULD REVERT' : 'clean       '}  ${e.name}${status ? ` (${status.split('\n').length} changes)` : ''}`);
		continue;
	}

	git(e.root, 'reset', '--hard', '-q');
	git(e.root, 'clean', '-fdq');
	console.log(`  OK    ${e.name}`);
	reverted++;
}

const appBase = path.basename(APP_ROOT);
if (fs.existsSync(path.join(APP_ROOT, 'app')) && isGitRepo(APP_ROOT)) {
	if (DRY) {
		const status = git(APP_ROOT, 'status', '--porcelain', 'app').toString().trim();
		console.log(`  ${status ? 'WOULD REVERT' : 'clean       '}  ${appBase}/app${status ? ` (${status.split('\n').length} changes)` : ''}`);
	} else {
		git(APP_ROOT, 'checkout', '--', 'app');
		git(APP_ROOT, 'clean', '-fdq', 'app');
		console.log(`  OK    ${appBase}/app`);
		reverted++;
	}
}

if (!DRY) {
	const cleared = [];
	for (const name of INTERNAL_STATE) {
		const p = path.join(TOOL_ROOT, name);
		if (fs.existsSync(p)) {
			fs.rmSync(p, { recursive: true, force: true });
			cleared.push(name);
		}
	}
	if (cleared.length)
		console.log(`\n  Cleared internal state: ${cleared.join(', ')}`);
}

console.log(DRY
	? '\nDry-run only — pass no flags to revert for real.\n'
	: `\nReverted ${reverted} location(s)${skipped ? `, skipped ${skipped}` : ''}. The workspace matches committed state.\n`);
