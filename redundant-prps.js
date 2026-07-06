#!/usr/bin/env node
/* eslint-disable no-console */

/*
	redundant-prps — REPORT ONLY.

	Finds prps explicitly set to the exact default the component type already has:
	  1. defaults come from the component's props.js (`dft` values — literals only;
	     function dfts are dynamic and skipped)
	  2. theme components.json propSpec dfts OVERRIDE props.js dfts (checked for
	     the app theme), and a themed default makes the props.js value non-redundant

	props.js files are located per the project layout (legoz/src/components,
	opus-ui, opus-ui-components, opus-ui-grid) and their object literal is
	extracted by brace matching and evaluated in isolation; files that reference
	imports inside the literal are skipped (counted in the summary).

	Report-only on purpose: a prp equal to the current default still pins the
	value if the default ever changes, and traits can be applied to nodes whose
	effective type differs. Review before removing.

	Usage:
	  node redundant-prps.js [--print]
*/

const fs = require('fs');
const path = require('path');
const { createScanner } = require('./lib/scan-core');
const { loadDoc, parseArgs } = require('./lib/json-doc');

const args = parseArgs();

if (args.help) {
	console.log(`
Usage: node redundant-prps.js [options]

Options:
  --print               Print every finding (default: first 20)
  --workspace=<dir>     Workspace root (default: two levels up from this script)
  --out=<dir>           Report output directory (default: this folder)
  --help                Show this help
`);
	process.exit(0);
}

const OUT_DIR = path.resolve(args.out || __dirname);

const scanner = createScanner({ workspace: args.workspace || path.join(__dirname, '..', '..') });
const { WORKSPACE, files } = scanner;

//---------------------------------------------------------------- load defaults
const PROPS_ROOTS = [
	path.join(WORKSPACE, 'legoz', 'src', 'components'),
	path.join(WORKSPACE, 'opus-ui', 'src', 'components'),
	path.join(WORKSPACE, 'opus-ui-components', 'src', 'components'),
	path.join(WORKSPACE, 'opus-ui-grid', 'src', 'components')
];

//Extract `const props = { ... }` via brace matching and evaluate the literal.
const extractPropsObject = source => {
	const m = source.match(/const\s+props\s*=\s*\{/);
	if (!m)
		return null;

	const start = source.indexOf('{', m.index);
	let depth = 0;
	let end = -1;
	let inStr = null;

	for (let i = start; i < source.length; i++) {
		const c = source[i];
		if (inStr) {
			if (c === '\\')
				i++;
			else if (c === inStr)
				inStr = null;
			continue;
		}
		if (c === '\'' || c === '"' || c === '`') {
			inStr = c;
			continue;
		}
		if (c === '{')
			depth++;
		else if (c === '}') {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}

	if (end === -1)
		return null;

	try {
		/* eslint-disable-next-line no-new-func */
		return new Function(`return (${source.slice(start, end + 1)});`)();
	} catch {
		return null; //references imports/identifiers — skip this component
	}
};

const isLiteral = v => v === null || ['string', 'number', 'boolean'].includes(typeof v) ||
	(typeof v === 'object' && (() => {
		try {
			JSON.stringify(v);
			return true;
		} catch {
			return false;
		}
	})());

//type -> Map(prp -> dft)
const defaults = new Map();
let componentsParsed = 0;
let componentsSkipped = 0;

for (const root of PROPS_ROOTS) {
	if (!fs.existsSync(root))
		continue;

	for (const d of fs.readdirSync(root, { withFileTypes: true })) {
		if (!d.isDirectory())
			continue;
		const propsPath = path.join(root, d.name, 'props.js');
		if (!fs.existsSync(propsPath))
			continue;

		const obj = extractPropsObject(fs.readFileSync(propsPath, 'utf-8'));
		if (!obj) {
			componentsSkipped++;
			continue;
		}

		componentsParsed++;
		const map = defaults.get(d.name) ?? new Map();
		for (const [prp, spec] of Object.entries(obj)) {
			if (spec && typeof spec === 'object' && 'dft' in spec && typeof spec.dft !== 'function' && isLiteral(spec.dft))
				map.set(prp, spec.dft);
		}
		if (map.size)
			defaults.set(d.name, map);
	}
}

//Theme propSpec overrides (app theme components.json): an overridden default
// replaces the props.js one for comparison purposes.
const themeComponents = loadDoc(path.join(WORKSPACE, 'legoz', 'app', 'theme', 'components.json'));
let themedOverrides = 0;

if (themeComponents && typeof themeComponents === 'object') {
	for (const [type, spec] of Object.entries(themeComponents)) {
		if (!spec || typeof spec !== 'object' || !spec.propSpec)
			continue;
		const map = defaults.get(type) ?? new Map();
		for (const [prp, ps] of Object.entries(spec.propSpec)) {
			if (ps && typeof ps === 'object' && 'dft' in ps && isLiteral(ps.dft)) {
				map.set(prp, ps.dft);
				themedOverrides++;
			}
		}
		if (map.size)
			defaults.set(type, map);
	}
}

//---------------------------------------------------------------- scan usage
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const findings = [];

for (const f of files.values()) {
	if (f.kind !== 'json' || f.ensemble === '(src)' || f.isTheme)
		continue;

	const doc = loadDoc(f.path);
	if (!doc)
		continue;

	const visit = node => {
		if (Array.isArray(node)) {
			node.forEach(visit);
			return;
		}
		if (node === null || typeof node !== 'object')
			return;

		if (typeof node.type === 'string' && node.prps && typeof node.prps === 'object' && defaults.has(node.type)) {
			const map = defaults.get(node.type);
			for (const [prp, v] of Object.entries(node.prps)) {
				//Accessors/wildcards are never redundant literals.
				if (typeof v === 'string' && /[{%$]/.test(v))
					continue;
				if (map.has(prp) && deepEqual(v, map.get(prp)))
					findings.push({ file: f.relPath, type: node.type, prp, value: v });
			}
		}

		Object.values(node).forEach(visit);
	};
	visit(doc);
}

//---------------------------------------------------------------- report
console.log('\n================ Redundant prps (REPORT ONLY) ================\n');
console.log(`  Component types with literal defaults: ${defaults.size} (${componentsParsed} props.js parsed, ${componentsSkipped} skipped, ${themedOverrides} theme overrides)`);
console.log(`  Prps set to the type's existing default: ${findings.length} in ${new Set(findings.map(x => x.file)).size} files\n`);

const cap = args.print ? Infinity : 20;
for (const x of findings.slice(0, cap))
	console.log(`    ${x.file}\n        ${x.type}.${x.prp} = ${JSON.stringify(x.value)} (already the default)`);
if (findings.length > cap)
	console.log(`    ... and ${findings.length - cap} more (--print for all)`);

console.log('\n  Report only — a prp equal to today\'s default still pins the value; review before removing.');

fs.mkdirSync(OUT_DIR, { recursive: true });
const reportPath = path.join(OUT_DIR, 'redundant-prps.json');
fs.writeFileSync(reportPath, JSON.stringify({
	generatedAt: new Date().toISOString(),
	stats: {
		componentTypes: defaults.size,
		propsFilesParsed: componentsParsed,
		propsFilesSkipped: componentsSkipped,
		findings: findings.length
	},
	findings
}, null, '\t'));

console.log(`\n  Report: ${reportPath}\n`);
