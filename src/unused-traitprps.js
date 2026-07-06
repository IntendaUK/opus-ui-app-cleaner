#!/usr/bin/env node
/* eslint-disable no-console */

/*
	unused-traitprps

	The call-site mirror of unused-accept-prps: finds traits-array entries that
	pass traitPrps keys the target trait neither declares in acceptPrps NOR uses
	as a %token%/$token$ anywhere in its body (runtime substitution works off the
	passed traitPrps map directly, so an undeclared-but-referenced key is still
	live — only keys that are BOTH undeclared and unreferenced are dead config).

	Entries whose target path is dynamic or unresolvable are left alone.

	DRY-RUN BY DEFAULT — pass --apply to strip the dead keys.
*/

const fs = require('fs');
const path = require('path');
const { createScanner } = require('./helpers/scan-core');
const { resolveAppDir } = require('./helpers/app-config');
const { loadDoc, saveDoc, parseArgs } = require('./helpers/json-doc');

//Run artifacts (reports, backups, trash) live at the tool root, above src/.
const TOOL_ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(TOOL_ROOT, 'output');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const args = parseArgs();

if (args.help) {
	console.log(`
Usage: node unused-traitprps.js [options]

Options:
  --apply               Actually strip dead traitPrps keys (default: dry-run)
  --app=<dir>            App root (default: appPath from ../config.json)
  --out=<dir>           Report output directory (default: this folder)
  --help                Show this help
`);
	process.exit(0);
}

const APPLY = !!args.apply;
const OUT_DIR = path.resolve(args.out || OUTPUT_DIR);

const scanner = createScanner({ appDir: resolveAppDir(args) });
const { files, key, ensemblesByName } = scanner;

const norm = p => path.resolve(p).replace(/\\/g, '/');

//---------------------------------------------------------------- trait prp usage
//Per trait file: the set of prp names it can consume — acceptPrps keys plus every
// %token%/$token$ root name appearing anywhere in the raw text.
const consumableCache = new Map();

const consumablePrps = absPath => {
	const k = key(absPath);
	if (consumableCache.has(k))
		return consumableCache.get(k);

	let result = null;
	const doc = loadDoc(absPath);

	if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
		const names = new Set(Object.keys(doc.acceptPrps ?? {}));

		const raw = JSON.stringify(doc);
		for (const m of raw.matchAll(/[%$]([\w][\w.]*?)[%$]/g)) {
			const root = m[1].replace('...', '').split('.')[0];
			if (root)
				names.add(root);
		}

		//A trait taking a "spread-" or wildcard-key anywhere could consume any key.
		if (raw.includes('"spread-"'))
			result = 'anything';
		else
			result = names;
	}

	consumableCache.set(k, result);
	return result;
};

const resolveTraitPath = (ref, hostAbsPath) => {
	if (typeof ref !== 'string' || ref.includes('%') || ref.includes('$') || ref.includes('{'))
		return null;

	if (ref.startsWith('@')) {
		const slash = ref.indexOf('/');
		const e = slash > 0 ? ensemblesByName.get(ref.slice(1, slash)) : null;
		return e ? norm(path.join(e.root, ref.slice(slash + 1) + '.json')) : null;
	}
	if (ref.startsWith('./')) {
		let p = ref.slice(2);
		let dir = path.dirname(hostAbsPath);
		while (p.startsWith('../')) {
			dir = path.dirname(dir);
			p = p.slice(3);
		}
		return norm(path.join(dir, p + '.json'));
	}
	return null;
};

//---------------------------------------------------------------- scan call sites
const findings = [];
const docs = new Map();

for (const [k, f] of files) {
	if (f.kind !== 'json' || f.ensemble === '(src)' || f.isTheme)
		continue;

	const doc = loadDoc(f.path);
	if (!doc)
		continue;

	let changed = false;

	const visit = node => {
		if (Array.isArray(node)) {
			node.forEach(visit);
			return;
		}
		if (node === null || typeof node !== 'object')
			return;

		if (Array.isArray(node.traits)) {
			for (const t of node.traits) {
				if (!t || typeof t !== 'object' || typeof t.trait !== 'string' || !t.traitPrps || typeof t.traitPrps !== 'object')
					continue;

				const abs = resolveTraitPath(t.trait, f.path);
				if (!abs || !fs.existsSync(abs))
					continue;

				const consumable = consumablePrps(abs);
				if (!consumable || consumable === 'anything')
					continue;

				const dead = Object.keys(t.traitPrps).filter(p => !consumable.has(p));
				if (!dead.length)
					continue;

				findings.push({
					file: f.relPath,
					trait: t.trait,
					dead,
					values: Object.fromEntries(dead.map(d => [d, t.traitPrps[d]]))
				});

				if (APPLY) {
					dead.forEach(d => delete t.traitPrps[d]);
					if (Object.keys(t.traitPrps).length === 0)
						delete t.traitPrps;
					changed = true;
				}
			}
		}

		Object.values(node).forEach(visit);
	};
	visit(doc);

	if (changed)
		docs.set(k, doc);
}

if (APPLY) {
	for (const [k, doc] of docs)
		saveDoc(files.get(k).path, doc);
}

//---------------------------------------------------------------- report
const totalKeys = findings.reduce((n, x) => n + x.dead.length, 0);

console.log(`\n================ Dead traitPrps at call sites (${APPLY ? 'APPLIED' : 'DRY-RUN'}) ================\n`);
console.log(`  Call sites with dead traitPrps: ${findings.length} (${totalKeys} keys) in ${new Set(findings.map(x => x.file)).size} files`);

for (const x of findings.slice(0, 12))
	console.log(`    ${x.file}\n        -> ${x.trait}: ${x.dead.join(', ')}`);
if (findings.length > 12)
	console.log(`    ... and ${findings.length - 12} more (see unused-traitprps-report.json)`);

fs.mkdirSync(OUT_DIR, { recursive: true });
const reportPath = path.join(OUT_DIR, 'unused-traitprps-report.json');
fs.writeFileSync(reportPath, JSON.stringify({
	generatedAt: new Date().toISOString(),
	mode: APPLY ? 'apply' : 'dry-run',
	stats: { callSites: findings.length, keys: totalKeys },
	findings
}, null, '\t'));

console.log(`\n  Report: ${reportPath}`);
if (!APPLY)
	console.log('  Dry-run only — pass --apply to strip the dead keys (values preserved in the report).\n');
