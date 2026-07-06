#!/usr/bin/env node
/* eslint-disable no-console */

/*
	revert — undoes a cleanup run by restoring every ensemble (and legoz/app)
	to its committed git state, then clears this tool's internal run state
	(reports, backups, trash) since it no longer matches the workspace.

	  node revert.js            # revert everything
	  node revert.js --dry      # show what would be reverted, change nothing
	  node revert.js --workspace=<dir>
*/

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseArgs } = require('./lib/json-doc');

const args = parseArgs();
const DRY = !!args.dry;
const WORKSPACE_ROOT = path.resolve(args.workspace || path.join(__dirname, '..', '..'));

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

for (const e of fs.readdirSync(WORKSPACE_ROOT, { withFileTypes: true })) {
	if (!e.isDirectory() || !e.name.startsWith('l2_'))
		continue;

	const dir = path.join(WORKSPACE_ROOT, e.name);
	if (!isGitRepo(dir)) {
		console.log(`  SKIP  ${e.name} (not a git repo)`);
		skipped++;
		continue;
	}

	if (DRY) {
		const status = git(dir, 'status', '--porcelain').toString().trim();
		console.log(`  ${status ? 'WOULD REVERT' : 'clean       '}  ${e.name}${status ? ` (${status.split('\n').length} changes)` : ''}`);
		continue;
	}

	git(dir, 'reset', '--hard', '-q');
	git(dir, 'clean', '-fdq');
	console.log(`  OK    ${e.name}`);
	reverted++;
}

const legoz = path.join(WORKSPACE_ROOT, 'legoz');
if (fs.existsSync(path.join(legoz, 'app')) && isGitRepo(legoz)) {
	if (DRY) {
		const status = git(legoz, 'status', '--porcelain', 'app').toString().trim();
		console.log(`  ${status ? 'WOULD REVERT' : 'clean       '}  legoz/app${status ? ` (${status.split('\n').length} changes)` : ''}`);
	} else {
		git(legoz, 'checkout', '--', 'app');
		git(legoz, 'clean', '-fdq', 'app');
		console.log('  OK    legoz/app');
		reverted++;
	}
}

if (!DRY) {
	const cleared = [];
	for (const name of INTERNAL_STATE) {
		const p = path.join(__dirname, name);
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
