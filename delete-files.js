#!/usr/bin/env node
/* eslint-disable no-console */

/*
	delete-files

	Moves the files listed in unused-files.txt (or another list) out of the workspace
	into ./deleted-files/, preserving the workspace-relative folder structure so
	undelete-files.js can restore everything exactly where it was.

	Usage:
	  node delete-files.js                    # moves everything in ./unused-files.txt
	  node delete-files.js --list=unused-roots.txt
	  node delete-files.js --dry-run          # show what would move, move nothing
*/

const fs = require('fs');
const path = require('path');

const args = {};
process.argv.slice(2).forEach(a => {
	if (!a.startsWith('--'))
		return;
	const eq = a.indexOf('=');
	if (eq === -1)
		args[a.slice(2)] = true;
	else
		args[a.slice(2, eq)] = a.slice(eq + 1);
});

if (args.help) {
	console.log(`
Usage: node delete-files.js [options]

Moves every file listed in the list file into ./deleted-files/ (same folder
structure), so "node undelete-files.js" can restore them.

Options:
  --list=<file>       List of workspace-relative paths, one per line
                      (default: ./unused-files.txt — the output of find-unused-files.js)
  --workspace=<dir>   Workspace root (default: two levels up from this script)
  --dry-run           Print what would be moved without moving anything
  --help              Show this help
`);
	process.exit(0);
}

const WORKSPACE = path.resolve(args.workspace || path.join(__dirname, '..', '..'));
const TRASH = path.join(__dirname, 'deleted-files');
const listPath = path.resolve(args.list || path.join(__dirname, 'unused-files.txt'));
const dryRun = !!args['dry-run'];

if (!fs.existsSync(listPath)) {
	console.error(`List file not found: ${listPath}`);
	console.error('Run "node find-unused-files.js" first, or pass --list=<file>.');
	process.exit(1);
}

const lines = fs.readFileSync(listPath, 'utf-8')
	.split(/\r?\n/)
	.map(l => l.trim())
	.filter(l => l && !l.startsWith('#'));

//Remove directories that became empty after the move, walking up but never past
// the workspace root.
const pruneEmptyDirs = dir => {
	const stop = path.resolve(WORKSPACE);

	while (path.resolve(dir) !== stop && path.resolve(dir).startsWith(stop)) {
		let entries;
		try {
			entries = fs.readdirSync(dir);
		} catch {
			return;
		}

		if (entries.length > 0)
			return;

		fs.rmdirSync(dir);
		dir = path.dirname(dir);
	}
};

let moved = 0;
let missing = 0;
let skipped = 0;
const manifest = [];

for (const relPath of lines) {
	//Only workspace-relative paths, no escaping upwards.
	const src = path.resolve(WORKSPACE, relPath);
	if (!src.startsWith(path.resolve(WORKSPACE)) || relPath.includes('..')) {
		console.warn(`Skipped (outside workspace): ${relPath}`);
		skipped++;
		continue;
	}

	if (!fs.existsSync(src)) {
		missing++;
		continue;
	}

	const dest = path.join(TRASH, relPath);

	if (dryRun) {
		console.log(`would move  ${relPath}`);
		moved++;
		continue;
	}

	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.renameSync(src, dest);
	pruneEmptyDirs(path.dirname(src));
	manifest.push(relPath);
	moved++;
}

if (!dryRun && manifest.length) {
	//Keep a record of what was moved and when (appends across multiple runs).
	const manifestPath = path.join(TRASH, 'deleted-manifest.json');
	let existing = [];
	try {
		existing = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')).files ?? [];
	} catch {}

	fs.writeFileSync(manifestPath, JSON.stringify({
		lastRun: new Date().toISOString(),
		listUsed: listPath,
		files: [...new Set([...existing, ...manifest])].sort()
	}, null, '\t'));
}

console.log(`\n${dryRun ? '[dry-run] ' : ''}${moved} file(s) ${dryRun ? 'would be ' : ''}moved to ${TRASH}`);
if (missing)
	console.log(`${missing} file(s) in the list no longer exist in the workspace (already moved or deleted).`);
if (skipped)
	console.log(`${skipped} file(s) skipped.`);
if (!dryRun && moved)
	console.log('\nRestore everything with: node undelete-files.js');
