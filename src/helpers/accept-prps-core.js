/* eslint-disable no-console */

/*
	accept-prps-core

	Shared analysis for the unused-accept-prps tools: which props declared in a
	trait file's top-level "acceptPrps" are never consumed anywhere.

	A prop counts as USED when any of these holds:

	  1. self    — a wildcard token naming it appears anywhere in the trait file
	               itself, in a value or a key: "%prop%", "$prop$", "$...prop$",
	               "%prop.deep.path%", or composites like "%a%-%b%". Other props'
	               spec values (dft etc.) count too: defaults are merged into
	               traitPrps and recursed over themselves at application time.
	  2. morph   — the spec has morph: true. Morph props are consumed by the
	               morphProps machinery at runtime (recurseProps), which is not
	               statically checkable, so they are always kept.
	  3. caller  — some file's traitPrps FOR THIS TRAIT contains a token naming the
	               prop. Caller-supplied traitPrps are recursed against the combined
	               prps at application time (recursivelyApplyValuePrps(traitPrps,
	               traitPrps)), so "traitPrps": { "title": "%name%" } is a use of
	               "name" even when the trait body never mentions it.
	  4. js      — a .js/.jsx file references the trait (string literal resolving to
	               its path) AND some literal in that same file carries a token with
	               the prop's name. JS-composed metadata (registered actions and
	               components build viewports with traits at runtime) is opaque to
	               a JSON walk; this file-level pairing errs toward "used".

	Token semantics mirror opus-ui (blueprintManager.js getMorphedString /
	getVariableValue and applyBlueprintsNew.js deletePrpIfMissing): /%(.*?)%/ and
	/\$(.*?)\$/ per string, a "..." spread prefix is stripped, and a deep path
	("x.y.z") resolves from its first segment.

	The analysis is deliberately conservative: a prop is only reported unused when
	no resolvable use exists in any of the four forms, so false "used" marks (e.g.
	a "%data.x%" script accessor colliding with a declared prop named "data") only
	ever make the tool delete less.
*/

const fs = require('fs');
const { extractJsStrings } = require('./scan-core');

//Mirrors opus-ui getMorphedString: %...% and $...$ tokens, non-greedy, per line.
const TOKEN_RE = /%(.*?)%|\$(.*?)\$/g;

//Add every token in `str` to `into` — both the full token ("a.b") and its base
// name ("a", what the runtime resolves the prop from).
const addTokenNames = (str, into) => {
	TOKEN_RE.lastIndex = 0;

	let m;
	while ((m = TOKEN_RE.exec(str)) !== null) {
		const token = (m[1] !== undefined ? m[1] : m[2]).replace('...', '');
		if (!token)
			continue;

		into.add(token);

		const base = token.split('.')[0];
		if (base)
			into.add(base);
	}
};

//Collect token names from every string value AND key in a JSON subtree
// (recursivelyApplyKeyPrps morphs keys too).
const collectTokens = (node, into) => {
	if (typeof node === 'string') {
		addTokenNames(node, into);

		return;
	}

	if (Array.isArray(node)) {
		node.forEach(x => collectTokens(x, into));

		return;
	}

	if (node !== null && typeof node === 'object') {
		for (const [k, v] of Object.entries(node)) {
			addTokenNames(k, into);
			collectTokens(v, into);
		}
	}
};

//Tokens used by the trait file itself. The top-level acceptPrps keys are the
// declarations, not usages — but their spec VALUES are scanned (a dft like
// "%otherProp%" is a real use of otherProp).
const collectSelfTokens = json => {
	const into = new Set();

	for (const [k, v] of Object.entries(json)) {
		if (k === 'acceptPrps' && v !== null && typeof v === 'object' && !Array.isArray(v)) {
			Object.values(v).forEach(spec => collectTokens(spec, into));
			continue;
		}

		addTokenNames(k, into);
		collectTokens(v, into);
	}

	return into;
};

//Visit every { trait: "<string>", traitPrps: {...} } entry in a JSON subtree
// (covers both "traits": [ ... ] arrays and bare "trait" keys).
const forEachTraitEntry = (node, cb) => {
	if (Array.isArray(node)) {
		node.forEach(x => forEachTraitEntry(x, cb));

		return;
	}

	if (node === null || typeof node !== 'object')
		return;

	if (typeof node.trait === 'string' && node.traitPrps !== null && typeof node.traitPrps === 'object')
		cb(node.trait, node.traitPrps);

	for (const v of Object.values(node))
		forEachTraitEntry(v, cb);
};

/*
	Analyze the whole workspace.

	Returns { traits: [ { file, acceptPrps, declared, unused, usedVia } ] } where
	  file      — scan-core inventory record ({ path, relPath, ensemble, ... })
	  declared  — every prop name in the file's top-level acceptPrps
	  unused    — the subset with no detected use, in declaration order
	  usedVia   — Map(propName -> { via: 'self'|'morph'|'caller'|'js', by })
*/
const analyzeAcceptPrps = scanner => {
	const { files, key, readJson, registerSrcFiles, processRef } = scanner;

	registerSrcFiles();

	//---------------------------------------------------------------- inventory
	//key -> { file, json, acceptPrps, usedVia }
	const traits = new Map();

	for (const [k, f] of files) {
		if (f.kind !== 'json' || f.ensemble === '(src)')
			continue;

		const json = readJson(k);
		if (!json || typeof json !== 'object' || Array.isArray(json))
			continue;

		const ap = json.acceptPrps;
		if (!ap || typeof ap !== 'object' || Array.isArray(ap) || !Object.keys(ap).length)
			continue;

		traits.set(k, { file: f, json, acceptPrps: ap, usedVia: new Map() });
	}

	const mark = (trait, prop, via, by) => {
		if (!trait.usedVia.has(prop))
			trait.usedVia.set(prop, { via, by });
	};

	//---------------------------------------------------------------- 1+2: self, morph
	for (const t of traits.values()) {
		for (const [p, spec] of Object.entries(t.acceptPrps)) {
			if (spec !== null && typeof spec === 'object' && spec.morph === true)
				mark(t, p, 'morph', null);
		}

		const tokens = collectSelfTokens(t.json);
		for (const p of Object.keys(t.acceptPrps)) {
			if (tokens.has(p))
				mark(t, p, 'self', null);
		}
	}

	//Resolve a trait reference string to the trait files it can target.
	const resolveTraitTargets = (ref, file) => {
		const targets = [];
		processRef(ref, file, p => {
			const k = key(p);
			if (traits.has(k))
				targets.push(k);
		}, null);

		return targets;
	};

	//---------------------------------------------------------------- 3: caller traitPrps
	for (const [k, f] of files) {
		if (f.kind !== 'json')
			continue;

		const json = readJson(k);
		if (!json || typeof json !== 'object')
			continue;

		forEachTraitEntry(json, (traitRef, traitPrps) => {
			const tokens = new Set();
			collectTokens(traitPrps, tokens);
			if (!tokens.size)
				return;

			for (const tk of resolveTraitTargets(traitRef, f)) {
				const t = traits.get(tk);
				for (const p of Object.keys(t.acceptPrps)) {
					if (tokens.has(p))
						mark(t, p, 'caller', f.relPath);
				}
			}
		});
	}

	//---------------------------------------------------------------- 4: JS callers
	for (const [, f] of files) {
		if (f.kind !== 'js')
			continue;

		let src;
		try {
			src = fs.readFileSync(f.path, 'utf-8');
		} catch {
			continue;
		}

		const targets = new Set();
		const tokens = new Set();

		for (const lit of extractJsStrings(src)) {
			if (!lit)
				continue;

			processRef(lit, f, p => {
				const kk = key(p);
				if (traits.has(kk))
					targets.add(kk);
			}, null);

			addTokenNames(lit, tokens);
		}

		if (!targets.size || !tokens.size)
			continue;

		for (const tk of targets) {
			const t = traits.get(tk);
			for (const p of Object.keys(t.acceptPrps)) {
				if (tokens.has(p))
					mark(t, p, 'js', f.relPath);
			}
		}
	}

	//---------------------------------------------------------------- results
	const results = [];

	for (const t of traits.values()) {
		const declared = Object.keys(t.acceptPrps);

		results.push({
			file: t.file,
			acceptPrps: t.acceptPrps,
			declared,
			unused: declared.filter(p => !t.usedVia.has(p)),
			usedVia: t.usedVia
		});
	}

	results.sort((a, b) => a.file.relPath.localeCompare(b.file.relPath));

	return { traits: results };
};

module.exports = { analyzeAcceptPrps };
