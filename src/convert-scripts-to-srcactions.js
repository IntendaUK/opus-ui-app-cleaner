#!/usr/bin/env node
/* eslint-disable no-console */

/*
	convert-scripts-to-srcactions

	Converts declarative scripts — scps entries, fireScript, dtaScps — into JS
	source actions: the script's `actions` array becomes
	"srcActions": "./actions/<name>", with the generated .js placed next to the
	JSON file. Triggers, ids and concurrency stay in JSON. See
	lib/script-codegen.js for the transpilation semantics; anything not natively
	translatable is delegated inline to the runtime engine via runScript, so
	converted scripts always behave exactly like the declarative originals.

	Requires the opus-ui interface additions (morph/resolveId/setVariable/ownerId
	on the srcAction handler args, and runScript returning a promise) — present in
	the workspace opus-ui; the app must run against it (vite.monorepo.config.js).

	DRY-RUN BY DEFAULT — pass --apply to modify files. Generated files are
	syntax-checked with node --check; original JSON is backed up to
	./convert-backup/ with a manifest.

	Usage:
	  node convert-scripts-to-srcactions.js                   # dry-run + report
	  node convert-scripts-to-srcactions.js --apply
	  node convert-scripts-to-srcactions.js --only=<relPath>  # limit to one file
*/

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createScanner } = require('./helpers/scan-core');
const { resolveAppDir } = require('./helpers/app-config');
const { generateScript, buildHelperModule } = require('./helpers/script-codegen');
const { loadDoc, saveDoc, parseArgs } = require('./helpers/json-doc');

//Run artifacts (reports, backups, trash) live at the tool root, above src/.
const TOOL_ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(TOOL_ROOT, 'output');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const args = parseArgs();

if (args.help) {
	console.log(`
Usage: node convert-scripts-to-srcactions.js [options]

Options:
  --apply               Actually modify files (default: dry-run report only)
  --only=<substr>       Only process JSON files whose path contains <substr>
  --minNative=<pct>     Skip scripts whose native ratio is below <pct> (0-100,
                        default 0 — convert everything, delegation included)
  --app=<dir>            App root (default: appPath from ../config.json)
  --out=<dir>           Report output directory (default: this folder)
  --help                Show this help
`);
	process.exit(0);
}

const APPLY = !!args.apply;
const ONLY = args.only ? String(args.only).replace(/\\/g, '/').toLowerCase() : null;
const MIN_NATIVE = Number(args.minNative ?? 0);
const OUT_DIR = path.resolve(args.out || OUTPUT_DIR);
const BACKUP = path.join(OUTPUT_DIR, 'convert-backup');

const scanner = createScanner({ appDir: resolveAppDir(args) });
const { files } = scanner;

//Total character size of all ensemble .json/.js sources — measured before and
// after conversion so the report shows the net saving.
const measureWorkspaceChars = () => {
	let chars = 0;
	const walk = dir => {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.'))
				continue;
			const p = path.join(dir, e.name);
			if (e.isDirectory())
				walk(p);
			else if (/\.(json|js)$/.test(e.name))
				chars += fs.statSync(p).size;
		}
	};
	scanner.ensembles.forEach(e => walk(e.root));
	return chars;
};

const charsBefore = measureWorkspaceChars();

//Trait path resolution for traitArray flattening ('@ens/x' or './x' vs a json file)
const resolveTraitRefForFlatten = (ref, hostAbsPath) => {
	if (typeof ref !== 'string')
		return null;
	if (ref.startsWith('@')) {
		const slash = ref.indexOf('/');
		const e = slash > 0 ? scanner.ensemblesByName.get(ref.slice(1, slash)) : null;
		return e ? path.resolve(e.root, ref.slice(slash + 1) + '.json').replace(/\\/g, '/') : null;
	}
	if (ref.startsWith('./')) {
		let p = ref.slice(2);
		let dir = path.dirname(hostAbsPath);
		while (p.startsWith('../')) {
			dir = path.dirname(dir);
			p = p.slice(3);
		}
		return path.resolve(dir, p + '.json').replace(/\\/g, '/');
	}
	return null;
};

//---------------------------------------------------------------- helpers
const converted = [];
const skipped = [];
let generatedFiles = 0;

const isConvertibleScript = script =>
	script && typeof script === 'object' && !Array.isArray(script) &&
	script.actions !== undefined &&
	!script.srcActions && !script.srcAction && !script.handler &&
	!script.suite && !script.blueprint && !script.traits;

//Reserve unique action file paths per JSON dir.
const reserved = new Set();
const reserveName = (dir, base) => {
	let name = base;
	let n = 1;
	while (reserved.has(path.join(dir, name + '.js').toLowerCase()))
		name = `${base}_${++n}`;
	reserved.add(path.join(dir, name + '.js').toLowerCase());
	return name;
};

const sanitize = s => String(s).replace(/[^\w-]/g, '_');

//---------------------------------------------------------------- scopedVariable producers
//Cross-script reads ({{x.scopedVariable.<scope>.<name>}}) look up <scope>-<name>
// in the engine store. Any script whose id matches a referenced <scope> must keep
// writing those variables to the store after conversion (locals are invisible to
// the engine) — the codegen emits setVariable() syncs for these names.
const scopedVarRefs = new Map(); //scope -> Set(varName)
for (const f of [...files.values()]) {
	if (f.kind !== 'json')
		continue;
	let text;
	try {
		text = fs.readFileSync(f.path, 'utf-8');
	} catch {
		continue;
	}
	for (const m of text.matchAll(/scopedVariable\.([\w$-]+)\.([\w$-]+)/g)) {
		if (!scopedVarRefs.has(m[1]))
			scopedVarRefs.set(m[1], new Set());
		scopedVarRefs.get(m[1]).add(m[2]);
	}
}

//---------------------------------------------------------------- point fixes
/*
	App-specific, PATH-BOUND patches applied to a script's declarative actions
	BEFORE codegen. These are not general conversion rules: they harden known
	fragile scripts in THIS app whose latent bugs the conversion's timing shifts
	exposed. Another app converted with this tool simply won't match the paths.
*/
const POINT_FIXES = [
	{
		/*
			formInput down-sync (formInput.value -> inner input) forms a two-writer
			loop with the inner input's up-sync when dispatch order de-phases their
			state reads (seeded by regex-validation writes on blur/refocus — the
			"organisation code erases/retypes the last character" bug). Skip the
			down-sync while the inner input has focus: the user's typing is the
			source of truth then; programmatic updates (record loads) still sync
			down because they happen unfocused.
		*/
		file: 'l2_inputs/formInput/functional/onValueSet.json',
		kind: 'scps',
		note: 'formInput down-sync focus guard (two-writer oscillation)',
		apply: actions => [
			{
				type: 'stopScript',
				'^condition': {
					operator: 'isTruthy',
					value: '{{state.||formInput.input||.hasFocus}}'
				}
			},
			...actions
		]
	}
];

//---------------------------------------------------------------- conversion
const pendingWrites = []; //{ absPath, code }

const convertScript = (script, kind, file, fallbackBase) => {
	if (!isConvertibleScript(script))
		return false;

	let actions = Array.isArray(script.actions) ? script.actions : [script.actions];
	if (!actions.length)
		return false;

	//Footprint of the declarative form (tab-indented JSON lines) — reported
	// against the generated JS line count in the summary.
	const declarativeLines = JSON.stringify(actions, null, '\t').split('\n').length;

	//Path-bound point fixes (see POINT_FIXES above).
	const pointFix = POINT_FIXES.find(p =>
		p.kind === kind && file.relPath.replace(/\\/g, '/').toLowerCase() === p.file.toLowerCase());
	if (pointFix)
		actions = pointFix.apply(actions);

	//Trait-prp wildcards (%x%/$x$) convert via __traitParams: the codegen
	// extracts each span verbatim into the emitted action config, where the
	// trait engine keeps substituting it per application, and the JS reads
	// config.__traitParams.<name>. Unsupported shapes (wildcard object keys,
	// $...x$ spreads, wildcards inside accessor grammar) fail closed in the
	// codegen and the script stays declarative.
	const raw = JSON.stringify(actions);

	//Repeater rowMda placeholders (((rowData.x)) etc.) are supported via
	// __rowParams (the codegen extracts each span into the action config, where
	// the repeater keeps substituting it per row). Only the NESTED-repeater
	// scoped form ((someScope.rowData.x)) is unsupported — its scope name can't
	// be resolved statically, so those scripts stay declarative.
	if (/(\(\(|\{\{)(?!variable\.|scopedVariable\.|state\.|eval[.\s-]|fn\.)[\w$-]+\.(?:rowData|rowNumber|rowDataConcat|rowPrps|parentId)[.)}]/.test(raw)) {
		skipped.push({ file: file.relPath, kind, scriptId: script.id ?? null, reason: 'uses nested-repeater scoped row placeholders (((scope.rowData…)) — scope not statically resolvable)' });
		return false;
	}

	//Nested srcAction entries cannot be delegated: the packager rewrites srcAction
	// strings to {path} objects only inside JSON files, so raw copies inside a
	// generated .js would never hydrate. These scripts stay declarative.
	if (raw.includes('"srcAction"') || raw.includes('"srcActions"')) {
		skipped.push({ file: file.relPath, kind, scriptId: script.id ?? null, reason: 'contains nested srcAction entries (packager rewrites those in JSON only)' });
		return false;
	}

	const scriptId = script.id;
	//Resolves trait refs for traitArray flattening — relative to THIS json file.
	const traitResolver = ref => {
		const abs = resolveTraitRefForFlatten(ref, file.path);
		return abs && fs.existsSync(abs) ? abs : null;
	};

	const res = generateScript({
		scriptId,
		actions,
		traitResolver,
		ensembles: scanner.ensembles,
		syncVars: scriptId ? scopedVarRefs.get(scriptId) : undefined
	});

	if (res.skip) {
		skipped.push({ file: file.relPath, kind, scriptId, reason: res.skip });
		return false;
	}

	const total = res.stats.native + res.stats.delegated;
	const nativePct = total ? Math.round(res.stats.native / total * 100) : 100;
	if (nativePct < MIN_NATIVE) {
		skipped.push({ file: file.relPath, kind, scriptId, reason: `native ratio ${nativePct}% below --minNative` });
		return false;
	}

	const dir = path.join(path.dirname(file.path), 'actions');
	const base = sanitize(scriptId ?? fallbackBase);
	const name = reserveName(dir, base);

	pendingWrites.push({ absPath: path.join(dir, name + '.js'), code: res.code });
	generatedFiles++;

	delete script.actions;
	if (res.rowParams || res.traitParams) {
		//Substituted placeholders must STAY in the JSON (the repeater's per-row
		// clone / the trait engine's per-application pass rewrite them), so the
		// script becomes an action-level srcAction whose __rowParams/__traitParams
		// config carries the verbatim spans — the generated JS reads the
		// substituted values from config at run time.
		const entry = { srcAction: `./actions/${name}` };
		if (res.rowParams)
			entry.__rowParams = res.rowParams;
		if (res.traitParams)
			entry.__traitParams = res.traitParams;
		script.actions = [entry];
	} else
		script.srcActions = `./actions/${name}`;

	converted.push({
		file: file.relPath,
		kind,
		scriptId: scriptId ?? null,
		js: `actions/${name}.js`,
		native: res.stats.native,
		delegated: res.stats.delegated,
		morphFallbacks: res.stats.morphFallbacks,
		rowParams: res.rowParams ? Object.keys(res.rowParams).length : undefined,
		traitParams: res.traitParams ? Object.keys(res.traitParams).length : undefined,
		pointFix: pointFix?.note,
		linesBefore: declarativeLines,
		linesAfter: res.code.split('\n').length
	});

	return true;
};

for (const f of [...files.values()]) {
	if (f.kind !== 'json' || f.ensemble === '(src)' || f.isTheme)
		continue;
	if (ONLY && !f.relPath.toLowerCase().includes(ONLY))
		continue;

	const doc = loadDoc(f.path);
	if (!doc)
		continue;

	let changed = false;
	const jsonBase = sanitize(path.basename(f.relPath, '.json'));

	const visit = node => {
		if (Array.isArray(node)) {
			node.forEach(visit);
			return;
		}
		if (node === null || typeof node !== 'object')
			return;

		if (node.prps && typeof node.prps === 'object') {
			const { prps } = node;

			if (Array.isArray(prps.scps)) {
				prps.scps.forEach((s, i) => {
					if (convertScript(s, 'scps', f, `${jsonBase}_scp${i}`))
						changed = true;
				});
			}

			if (prps.fireScript && convertScript(prps.fireScript, 'fireScript', f, `${jsonBase}_fireScript`))
				changed = true;

			if (prps.dtaScps) {
				const list = Array.isArray(prps.dtaScps) ? prps.dtaScps : [prps.dtaScps];
				list.forEach((s, i) => {
					if (convertScript(s, 'dtaScps', f, `${jsonBase}_dtaScp${i}`))
						changed = true;
				});
			}
		}

		Object.values(node).forEach(visit);
	};
	visit(doc);

	if (changed && APPLY) {
		const backupPath = path.join(BACKUP, f.relPath);
		fs.mkdirSync(path.dirname(backupPath), { recursive: true });
		if (!fs.existsSync(backupPath))
			fs.copyFileSync(f.path, backupPath);
		saveDoc(f.path, doc);
	}
}

//---------------------------------------------------------------- write + check JS
let syntaxErrors = 0;

if (APPLY) {
	//Generated code imports '@l2_util/scriptHelpers/net' — the helper is an ASSET
	// of this tool (assets/scriptHelpers-net.js) and is (re)deposited on every
	// apply when missing or stale, so git clean / resets can never leave the
	// imports dangling (earlier conversions may already reference it even when
	// this run converts nothing new).
	{
		//Generated network calls import '@l2_util/scriptHelpers/net' — resolve the
		// destination through the ensemble registry (roots can live anywhere).
		const utilEnsemble = scanner.ensemblesByName.get('l2_util');
		if (utilEnsemble) {
			const helperSrc = path.join(__dirname, 'assets', 'scriptHelpers-net.js');
			const helperDest = path.join(utilEnsemble.root, 'scriptHelpers', 'net.js');
			const srcContent = fs.readFileSync(helperSrc, 'utf-8');
			const current = fs.existsSync(helperDest) ? fs.readFileSync(helperDest, 'utf-8') : null;
			if (current !== srcContent) {
				fs.mkdirSync(path.dirname(helperDest), { recursive: true });
				fs.writeFileSync(helperDest, srcContent);
				console.log('Deposited network helper: l2_util/scriptHelpers/net.js');
			}

			//Generated actions import their runtime helpers (__isFalsy, __deep,
			// __tryEval, …) from a shared module instead of inlining a copy in every
			// file. Deposited from HELPERS (buildHelperModule) so it can't drift and
			// survives git clean / resets between runs.
			const codegenDest = path.join(utilEnsemble.root, 'scriptHelpers', 'codegen.js');
			const codegenContent = buildHelperModule();
			const currentCodegen = fs.existsSync(codegenDest) ? fs.readFileSync(codegenDest, 'utf-8') : null;
			if (currentCodegen !== codegenContent) {
				fs.mkdirSync(path.dirname(codegenDest), { recursive: true });
				fs.writeFileSync(codegenDest, codegenContent);
				console.log('Deposited codegen helpers: l2_util/scriptHelpers/codegen.js');
			}
		} else
			console.warn('No l2_util ensemble registered — network-action scripts import @l2_util/scriptHelpers/net and need one.');
	}

	for (const w of pendingWrites) {
		fs.mkdirSync(path.dirname(w.absPath), { recursive: true });
		fs.writeFileSync(w.absPath, w.code);
	}

	//node --check requires CommonJS or .mjs for ESM — the generated files use
	// `export default`, so check them as .mjs via a temp copy per batch.
	for (const w of pendingWrites) {
		const tmp = w.absPath + '.check.mjs';
		fs.writeFileSync(tmp, w.code);
		const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf-8' });
		fs.unlinkSync(tmp);
		if (r.status !== 0) {
			syntaxErrors++;
			console.error(`SYNTAX ERROR in generated ${path.relative(process.cwd(), w.absPath)}:\n${r.stderr}`);
		}
	}
} else {
	//Dry-run still syntax-checks everything (in a scratch dir).
	const scratch = path.join(OUT_DIR, '.convert-check');
	fs.mkdirSync(scratch, { recursive: true });
	pendingWrites.forEach((w, i) => {
		const tmp = path.join(scratch, `c${i}.mjs`);
		fs.writeFileSync(tmp, w.code);
		const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf-8' });
		if (r.status !== 0) {
			syntaxErrors++;
			console.error(`SYNTAX ERROR in generated code for ${converted[i]?.file}:\n${r.stderr}`);
		}
	});
	fs.rmSync(scratch, { recursive: true, force: true });
}

//---------------------------------------------------------------- report
const totNative = converted.reduce((n, c) => n + c.native, 0);
const totDelegated = converted.reduce((n, c) => n + c.delegated, 0);
const totMorph = converted.reduce((n, c) => n + c.morphFallbacks, 0);

console.log(`\n================ Script conversion (${APPLY ? 'APPLIED' : 'DRY-RUN'}) ================\n`);
console.log(`  Scripts converted: ${converted.length} (${generatedFiles} JS files)`);
console.log(`  Actions: ${totNative} native, ${totDelegated} delegated to runScript (${totNative + totDelegated ? Math.round(totNative / (totNative + totDelegated) * 100) : 0}% native)`);
console.log(`  morph() fallback expressions: ${totMorph}`);
const totLinesBefore = converted.reduce((n, c) => n + (c.linesBefore ?? 0), 0);
const totLinesAfter = converted.reduce((n, c) => n + (c.linesAfter ?? 0), 0);
console.log(`  Script lines: ${totLinesBefore.toLocaleString('en-US')} declarative before, ${totLinesAfter.toLocaleString('en-US')} generated JS after`);
console.log(`  Skipped scripts: ${skipped.length}`);
console.log(`  Generated-JS syntax errors: ${syntaxErrors}${syntaxErrors ? '  <-- MUST BE FIXED' : ''}`);

const charsAfter = measureWorkspaceChars();
const charsSaved = charsBefore - charsAfter;
const savedPct = charsBefore ? (charsSaved / charsBefore * 100).toFixed(1) : '0.0';
console.log(`  Workspace size (ensemble .json+.js): ${charsBefore.toLocaleString('en-US')} chars before, ${charsAfter.toLocaleString('en-US')} after (${charsSaved >= 0 ? 'saved' : 'grew'} ${Math.abs(charsSaved).toLocaleString('en-US')} = ${savedPct}%)`);

const byKind = {};
converted.forEach(c => byKind[c.kind] = (byKind[c.kind] ?? 0) + 1);
Object.entries(byKind).forEach(([k, n]) => console.log(`    ${k}: ${n}`));

fs.mkdirSync(OUT_DIR, { recursive: true });
const reportPath = path.join(OUT_DIR, 'convert-report.json');
fs.writeFileSync(reportPath, JSON.stringify({
	generatedAt: new Date().toISOString(),
	mode: APPLY ? 'apply' : 'dry-run',
	stats: {
		scripts: converted.length,
		nativeActions: totNative,
		delegatedActions: totDelegated,
		morphFallbacks: totMorph,
		skipped: skipped.length,
		syntaxErrors,
		scriptLines: {
			before: totLinesBefore,
			after: totLinesAfter
		},
		workspaceChars: {
			before: charsBefore,
			after: charsAfter,
			saved: charsSaved
		}
	},
	converted,
	skipped
}, null, '\t'));

console.log(`\n  Report: ${reportPath}`);
if (!APPLY)
	console.log('  Dry-run only — pass --apply to convert.\n');

process.exit(syntaxErrors ? 1 : 0);
