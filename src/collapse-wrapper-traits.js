#!/usr/bin/env node
/* eslint-disable no-console */

/*
	collapse-wrapper-traits

	Finds pure passthrough traits — files whose entire content is:

	  { "acceptPrps": {}, "traits": ["<one static path>"] }

	(the single entry may also be { "trait": "<path>" } with no traitPrps/
	condition/auth) — and repoints every reference straight at the inner trait,
	then removes the wrapper. Multi-level wrappers collapse over multiple rounds.

	Caller entries that passed traitPrps to a wrapper had them silently dropped at
	runtime (an empty acceptPrps consumes nothing and prps don't cascade), so the
	repointed entry gets its traitPrps REMOVED — behavior-identical, and reported.

	Wrappers referenced by the menu dataset, from JS/JSX, or dynamically are kept.

	DRY-RUN BY DEFAULT — pass --apply to modify files.
*/

const fs = require('fs');
const path = require('path');
const { createScanner } = require('./helpers/scan-core');
const { resolveAppDir } = require('./helpers/app-config');
const { computeTraitRefs, defaultEntrypointsPath } = require('./helpers/trait-refs');
const { loadDoc, saveDoc, parseArgs } = require('./helpers/json-doc');

//Run artifacts (reports, backups, trash) live at the tool root, above src/.
const TOOL_ROOT = path.join(__dirname, '..');

const args = parseArgs();

if (args.help) {
	console.log(`
Usage: node collapse-wrapper-traits.js [options]

Options:
  --apply               Actually modify files (default: dry-run report only)
  --app=<dir>            App root (default: appPath from ../config.json)
  --entrypoints=<file>  Menu dataset (default: entrypoints.txt / sample)
  --out=<dir>           Report output directory (default: this folder)
  --help                Show this help
`);
	process.exit(0);
}

const APPLY = !!args.apply;
const OUT_DIR = path.resolve(args.out || TOOL_ROOT);
const BACKUP = path.join(TOOL_ROOT, 'collapse-backup');

const norm = p => path.resolve(p).replace(/\\/g, '/');

const allCollapsed = [];
const allSkipped = [];
const prpsDropped = [];
let round = 0;

for (round = 1; round <= 10; round++) {
	const scanner = createScanner({ appDir: resolveAppDir(args) });
	const { files, key, ensembles, ensemblesByName } = scanner;

	const epPath = args.entrypoints ? path.resolve(args.entrypoints) : defaultEntrypointsPath(TOOL_ROOT);
	const { traitFiles, refsTo } = computeTraitRefs(scanner, { entrypointsPath: epPath, field: args.field });

	//---- identify wrappers
	const wrappers = [];

	for (const [k, f] of traitFiles) {
		if (f.isTheme)
			continue;

		const doc = loadDoc(f.path);
		if (!doc || typeof doc !== 'object' || Array.isArray(doc))
			continue;

		const keys = Object.keys(doc).sort();
		if (keys.join(',') !== 'acceptPrps,traits')
			continue;
		if (!doc.acceptPrps || typeof doc.acceptPrps !== 'object' || Object.keys(doc.acceptPrps).length !== 0)
			continue;
		if (!Array.isArray(doc.traits) || doc.traits.length !== 1)
			continue;

		const entry = doc.traits[0];
		let inner = null;
		if (typeof entry === 'string')
			inner = entry;
		else if (entry && typeof entry === 'object' && typeof entry.trait === 'string') {
			const extra = Object.keys(entry).filter(x => x !== 'trait');
			if (extra.length)
				continue; //traitPrps/condition/auth on the inner entry — not a pure passthrough
			inner = entry.trait;
		} else
			continue;

		if (inner.includes('%') || inner.includes('$') || inner.includes('{'))
			continue;

		//Resolve the inner path to absolute form.
		let innerAbs = null;
		if (inner.startsWith('@')) {
			const slash = inner.indexOf('/');
			const e = slash > 0 ? ensemblesByName.get(inner.slice(1, slash)) : null;
			if (e)
				innerAbs = norm(path.join(e.root, inner.slice(slash + 1) + '.json'));
		} else if (inner.startsWith('./')) {
			let p = inner.slice(2);
			let dir = path.dirname(f.path);
			while (p.startsWith('../')) {
				dir = path.dirname(dir);
				p = p.slice(3);
			}
			innerAbs = norm(path.join(dir, p + '.json'));
		}

		if (!innerAbs || !fs.existsSync(innerAbs))
			continue;

		const eInner = ensembles.find(x => innerAbs.startsWith(x.root + '/'));
		if (!eInner)
			continue;

		const innerRef = `@${eInner.name}/${innerAbs.slice(eInner.root.length + 1).replace(/\.json$/, '')}`;

		//Self-referential guard (shouldn't happen, but never loop).
		if (key(innerAbs) === k)
			continue;

		wrappers.push({ file: f, innerRef });
	}

	//---- repoint callers
	const docs = new Map();
	const roundCollapsed = [];

	for (const w of wrappers) {
		const refs = refsTo.get(key(w.file.path)) ?? [];

		const blockers = refs.filter(r =>
			r.referrer === '(menu dataset)' ||
			r.via.endsWith('(dynamic)') ||
			!r.referrerPath ||
			files.get(key(r.referrerPath))?.kind !== 'json');

		if (blockers.length) {
			if (round === 1) {
				allSkipped.push({
					wrapper: w.file.relPath,
					reason: blockers[0].referrer === '(menu dataset)'
						? 'referenced by the menu dataset'
						: (blockers[0].via.endsWith('(dynamic)') ? 'referenced dynamically' : 'referenced from JS/JSX')
				});
			}
			continue;
		}

		let ok = true;
		const edits = [];

		for (const r of refs) {
			const hk = key(r.referrerPath);
			if (!docs.has(hk))
				docs.set(hk, loadDoc(r.referrerPath));
			const doc = docs.get(hk);
			if (!doc) {
				ok = false;
				break;
			}

			//Rewrite traits entries: bare string -> innerRef; {trait: via, ...} ->
			// trait=innerRef and traitPrps dropped (they were inert on the wrapper).
			const visit = node => {
				if (Array.isArray(node)) {
					node.forEach(visit);
					return;
				}
				if (node === null || typeof node !== 'object')
					return;

				if (Array.isArray(node.traits)) {
					node.traits.forEach((t, i) => {
						if (t === r.via) {
							node.traits[i] = w.innerRef;
							edits.push({ file: r.referrer, kind: 'string' });
						} else if (t && typeof t === 'object' && t.trait === r.via) {
							t.trait = w.innerRef;
							if (t.traitPrps !== undefined) {
								prpsDropped.push({ file: r.referrer, wrapper: w.file.relPath, traitPrps: t.traitPrps });
								delete t.traitPrps;
							}
							edits.push({ file: r.referrer, kind: 'object' });
						}
					});
				}

				Object.values(node).forEach(visit);
			};
			visit(doc);
		}

		//The ref may not be a traits-array usage (viewport value etc.) — leave those.
		if (!ok || edits.length === 0) {
			if (round === 1 && ok)
				allSkipped.push({ wrapper: w.file.relPath, reason: 'reference is not a traits-array entry' });
			continue;
		}

		roundCollapsed.push({ wrapper: w.file, innerRef: w.innerRef, editCount: edits.length });
	}

	console.log(`Round ${round}: ${roundCollapsed.length} wrapper(s) collapsible${APPLY ? '' : ' (dry-run)'}`);
	allCollapsed.push(...roundCollapsed.map(c => ({ wrapper: c.wrapper.relPath, repointedTo: c.innerRef, edits: c.editCount })));

	if (!APPLY || roundCollapsed.length === 0)
		break;

	for (const [hk, doc] of docs) {
		if (doc)
			saveDoc(files.get(hk).path, doc);
	}

	for (const c of roundCollapsed) {
		const dest = path.join(BACKUP, c.wrapper.relPath);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.renameSync(c.wrapper.path, dest);
	}
}

//---------------------------------------------------------------- report
console.log(`\n================ Wrapper traits (${APPLY ? 'APPLIED' : 'DRY-RUN'}) ================\n`);
console.log(`  Collapsed: ${allCollapsed.length} wrapper(s) over ${round} round(s)`);
console.log(`  Kept:      ${allSkipped.length} (menu/JS/dynamic/non-traits refs)`);
if (prpsDropped.length)
	console.log(`  Inert traitPrps dropped from callers: ${prpsDropped.length} (were silently ignored at runtime)`);

for (const c of allCollapsed.slice(0, 10))
	console.log(`    ${c.wrapper}  ->  ${c.repointedTo}`);
if (allCollapsed.length > 10)
	console.log(`    ... and ${allCollapsed.length - 10} more (see collapse-report.json)`);

fs.mkdirSync(OUT_DIR, { recursive: true });
const reportPath = path.join(OUT_DIR, 'collapse-report.json');
fs.writeFileSync(reportPath, JSON.stringify({
	generatedAt: new Date().toISOString(),
	mode: APPLY ? 'apply' : 'dry-run',
	collapsed: allCollapsed,
	skipped: allSkipped,
	inertTraitPrpsDropped: prpsDropped
}, null, '\t'));

console.log(`\n  Report: ${reportPath}`);
if (!APPLY)
	console.log('  Dry-run only — pass --apply to collapse (dry-run shows round 1 only).\n');
