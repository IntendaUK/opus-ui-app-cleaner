/* eslint-disable no-console */

/*
	scan-core

	Shared engine for the opus-ui-app-cleaner tools: workspace/ensemble discovery, file
	inventory, and Opus UI reference resolution. Reference forms handled:

	  - "@<ensemble>/path"  -> <ensembleRoot>/path.(json|js|jsx)
	  - "./path" / "./../path" -> relative to the containing file (packager semantics),
	    with a path-suffix fallback within the same ensemble (relative viewport values
	    in functional/*.json resolve against the MOUNTING viewport's path at runtime,
	    which is unknowable statically)
	  - dynamic segments ("%data.x%", "{state.y}") -> wildcards; all possible matches
	  - bare "some/path" -> legoz/app/dashboard/some/path.json (only when it exists)
	  - ">file" / ">>folder" and "{ensembleLocation}" theme asset references
	  - string literals inside .js/.jsx files (srcAction bundles reference traits
	    like '@l2_tab_manager/tab' at runtime)

	Query strings are stripped ("@.../index?prc_idn=101" -> "@.../index"), mirroring
	tOpenTab.js (loc_nme.split('?')[0]).
*/

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'public', 'packaged']);
const SKIP_FILES = new Set(['package.json', 'package-lock.json', 'serve.json']);

const ENSEMBLE_REF = /^@([\w-]+)\/[^\s'"`<>|]+$/;
const RELATIVE_REF = /^\.\/[^\s'"`<>|]+$/;
const BARE_REF = /^[\w-]+(\/[\w. -]+)+$/;

/*
	Pull string literals out of JS/JSX source with a small tokenizer (a regex cannot
	do this: a template literal containing ${...} would make it treat the span from
	one template's closing backtick to the next one's opening backtick as a string,
	swallowing every real literal in between — which is how trait refs in files like
	dataPedigreePopups/helpers.jsx went missing).

	Handles // and /* comments, '...' and "..." strings, and template literals.
	A template with interpolations is emitted as one joined string with each ${...}
	replaced by %tpl% — e.g. `@l2_buttons/visual/${type}/index` becomes
	"@l2_buttons/visual/%tpl%/index", which the dynamic-wildcard resolution matches
	against every possible file. String literals inside interpolations are emitted
	too. Regex literals are not tracked (same exposure as before: a regex containing
	a quote can hide literals on that line — rare and line-scoped).
*/
const extractJsStrings = src => {
	const out = [];
	const n = src.length;
	let i = 0;

	const readQuoted = (from, quote) => {
		//Returns [value, indexAfterClosingQuote] or null when unterminated on the line.
		let buf = '';
		let j = from;

		while (j < n) {
			const d = src[j];
			if (d === '\\') {
				buf += src[j + 1] ?? '';
				j += 2;
				continue;
			}
			if (d === '\n')
				return null;
			if (d === quote)
				return [buf, j + 1];

			buf += d;
			j++;
		}

		return null;
	};

	while (i < n) {
		const c = src[i];

		if (c === '/' && src[i + 1] === '/') {
			const e = src.indexOf('\n', i);
			i = e === -1 ? n : e + 1;
			continue;
		}

		if (c === '/' && src[i + 1] === '*') {
			const e = src.indexOf('*/', i + 2);
			i = e === -1 ? n : e + 2;
			continue;
		}

		if (c === '\'' || c === '"') {
			const read = readQuoted(i + 1, c);
			if (!read) {
				//Unterminated on this line (apostrophe in a regex/word) — skip the char.
				i++;
				continue;
			}

			out.push(read[0]);
			i = read[1];
			continue;
		}

		if (c === '`') {
			let buf = '';
			let j = i + 1;

			while (j < n) {
				const d = src[j];

				if (d === '\\') {
					buf += src[j + 1] ?? '';
					j += 2;
					continue;
				}

				if (d === '`') {
					j++;
					break;
				}

				if (d === '$' && src[j + 1] === '{') {
					buf += '%tpl%';
					let depth = 1;
					j += 2;

					//Skip the interpolation; extract strings found inside it.
					while (j < n && depth > 0) {
						const e = src[j];

						if (e === '{')
							depth++;
						else if (e === '}')
							depth--;
						else if (e === '\'' || e === '"') {
							const read = readQuoted(j + 1, e);
							if (read) {
								out.push(read[0]);
								j = read[1];
								continue;
							}
						} else if (e === '`') {
							//Nested template: skip to its closing backtick (no deep nesting).
							j++;
							while (j < n && src[j] !== '`') {
								if (src[j] === '\\')
									j++;
								j++;
							}
						}

						j++;
					}
					continue;
				}

				buf += d;
				j++;
			}

			out.push(buf);
			i = j;
			continue;
		}

		i++;
	}

	return out;
};

const { readEnsembles } = require('./app-config');

const createScanner = ({ appDir, workspace }) => {
	//Legacy --workspace support: the app was assumed at <workspace>/legoz.
	const APP = path.resolve(appDir ?? path.join(workspace, 'legoz'));
	const APP_BASE = path.basename(APP);
	const APP_DIR = path.join(APP, 'app');
	const SRC_DIR = path.join(APP, 'src');

	const norm = p => path.resolve(p).replace(/\\/g, '/');
	const key = p => norm(p).toLowerCase();

	if (!fs.existsSync(APP_DIR)) {
		console.error(`App dir not found: ${APP_DIR} — check config.json's appPath (or pass --app=<app root>)`);
		process.exit(1);
	}

	//Ensemble registry from the app's package.json + external opusUiConfig
	// (packager precedence) — roots can live anywhere on disk.
	const ensembles = readEnsembles(APP);
	const ensemblesByName = new Map(ensembles.map(e => [e.name, e]));

	//Rel paths are "<ensembleName>/inner" (or "<appBasename>/inner" for app
	// files) — stable identifiers regardless of where roots physically live.
	//Inverse of rel(): '<ensembleName>/inner' (or '<appBasename>/inner') -> abs.
	const absFromRel = relPath => {
		const clean = String(relPath).replace(/\\/g, '/');
		const idx = clean.indexOf('/');
		const head = idx === -1 ? clean : clean.slice(0, idx);
		const rest = idx === -1 ? '' : clean.slice(idx + 1);
		const e = ensemblesByName.get(head);
		const root = e ? e.root : (head === APP_BASE ? norm(APP) : null);
		if (!root)
			return null;
		return rest ? path.join(root, rest) : root;
	};

	const rel = p => {
		const n = norm(p);
		for (const e of ensembles) {
			if (n === e.root)
				return e.name;
			if (n.startsWith(e.root + '/'))
				return `${e.name}/${n.slice(e.root.length + 1)}`;
		}
		const appRoot = norm(APP);
		if (n.startsWith(appRoot + '/'))
			return `${APP_BASE}/${n.slice(appRoot.length + 1)}`;
		return n;
	};

	//---------------------------------------------------------------- inventory
	const walkFiles = (dir, exts, acc = []) => {
		let dirents;
		try {
			dirents = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return acc;
		}

		for (const d of dirents) {
			const full = path.join(dir, d.name);
			if (d.isDirectory()) {
				if (!SKIP_DIRS.has(d.name))
					walkFiles(full, exts, acc);
			} else if (exts.includes(path.extname(d.name)) && !SKIP_FILES.has(d.name))
				acc.push(norm(full));
		}

		return acc;
	};

	//files: key(path) -> { path, relPath, ensemble, kind: 'json'|'js', isTheme }
	const files = new Map();

	const registerFile = (p, ensembleName) => {
		const ext = path.extname(p);
		const r = rel(p);
		files.set(key(p), {
			path: norm(p),
			relPath: r,
			ensemble: ensembleName,
			kind: ext === '.json' ? 'json' : 'js',
			isTheme: /(^|\/)theme\//.test(r) || /(^|\/)config\.json$/i.test(r)
		});
	};

	for (const e of ensembles) {
		for (const f of walkFiles(e.root, ['.json']))
			registerFile(f, e.name);
		for (const f of walkFiles(e.root, ['.js', '.jsx']))
			registerFile(f, e.name);
	}
	for (const f of walkFiles(APP_DIR, ['.json', '.js', '.jsx']))
		registerFile(f, '(app)');

	//legoz/src — registered actions/components can reference ensemble traits.
	const registerSrcFiles = () => {
		const srcFiles = walkFiles(SRC_DIR, ['.js', '.jsx']);
		srcFiles.forEach(f => registerFile(f, '(src)'));

		return srcFiles;
	};

	//---------------------------------------------------------------- resolution
	const looksDynamic = s => s.includes('{') || s.includes('%') || s.includes('$');

	//Resolve "./x" / "./../x" against a base dir — packager semantics: strip "./",
	// then each leading "../" goes one level up (getMappedPath in recurseProcessMda.js).
	const resolveRelative = (ref, baseDir) => {
		let p = ref.slice(2);
		let dir = baseDir;

		while (p.startsWith('../')) {
			dir = path.dirname(dir);
			p = p.slice(3);
		}

		return norm(path.join(dir, p));
	};

	//Given a resolved base path with no extension, return every existing candidate.
	const existingCandidates = base => {
		const cands = [];
		for (const ext of ['.json', '.js', '.jsx']) {
			if (files.has(key(base + ext)))
				cands.push(base + ext);
		}
		//JS-style folder imports
		for (const ext of ['.js', '.jsx', '.json']) {
			if (files.has(key(base + '/index' + ext)))
				cands.push(base + '/index' + ext);
		}
		//The ref might already carry its extension
		if (/\.(json|jsx?|)$/.test(base) && files.has(key(base)))
			cands.push(base);

		return cands;
	};

	//Path-suffix fallback for relative refs that miss from the containing file.
	// Requires >= 2 segments so "./index" can't match every index.json around.
	const fuzzyResolveRelative = (ref, file) => {
		let tail = ref.slice(2);
		while (tail.startsWith('../'))
			tail = tail.slice(3);

		if (tail.split('/').length < 2)
			return [];

		const e = file.ensemble !== '(app)' ? ensemblesByName.get(file.ensemble) : null;
		const rootKey = key(e ? e.root : APP_DIR) + '/';
		const suffixes = ['.json', '.js', '.jsx'].map(ext => ('/' + tail + ext).toLowerCase());

		const matches = [];
		for (const [k, f] of files) {
			if (k.startsWith(rootKey) && suffixes.some(s => k.endsWith(s)))
				matches.push(f.path);
		}

		return matches;
	};

	/*
		Process one candidate reference string found in `file`.
		  sink(absPath, viaRef) is called for every resolved candidate file.
		  diag ({ unresolvedRefs: [], dynamicRefs: [] }) collects diagnostics when given.
		Returns true when the string was treated as a reference, false when ignored.
	*/
	const processRef = (ref, file, sink, diag) => {
		if (typeof ref !== 'string' || ref.length < 3 || ref.length > 300)
			return false;

		//Strip viewport query strings ("@.../index?prc_idn=101")
		const clean = ref.trim().split('?')[0];

		//Theme function/freetext references: ">path/file" or ">>folder"
		if (clean.startsWith('>')) {
			const inner = clean.replace(/^>+/, '');
			if (!inner || /\s/.test(inner))
				return false;

			const e = file.ensemble !== '(app)' ? ensemblesByName.get(file.ensemble) : null;
			const base = inner.includes('{ensembleLocation}')
				? inner.replace(/\{ensembleLocation\}\/?/, (e ? e.root : norm(APP_DIR)) + '/')
				: norm(path.join(APP_DIR, inner));

			for (const cand of [base, base + '.js', base + '.jsx'])
				if (files.has(key(cand)))
					sink(cand, ref);

			return true;
		}

		if (ENSEMBLE_REF.test(clean)) {
			const ensembleName = clean.slice(1, clean.indexOf('/'));
			const e = ensemblesByName.get(ensembleName);
			if (!e)
				return false;

			//Dynamic segments become wildcards: every file the template could
			// produce is conservatively treated as referenced.
			if (looksDynamic(clean)) {
				const pattern = clean.slice(ensembleName.length + 2)
					.replace(/%[^%/]+%|\{\{[^}]*\}\}|\{[^}/]+\}/g, '\u0000')
					.split('\u0000')
					.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
					.join('[^/]+');

				const re = new RegExp(`^${key(e.root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/${pattern.toLowerCase()}(\\.json|\\.jsx?|/index\\.(json|jsx?))$`);
				let matchCount = 0;
				for (const [k, f] of files) {
					if (re.test(k)) {
						matchCount++;
						sink(f.path, `${ref} (dynamic)`);
					}
				}

				diag?.dynamicRefs.push({ ref: clean, in: file.relPath, matchedFiles: matchCount });
				return true;
			}

			const base = norm(path.join(e.root, clean.slice(ensembleName.length + 2)));
			const cands = existingCandidates(base);

			if (!cands.length) {
				diag?.unresolvedRefs.push({ ref: clean, in: file.relPath });
				return true;
			}

			cands.forEach(c => sink(c, ref));
			return true;
		}

		if (RELATIVE_REF.test(clean)) {
			if (looksDynamic(clean)) {
				diag?.dynamicRefs.push({ ref: clean, in: file.relPath });
				return true;
			}

			const base = resolveRelative(clean, path.dirname(file.path));
			let cands = existingCandidates(base);

			if (!cands.length)
				cands = fuzzyResolveRelative(clean, file);

			if (!cands.length) {
				//Relative-looking strings are common in eval snippets/URLs; only flag
				// ones that stay inside a known ensemble or the app folder.
				const insideKnownRoot = ensembles.some(e => key(base).startsWith(key(e.root) + '/')) ||
					key(base).startsWith(key(APP_DIR) + '/');
				if (insideKnownRoot)
					diag?.unresolvedRefs.push({ ref: clean, in: file.relPath });

				return true;
			}

			cands.forEach(c => sink(c, ref));
			return true;
		}

		//Bare dashboard path -> legoz/app/dashboard/<path> (only counted when it exists)
		if (BARE_REF.test(clean) && !looksDynamic(clean)) {
			const base = norm(path.join(APP_DIR, 'dashboard', clean));
			existingCandidates(base).forEach(c => sink(c, ref));
			return true;
		}

		return false;
	};

	//---------------------------------------------------------------- file scanning
	const scanJsonValue = (v, file, sink, diag) => {
		if (typeof v === 'string')
			processRef(v, file, sink, diag);
		else if (Array.isArray(v))
			v.forEach(x => scanJsonValue(x, file, sink, diag));
		else if (v !== null && typeof v === 'object')
			Object.values(v).forEach(x => scanJsonValue(x, file, sink, diag));
	};

	//Read + parse a JSON file from the inventory; returns undefined when unreadable.
	const readJson = fileKey => {
		const file = files.get(fileKey);
		if (!file || file.kind !== 'json')
			return undefined;

		try {
			return JSON.parse(fs.readFileSync(file.path, 'utf-8').replace(/^﻿/, ''));
		} catch {
			return undefined;
		}
	};

	//Scan one inventory file for references: sink(absPath, viaRef) per candidate.
	const scanFile = (fileKey, sink, diag) => {
		const file = files.get(fileKey);
		if (!file)
			return;

		let contents;
		try {
			contents = fs.readFileSync(file.path, 'utf-8');
		} catch {
			return;
		}

		if (file.kind === 'json') {
			let json;
			try {
				json = JSON.parse(contents.replace(/^﻿/, ''));
			} catch {
				if (diag)
					console.warn(`Invalid JSON (skipped): ${file.relPath}`);
				return;
			}

			scanJsonValue(json, file, sink, diag);
		} else {
			for (const lit of extractJsStrings(contents)) {
				if (lit)
					processRef(lit, file, sink, diag);
			}
		}
	};

	//Parse an entrypoints file (menu dataset) into a list of viewport values.
	const parseEntrypointsFile = (epPath, field) => {
		const raw = fs.readFileSync(epPath, 'utf-8').replace(/^﻿/, '');

		if (epPath.endsWith('.json')) {
			const data = JSON.parse(raw);
			const fields = field ? [field] : ['loc_nme', 'value', 'path', 'dashboard'];
			const list = Array.isArray(data) ? data : Object.values(data);

			return list.map(item => {
				if (typeof item === 'string')
					return item;

				if (item && typeof item === 'object') {
					for (const f of fields) {
						if (typeof item[f] === 'string')
							return item[f];
					}
				}

				return null;
			}).filter(Boolean);
		}

		return raw.split(/\r?\n/)
			.map(l => l.trim())
			.filter(l => l && !l.startsWith('#'));
	};

	return {
		APP,
		APP_DIR,
		absFromRel,
		SRC_DIR,
		ensembles,
		ensemblesByName,
		files,
		norm,
		key,
		rel,
		walkFiles,
		registerFile,
		registerSrcFiles,
		processRef,
		scanFile,
		readJson,
		parseEntrypointsFile
	};
};

module.exports = { createScanner, extractJsStrings };
