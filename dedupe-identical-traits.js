#!/usr/bin/env node
/* eslint-disable no-console */

/*
	dedupe-identical-traits

	Finds trait files (top-level acceptPrps) whose content is semantically
	identical — byte content compared AFTER resolving each file's relative "./"
	refs against its own folder, so "./functional/x" in two different folders only
	matches when it points at the same target. For each duplicate group one
	canonical file is kept and every reference to the others is rewritten to the
	canonical's absolute "@ensemble/..." form; the duplicate files move to
	./dedupe-backup/.

	Canonical selection: a menu-dataset-referenced copy wins (the DB cannot be
	rewritten), then the most-referenced, then the shortest path. Copies that are
	referenced from JS/JSX or via dynamic refs are kept in place (only their
	JSON-referenced siblings get repointed at them / away from them).

	Files whose relative refs do not resolve against their own folder are excluded
	(viewport-mount-relative paths make their behavior mount-dependent).

	DRY-RUN BY DEFAULT — pass --apply to modify files.
*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createScanner } = require('./lib/scan-core');
const { computeTraitRefs, defaultEntrypointsPath } = require('./lib/trait-refs');
const { loadDoc, saveDoc, replaceStringsInDoc, parseArgs } = require('./lib/json-doc');

const args = parseArgs();

if (args.help) {
	console.log(`
Usage: node dedupe-identical-traits.js [options]

Options:
  --apply               Actually modify files (default: dry-run report only)
  --workspace=<dir>     Workspace root (default: two levels up from this script)
  --entrypoints=<file>  Menu dataset (default: entrypoints.txt / sample)
  --out=<dir>           Report output directory (default: this folder)
  --help                Show this help
`);
	process.exit(0);
}

const APPLY = !!args.apply;
const OUT_DIR = path.resolve(args.out || __dirname);
const BACKUP = path.join(__dirname, 'dedupe-backup');

const scanner = createScanner({ workspace: args.workspace || path.join(__dirname, '..', '..') });
const { WORKSPACE, files, key, rel, ensembles, ensemblesByName } = scanner;

const epPath = args.entrypoints ? path.resolve(args.entrypoints) : defaultEntrypointsPath(__dirname);
const { traitFiles, refsTo } = computeTraitRefs(scanner, { entrypointsPath: epPath, field: args.field });

const RELATIVE_REF = /^\.\/[^\s'"`<>|]+$/;
const norm = p => path.resolve(p).replace(/\\/g, '/');

//---------------------------------------------------------------- semantic hashing
//Stable stringify with sorted keys, relative refs resolved to absolute form.
const semanticForm = file => {
	const doc = loadDoc(file.path);
	if (doc === undefined)
		return null;

	const e = ensemblesByName.get(file.ensemble);
	let resolvable = true;

	const mapString = s => {
		if (!RELATIVE_REF.test(s))
			return s;

		let p = s.slice(2);
		let dir = path.dirname(file.path);
		while (p.startsWith('../')) {
			dir = path.dirname(dir);
			p = p.slice(3);
		}
		const abs = norm(path.join(dir, p));

		const exists = ['.json', '.js', '.jsx', ''].some(ext => fs.existsSync(abs + ext));
		if (!exists || !e || !abs.startsWith(e.root + '/')) {
			resolvable = false;
			return s;
		}

		return `@${file.ensemble}/${abs.slice(e.root.length + 1)}`;
	};

	const stable = v => {
		if (typeof v === 'string')
			return JSON.stringify(mapString(v));
		if (Array.isArray(v))
			return `[${v.map(stable).join(',')}]`;
		if (v !== null && typeof v === 'object')
			return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
		return JSON.stringify(v);
	};

	const text = stable(doc);
	return resolvable ? text : null;
};

//---------------------------------------------------------------- group duplicates
const byHash = new Map();

for (const [k, f] of traitFiles) {
	if (f.isTheme)
		continue;
	const form = semanticForm(f);
	if (form === null)
		continue;

	const hash = crypto.createHash('sha1').update(form).digest('hex');
	if (!byHash.has(hash))
		byHash.set(hash, []);
	byHash.get(hash).push(f);
}

const groups = [...byHash.values()].filter(g => g.length > 1);

//---------------------------------------------------------------- plan rewrites
const plans = [];   //{ canonical, removed: [...], rewrites: [{file, from, to}] }
const skipped = [];

for (const g of groups) {
	const refInfo = f => refsTo.get(key(f.path)) ?? [];
	const menuRef = f => refInfo(f).some(r => r.referrer === '(menu dataset)');

	//Canonical: menu-referenced first, then most referenced, then shortest path.
	const sorted = [...g].sort((a, b) =>
		(menuRef(b) - menuRef(a)) ||
		(refInfo(b).length - refInfo(a).length) ||
		(a.relPath.length - b.relPath.length) ||
		a.relPath.localeCompare(b.relPath));

	const canonical = sorted[0];
	const e = ensemblesByName.get(canonical.ensemble);
	const canonicalRef = `@${canonical.ensemble}/${norm(canonical.path).slice(e.root.length + 1).replace(/\.json$/, '')}`;

	const removed = [];
	const rewrites = [];

	for (const dupe of sorted.slice(1)) {
		const refs = refInfo(dupe);

		//Every reference must be a plain JSON string we can rewrite.
		const blockers = refs.filter(r =>
			r.referrer === '(menu dataset)' ||
			r.via.endsWith('(dynamic)') ||
			!r.referrerPath ||
			files.get(key(r.referrerPath))?.kind !== 'json');

		if (blockers.length) {
			skipped.push({
				file: dupe.relPath,
				canonical: canonical.relPath,
				reason: blockers[0].referrer === '(menu dataset)'
					? 'referenced by the menu dataset'
					: (blockers[0].via.endsWith('(dynamic)') ? 'referenced dynamically' : 'referenced from JS/JSX')
			});
			continue;
		}

		for (const r of refs)
			rewrites.push({ file: r.referrerPath, from: r.via, to: canonicalRef });

		removed.push(dupe);
	}

	if (removed.length)
		plans.push({ canonical, canonicalRef, removed, rewrites });
}

//---------------------------------------------------------------- execute
const docs = new Map();
let rewriteCount = 0;

for (const plan of plans) {
	for (const rw of plan.rewrites) {
		const k = key(rw.file);
		if (!docs.has(k))
			docs.set(k, loadDoc(rw.file));

		const doc = docs.get(k);
		if (!doc)
			continue;

		rewriteCount += replaceStringsInDoc(doc, new Map([[rw.from, rw.to]]));
	}
}

if (APPLY) {
	for (const [k, doc] of docs) {
		if (doc)
			saveDoc(files.get(k).path, doc);
	}

	for (const plan of plans) {
		for (const dupe of plan.removed) {
			const dest = path.join(BACKUP, dupe.relPath);
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.renameSync(dupe.path, dest);
		}
	}
}

//---------------------------------------------------------------- report
const removedTotal = plans.reduce((n, p) => n + p.removed.length, 0);

console.log(`\n================ Duplicate traits (${APPLY ? 'APPLIED' : 'DRY-RUN'}) ================\n`);
console.log(`  Duplicate groups:      ${groups.length}`);
console.log(`  Files removed:         ${removedTotal} (references repointed: ${rewriteCount})`);
console.log(`  Duplicates kept:       ${skipped.length} (menu/JS/dynamic references)`);

for (const p of plans.slice(0, 10)) {
	console.log(`\n  keep    ${p.canonical.relPath}`);
	p.removed.forEach(d => console.log(`  remove  ${d.relPath}`));
}
if (plans.length > 10)
	console.log(`\n  ... and ${plans.length - 10} more groups (see dedupe-report.json)`);

fs.mkdirSync(OUT_DIR, { recursive: true });
const reportPath = path.join(OUT_DIR, 'dedupe-report.json');
fs.writeFileSync(reportPath, JSON.stringify({
	generatedAt: new Date().toISOString(),
	mode: APPLY ? 'apply' : 'dry-run',
	stats: { groups: groups.length, removed: removedTotal, rewrites: rewriteCount, kept: skipped.length },
	plans: plans.map(p => ({
		canonical: p.canonical.relPath,
		removed: p.removed.map(d => d.relPath),
		rewrites: p.rewrites.map(r => ({ file: rel(r.file), from: r.from, to: r.to }))
	})),
	skipped
}, null, '\t'));

console.log(`\n  Report: ${reportPath}`);
if (APPLY && removedTotal)
	console.log(`  Backup: ${BACKUP}`);
if (!APPLY)
	console.log('  Dry-run only — pass --apply to deduplicate.\n');
