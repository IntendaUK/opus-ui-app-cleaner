/*
	trait-prepare — lean traitArray loader for the converter: resolves a trait ref,
	substitutes traitPrps (%x% morph / $x$ direct — applyBlueprintsNew semantics
	incl. dfts, required check, single-wildcard-undefined deletion,
	traitConfig.ignoreUndefinedPrps), rewrites the body's relative "./" refs against
	the trait's own folder, and returns its traitArray actions.

	Recursion over nested {traits:[…]} ACTIONS is driven by the codegen (which
	flattens them inline); this module handles one trait at a time.
*/

const fs = require('fs');
const path = require('path');

const norm = p => path.resolve(p).replace(/\\/g, '/');
const RELATIVE_REF = /^\.\/[^\s'"`<>|]+$/;

const getDeep = (obj, p) => {
	for (const s of String(p).split('.')) {
		if (obj === null || obj === undefined)
			return undefined;
		obj = obj[s];
	}
	return obj;
};

const isWildcard = k => {
	const chars = ['%', '$'];
	return chars.indexOf(k[0]) > -1 && chars.indexOf(k[0]) === chars.indexOf(k[k.length - 1]);
};

//Array values (inlineKeys-style multi-line evals) are joined with ' ' — exactly
// what the packager does — instead of String()'s comma-join which corrupts them.
const coerce = r => Array.isArray(r) ? r.join(' ') : r;

const morphString = (s, vars) => s
	.replace(/%(.*?)%/g, (m, t) => {
		const r = getDeep(vars, t);
		return r === undefined ? m : coerce(r);
	})
	.replace(/\$(.*?)\$/g, (m, t) => {
		const r = getDeep(vars, t);
		if (r === undefined)
			return m;
		//Chained prps stay raw wildcards for the runtime pass (see merge tool).
		if (typeof r === 'string' && /^[%$][\w.]+[%$]$/.test(r))
			return r;
		if (Array.isArray(r) && r.every(x => typeof x === 'string'))
			return JSON.stringify(r.join(' '));
		const out = JSON.stringify(r);
		return out === undefined ? m : out;
	});

const directValue = (s, vars) => {
	const name = s.split('$').join('').replace('...', '');
	const v = name.includes('.') ? getDeep(vars, name) : vars[name];
	return v === undefined ? s : v;
};

const substitute = (node, vars, cfg) => {
	if (Array.isArray(node)) {
		for (let i = 0; i < node.length; i++) {
			const v = node[i];
			if (typeof v === 'string')
				node[i] = substituteString(v, vars, cfg, () => node.splice(i--, 1));
			else if (v && typeof v === 'object')
				substitute(v, vars, cfg);
		}
		return;
	}

	for (const k of Object.keys(node)) {
		const v = node[k];
		if (typeof v === 'string')
			node[k] = substituteString(v, vars, cfg, () => delete node[k]);
		else if (v && typeof v === 'object')
			substitute(v, vars, cfg);
	}

	//Wildcard keys
	for (const k of Object.keys(node)) {
		if (isWildcard(k) && k.split(k[0]).length === 3) {
			const name = k.slice(1, -1).replace('...', '').split('.')[0];
			if (getDeep(vars, name) === undefined) {
				if (!cfg.ignoreUndefinedPrps || cfg.spec[name] !== undefined)
					delete node[k];
				continue;
			}
			const newKey = k[0] === '$' ? directValue(k, vars) : morphString(k, vars);
			node[newKey] = node[k];
			delete node[k];
		}
	}
};

const substituteString = (s, vars, cfg, deleteKey) => {
	//Lone wildcard of an undefined prp → key deleted (runtime deletePrpIfMissing)
	if (isWildcard(s) && s.split(s[0]).length === 3) {
		const name = s.slice(1, -1).replace('...', '').split('.')[0];
		if (getDeep(vars, name) === undefined) {
			if (!(cfg.ignoreUndefinedPrps && cfg.spec[name] === undefined))
				deleteKey();
			return s;
		}
		if (s[0] === '$')
			return directValue(s, vars);
	}
	return morphString(s, vars);
};

/*
	prepareTraitArray({ absPath, traitPrps, ensembles }) →
	  { actions } | { skip: reason }
*/
const prepareTraitArray = ({ absPath, traitPrps = {}, ensembles }) => {
	let trait;
	try {
		trait = JSON.parse(fs.readFileSync(absPath, 'utf-8').replace(/^﻿/, ''));
	} catch {
		return { skip: 'trait file is not valid JSON' };
	}

	const spec = trait.acceptPrps ?? {};
	if (Object.values(spec).some(v => v && typeof v === 'object' && v.morph === true))
		return { skip: 'trait has morph:true acceptPrps' };
	if (!Array.isArray(trait.traitArray))
		return { skip: 'trait has no traitArray' };

	const vars = JSON.parse(JSON.stringify(traitPrps));
	Object.entries(spec).forEach(([k, v]) => {
		if (vars[k] === undefined && v && typeof v === 'object' && v.dft !== undefined)
			vars[k] = JSON.parse(JSON.stringify(v.dft));
	});

	const missing = Object.entries(spec)
		.filter(([k, v]) => vars[k] === undefined && v && typeof v === 'object' && v.required === true)
		.map(([k]) => k);
	if (missing.length)
		return { skip: `missing required traitPrps: ${missing.join(', ')}` };

	const cfg = { spec, ignoreUndefinedPrps: trait.traitConfig?.ignoreUndefinedPrps ?? false };

	const actions = JSON.parse(JSON.stringify(trait.traitArray));

	//Substitute prps into themselves first (runtime does), then into the body.
	substitute(vars, vars, cfg);
	substitute(actions, vars, cfg);

	//Rewrite relative refs against the trait's folder (existence-gated, like the
	// merge tool: viewport-mount-relative paths stay untouched).
	const traitDir = path.dirname(absPath);
	const rewrite = node => {
		const fix = s => {
			if (!RELATIVE_REF.test(s))
				return s;
			let p = s.slice(2);
			let dir = traitDir;
			while (p.startsWith('../')) {
				dir = path.dirname(dir);
				p = p.slice(3);
			}
			const abs = norm(path.join(dir, p));
			const e = ensembles.find(x => abs.startsWith(x.root + '/'));
			if (!e)
				return s;
			const exists = ['.json', '.js', '.jsx', ''].some(ext => fs.existsSync(abs + ext));
			return exists ? `@${e.name}/${abs.slice(e.root.length + 1)}` : s;
		};

		if (Array.isArray(node)) {
			for (let i = 0; i < node.length; i++) {
				if (typeof node[i] === 'string')
					node[i] = fix(node[i]);
				else if (node[i] && typeof node[i] === 'object')
					rewrite(node[i]);
			}
		} else if (node && typeof node === 'object') {
			for (const k of Object.keys(node)) {
				if (typeof node[k] === 'string')
					node[k] = fix(node[k]);
				else if (node[k] && typeof node[k] === 'object')
					rewrite(node[k]);
			}
		}
	};
	rewrite(actions);

	return { actions };
};

module.exports = { prepareTraitArray };
