#!/usr/bin/env node
/* eslint-disable no-console */

/*
	delete-accept-prps

	Removes unused props from trait files' top-level "acceptPrps" objects. Runs
	the same analysis as unused-accept-prps.js fresh (never a stale report), so
	only props that are unused RIGHT NOW get removed. The "acceptPrps" key itself
	is never deleted — an (even empty) acceptPrps is what marks a file as a trait.

	Every removal is recorded, with its full prop spec, in
	deleted-accept-prps-manifest.json next to this script; --undo puts everything
	back (restored props are appended at the end of their acceptPrps object).

	Files are rewritten as tab-indented JSON — the same canonical format the
	.claude/hooks/validate-json.cjs hook enforces. A file that wasn't already in
	that format gets fully reformatted; the run output flags those.

	Usage:
	  node delete-accept-prps.js                 # remove all unused acceptPrps
	  node delete-accept-prps.js --dry-run       # preview, changes nothing
	  node delete-accept-prps.js --file=<substr> # only files whose path contains this
	  node delete-accept-prps.js --undo          # restore everything from the manifest
	  node delete-accept-prps.js --help
*/

const fs = require('fs');
const path = require('path');

//---------------------------------------------------------------- CLI args
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
Usage: node delete-accept-prps.js [options]

Removes acceptPrps entries that nothing consumes (as reported by
unused-accept-prps.js), recording them in deleted-accept-prps-manifest.json so
the removal can be reverted.

Options:
  --dry-run              Show what would be removed, change nothing
  --file=<substr>        Only touch files whose workspace path contains <substr>
                         (case-insensitive)
  --undo                 Restore every prop in the manifest, then clear it
  --app=<dir>            App root (default: appPath from ../config.json)
  --help                 Show this help
`);
	process.exit(0);
}

const { resolveAppDir, makeRelResolver } = require('./lib/app-config');
const APP_DIR = resolveAppDir(args);
const absFromRel = makeRelResolver(APP_DIR);
const MANIFEST_PATH = path.join(__dirname, 'deleted-accept-prps-manifest.json');
const dryRun = !!args['dry-run'];

//Canonical write — mirrors .claude/hooks/validate-json.cjs: tab indentation,
// no BOM, trailing newline preserved from the original.
const writeJson = (absPath, json, hadTrailingNewline) => {
	fs.writeFileSync(absPath, JSON.stringify(json, null, '\t') + (hadTrailingNewline ? '\n' : ''), 'utf-8');
};

const readRaw = absPath => fs.readFileSync(absPath, 'utf-8').replace(/^﻿/, '');

//---------------------------------------------------------------- undo mode
if (args.undo) {
	if (!fs.existsSync(MANIFEST_PATH)) {
		console.log(`Nothing to undo — no manifest at ${MANIFEST_PATH}`);
		process.exit(0);
	}

	const manifest = JSON.parse(readRaw(MANIFEST_PATH));
	let restored = 0;
	let skipped = 0;

	//Newest runs first so repeated delete/undo cycles unwind cleanly.
	for (const run of [...(manifest.runs ?? [])].reverse()) {
		for (const entry of run.entries) {
			const absPath = absFromRel(entry.file);

			let raw;
			try {
				raw = readRaw(absPath);
			} catch {
				console.warn(`  SKIP (file missing): ${entry.file}`);
				skipped += Object.keys(entry.removed).length;
				continue;
			}

			let json;
			try {
				json = JSON.parse(raw);
			} catch {
				console.warn(`  SKIP (invalid JSON): ${entry.file}`);
				skipped += Object.keys(entry.removed).length;
				continue;
			}

			if (!json.acceptPrps || typeof json.acceptPrps !== 'object' || Array.isArray(json.acceptPrps))
				json.acceptPrps = {};

			const putBack = [];
			for (const [prop, spec] of Object.entries(entry.removed)) {
				if (json.acceptPrps[prop] !== undefined) {
					console.warn(`  SKIP (already present): ${prop} in ${entry.file}`);
					skipped++;
					continue;
				}

				json.acceptPrps[prop] = spec;
				putBack.push(prop);
			}

			if (!putBack.length)
				continue;

			if (!dryRun)
				writeJson(absPath, json, /\n$/.test(raw));

			restored += putBack.length;
			console.log(`  ${entry.file}`);
			console.log(`      restored: ${putBack.join(', ')}`);
		}
	}

	if (!dryRun && restored)
		fs.unlinkSync(MANIFEST_PATH);

	console.log(`\n${dryRun ? '[dry-run] Would restore' : 'Restored'} ${restored} props` +
		`${skipped ? `, ${skipped} skipped` : ''}` +
		`${!dryRun && restored ? ' — manifest cleared' : ''}\n`);
	process.exit(0);
}

//---------------------------------------------------------------- delete mode
const { createScanner } = require('./lib/scan-core');
const { analyzeAcceptPrps } = require('./lib/accept-prps-core');

const scanner = createScanner({ appDir: APP_DIR });
const { traits } = analyzeAcceptPrps(scanner);

const fileFilter = args.file ? String(args.file).toLowerCase() : null;

const targets = traits.filter(t =>
	t.unused.length &&
	(!fileFilter || t.file.relPath.toLowerCase().includes(fileFilter)));

if (!targets.length) {
	console.log(`No unused acceptPrps found${fileFilter ? ` matching --file=${args.file}` : ''}. Nothing to do.`);
	process.exit(0);
}

console.log(`\n${dryRun ? '[dry-run] Would remove' : 'Removing'} unused acceptPrps from ${targets.length} files:\n`);

const runEntries = [];
let removedCount = 0;
let reformatted = 0;

for (const t of targets) {
	let raw;
	try {
		raw = readRaw(t.file.path);
	} catch {
		console.warn(`  SKIP (unreadable): ${t.file.relPath}`);
		continue;
	}

	let json;
	try {
		json = JSON.parse(raw);
	} catch {
		console.warn(`  SKIP (invalid JSON): ${t.file.relPath}`);
		continue;
	}

	if (!json.acceptPrps || typeof json.acceptPrps !== 'object') {
		console.warn(`  SKIP (no acceptPrps anymore): ${t.file.relPath}`);
		continue;
	}

	const removed = {};
	for (const prop of t.unused) {
		if (json.acceptPrps[prop] === undefined)
			continue;

		removed[prop] = json.acceptPrps[prop];
		delete json.acceptPrps[prop];
	}

	const removedNames = Object.keys(removed);
	if (!removedNames.length)
		continue;

	const hadTrailingNewline = /\n$/.test(raw);
	const wasCanonical = JSON.stringify(JSON.parse(raw), null, '\t') + (hadTrailingNewline ? '\n' : '') === raw;

	if (!dryRun) {
		writeJson(t.file.path, json, hadTrailingNewline);
		runEntries.push({ file: t.file.relPath, removed });
	}

	removedCount += removedNames.length;
	if (!wasCanonical)
		reformatted++;

	console.log(`  ${t.file.relPath}${wasCanonical ? '' : '  (whole file reformatted to tab-indented JSON)'}`);
	console.log(`      removed: ${removedNames.join(', ')}`);
}

//---------------------------------------------------------------- manifest
if (!dryRun && runEntries.length) {
	let manifest = { runs: [] };
	if (fs.existsSync(MANIFEST_PATH)) {
		try {
			manifest = JSON.parse(readRaw(MANIFEST_PATH));
		} catch {
			console.warn(`Manifest was unreadable, starting a new one: ${MANIFEST_PATH}`);
		}
	}
	if (!Array.isArray(manifest.runs))
		manifest.runs = [];

	manifest.runs.push({ at: new Date().toISOString(), entries: runEntries });
	fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, '\t') + '\n');
}

console.log(`\n${dryRun ? '[dry-run] Would remove' : 'Removed'} ${removedCount} props from ${dryRun ? targets.length : runEntries.length} files` +
	`${reformatted ? ` (${reformatted} reformatted)` : ''}.`);
if (!dryRun && runEntries.length) {
	console.log(`Manifest: ${MANIFEST_PATH}`);
	console.log('Revert with: node delete-accept-prps.js --undo\n');
} else
	console.log('');
