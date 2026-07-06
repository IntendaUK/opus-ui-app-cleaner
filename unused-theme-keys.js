#!/usr/bin/env node
/* eslint-disable no-console */

/*
	unused-theme-keys — REPORT ONLY.

	Collects every top-level key of every theme file (legoz/app/theme/* and each
	ensemble's theme/*) and diffs against `theme.<file>.<key>` accessor usage
	found anywhere in the workspace (JSON, JS, JSX — any occurrence of the text
	"theme.<file>.<key>" counts, which covers {theme.x.y}, {{...theme.x.y}} and
	propSpec dfts). Theme files can also reference each other; those count too.

	Deliberately report-only: theme accessors can be composed dynamically
	("{theme.colors.%name%}" or string concatenation in JS), so every entry here
	needs a human eye before deletion. Keys whose file defines a matching
	"<key>/..." family (e.g. "iconText/textHoverOn") are matched on the full key.

	Usage:
	  node unused-theme-keys.js [--print]
*/

const fs = require('fs');
const path = require('path');
const { createScanner } = require('./lib/scan-core');
const { loadDoc, parseArgs } = require('./lib/json-doc');

const args = parseArgs();

if (args.help) {
	console.log(`
Usage: node unused-theme-keys.js [options]

Options:
  --print               Print every unused key (default: first 15 per theme file)
  --workspace=<dir>     Workspace root (default: two levels up from this script)
  --out=<dir>           Report output directory (default: this folder)
  --help                Show this help
`);
	process.exit(0);
}

const OUT_DIR = path.resolve(args.out || __dirname);

const scanner = createScanner({ workspace: args.workspace || path.join(__dirname, '..', '..') });
const { files, registerSrcFiles } = scanner;

registerSrcFiles();

const META_KEYS = new Set(['themeConfig', 'ensembleLocation']);

//---------------------------------------------------------------- collect keys
//themeName -> Map(key -> definingFile)
const themeKeys = new Map();

for (const f of files.values()) {
	if (f.kind !== 'json' || !/(^|\/)theme\/[^/]+\.json$/.test(f.relPath))
		continue;

	const themeName = path.basename(f.relPath, '.json');
	const doc = loadDoc(f.path);
	if (!doc || typeof doc !== 'object' || Array.isArray(doc))
		continue;

	if (!themeKeys.has(themeName))
		themeKeys.set(themeName, new Map());

	const keys = themeKeys.get(themeName);
	for (const k of Object.keys(doc)) {
		if (!META_KEYS.has(k) && !keys.has(k))
			keys.set(k, f.relPath);
	}
}

//---------------------------------------------------------------- collect usage
//Any "theme.<name>.<key...>" text anywhere. Key part may contain / and . (deep
// access) — record the full tail so both "users" and "users.get.act" mark "users".
const usage = new Map(); //themeName -> Set(rootKeysUsed)
const usedWholeFile = new Set(); //theme names referenced without a key (rare)

const noteUsage = (name, tail) => {
	if (!usage.has(name))
		usage.set(name, new Set());
	usage.get(name).add(tail);
};

for (const f of files.values()) {
	let text;
	try {
		text = fs.readFileSync(f.path, 'utf-8');
	} catch {
		continue;
	}

	for (const m of text.matchAll(/theme\.([\w-]+)\.([\w\/.%-]+)/g)) {
		noteUsage(m[1], m[2]);
	}
	for (const m of text.matchAll(/theme\.([\w-]+)[^\w.]/g))
		usedWholeFile.add(m[1]);
}

//A theme key counts as used when any recorded usage tail equals it, starts with
// "<key>." (deep access) or "<key>/" — or when a dynamic tail (%...%) makes the
// whole file uncertain.
const isUsed = (themeName, k) => {
	const tails = usage.get(themeName);
	if (!tails)
		return false;

	for (const t of tails) {
		if (t === k || t.startsWith(k + '.') || t.startsWith(k + '/'))
			return true;
		if (t.includes('%'))
			return true; //dynamic accessor into this theme — treat everything as used
	}

	return false;
};

//---------------------------------------------------------------- report
const unusedByTheme = [];
let totalKeys = 0;
let totalUnused = 0;

for (const [themeName, keys] of [...themeKeys.entries()].sort()) {
	totalKeys += keys.size;
	const unused = [...keys.entries()]
		.filter(([k]) => !isUsed(themeName, k))
		.map(([k, definedIn]) => ({ key: k, definedIn }));

	totalUnused += unused.length;
	if (unused.length)
		unusedByTheme.push({ theme: themeName, total: keys.size, unused });
}

const cap = args.print ? Infinity : 15;

console.log('\n================ Unused theme keys (REPORT ONLY) ================\n');
for (const t of unusedByTheme) {
	console.log(`  theme.${t.theme}  (${t.unused.length} of ${t.total} keys unused)`);
	for (const u of t.unused.slice(0, cap))
		console.log(`      ${u.key}   (${u.definedIn})`);
	if (t.unused.length > cap)
		console.log(`      ... and ${t.unused.length - cap} more (--print for all)`);
	console.log('');
}

console.log(`  TOTAL: ${totalUnused} of ${totalKeys} theme keys have no visible accessor usage`);
console.log('  Report only — theme accessors can be built dynamically; review before deleting.');

fs.mkdirSync(OUT_DIR, { recursive: true });
const reportPath = path.join(OUT_DIR, 'unused-theme-keys.json');
fs.writeFileSync(reportPath, JSON.stringify({
	generatedAt: new Date().toISOString(),
	stats: { themeFiles: themeKeys.size, totalKeys, unusedKeys: totalUnused },
	unusedByTheme
}, null, '\t'));

console.log(`\n  Report: ${reportPath}\n`);
