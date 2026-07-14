#!/usr/bin/env node
/* eslint-disable no-console, max-lines */

/*
	merge-single-use-traits

	Finds trait files (top-level acceptPrps) referenced exactly once, and inlines each
	one into its single use location, replicating the Opus UI runtime EXACTLY
	(opus-ui/src/system/managers/traitManager.js + blueprintManager/applyBlueprintsNew.js):

	  - traitPrps defaults (dft) + required check; %x% morphing (deep access, undefined
	    tokens left as-is), $x$ whole-value replace / embedded JSON.stringify, single-
	    wildcard keys/values of undefined prps DELETED (honouring traitConfig.
	    ignoreUndefinedPrps), $...x$ array spreads, "spread-" keys
	  - merge per combineTraitAndMda: scope union (host first), scps/flows/morphProps/
	    lookupFilters/lookupFlows concatenated host-first, everything else deep-merged
	    with host keys winning and arrays merging index-wise (cloneNoOverrideNoCopy)
	  - entry `auth`: listed paths deleted from the host node before the merge
	  - the trait's own root-level `traits` hoisted into the host's traits array at the
	    merged entry's position (provably order-equivalent)
	  - traitArray traits spliced in place of the referencing array item
	    (applyTraitsToArray semantics)

	Anything that CANNOT be inlined without a possible behavior change is skipped and
	reported: entries with `condition` (runtime-evaluated), traits with morph:true
	prps (runtime state morphing), missing required prps (runtime wouldn't apply the
	trait), refs that aren't traits-array entries (viewport values, traitDataManager,
	JS-built mda), non-first entries whose content could collide with what earlier
	traits contribute (key conflicts / scps order / scope order), trait roots with
	conditional nested traits (condition context changes), and dynamic paths.

	Known deviation (documented): the runtime also theme-resolves every string during
	trait application (resolveThemeAccessor). Inlined content keeps `{theme.x}`
	accessors as strings — they resolve through the normal component/script pipelines
	instead, which is the standard behavior for non-trait dashboard JSON.

	DRY-RUN BY DEFAULT. Pass --apply to modify files. Merged trait files are moved to
	./merged-traits-backup/traits/, and each host file's pre-merge version is copied to
	./merged-traits-backup/originals/ (restoring is manual, or use git).

	Usage:
	  node merge-single-use-traits.js                 # dry-run, report only
	  node merge-single-use-traits.js --apply         # do it (loops until fixpoint)
	  node merge-single-use-traits.js --only=<relPath>  # limit to one trait (testing)
*/

const fs = require('fs');
const path = require('path');
const { createScanner } = require('./helpers/scan-core');
const { resolveAppDir } = require('./helpers/app-config');
const { computeTraitRefs, defaultEntrypointsPath } = require('./helpers/trait-refs');

//Run artifacts (reports, backups, trash) live at the tool root, above src/.
const TOOL_ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(TOOL_ROOT, 'output');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

//---------------------------------------------------------------- CLI
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
Usage: node merge-single-use-traits.js [options]

Inlines every single-use trait into its one use location (exact Opus UI runtime
semantics; anything uncertain is skipped and reported).

Options:
  --apply               Actually modify files (default: dry-run report only)
  --only=<relPath>      Only process this trait (repeatable via comma-separation)
  --maxPasses=<n>       Fixpoint iteration cap with --apply (default 10)
  --app=<dir>            App root (default: appPath from ../config.json)
  --entrypoints=<file>  Menu dataset (counts as references; default: entrypoints.txt)
  --field=<name>        Field for JSON entrypoints files
  --out=<dir>           Report output directory (default: this folder)
  --ignore-trash        Allow --apply while ./deleted-files/ exists (see README)
  --help                Show this help
`);
	process.exit(0);
}

const APPLY = !!args.apply;
const MAX_PASSES = APPLY ? Number(args.maxPasses ?? 10) : 1;
const OUT_DIR = path.resolve(args.out || OUTPUT_DIR);
const BACKUP = path.join(OUTPUT_DIR, 'merged-traits-backup');
const ONLY = args.only ? new Set(String(args.only).split(',').map(s => s.trim().replace(/\\/g, '/'))) : null;

//Merging while unused files sit in the trash is dangerous: a trait that looks
// single-use now may have a second reference inside a trashed file, and restoring
// the trash would leave that reference dangling.
const trashDir = path.join(OUTPUT_DIR, 'deleted-files');
if (fs.existsSync(trashDir)) {
	if (APPLY && !args['ignore-trash']) {
		console.error('\nERROR: ./deleted-files/ exists — files are currently soft-deleted.');
		console.error('A trait that looks single-use now may be referenced again after an undelete.');
		console.error('Either undelete first, commit to the deletion, or pass --ignore-trash.\n');
		process.exit(1);
	}
	console.warn('\nWARNING: ./deleted-files/ exists — single-use analysis reflects the reduced workspace.\n');
}

//---------------------------------------------------------------- runtime ports
//Exact ports of opus-ui internals (minus theme resolution — see header).

const getDeepProperty = (obj, p) => {
	if (!p)
		return obj;
	p.split('.').forEach(seg => {
		if (obj)
			obj = obj[seg];
	});
	return obj;
};

const deepClone = v => v === undefined ? v : JSON.parse(JSON.stringify(v));

//blueprintManager.getMorphedString
//Array values (inlineKeys multi-line evals) join with ' ' like the packager does —
// String()'s comma-join corrupts them.
const coerceMorphValue = r => Array.isArray(r) ? r.join(' ') : r;

const getMorphedString = (string, vars) => {
	return string
		.replace(/%(.*?)%/g, (match, token) => {
			const replacer = getDeepProperty(vars, token);
			return replacer === undefined ? match : coerceMorphValue(replacer);
		})
		.replace(/\$(.*?)\$/g, (match, token) => {
			const replacer = getDeepProperty(vars, token);
			if (replacer === undefined)
				return match;
			//Chained prps: a value that is itself a lone wildcard ('$x$'/'%x%') is
			// spliced RAW — the runtime pass with the real value stringifies it.
			// JSON.stringify here would bake quotes around the eventual value.
			if (typeof replacer === 'string' && /^[%$][\w.]+[%$]$/.test(replacer))
				return replacer;
			if (Array.isArray(replacer) && replacer.every(x => typeof x === 'string'))
				return JSON.stringify(replacer.join(' '));
			const out = JSON.stringify(replacer);
			return out === undefined ? match : out;
		});
};

//blueprintManager.getVariableValue
const getVariableValue = (value, vars) => {
	const variableName = value.split('$').join('').replace('...', '');

	if (!variableName.includes('.')) {
		const variableValue = vars[variableName];
		return variableValue === undefined ? value : variableValue;
	}

	const deepValue = getDeepProperty(vars, variableName);
	return deepValue === undefined ? value : deepValue;
};

//applyBlueprintsNew.isWildcard
const wildcardChars = ['%', '$'];
const isWildcard = k => {
	const firstIndex = wildcardChars.indexOf(k[0]);
	const lastIndex = wildcardChars.indexOf(k[k.length - 1]);
	return firstIndex > -1 && firstIndex === lastIndex;
};

//applyBlueprintsNew.applyPrpDefaults
const applyPrpDefaults = (prps, spec) => {
	Object.entries(spec).forEach(([k, v]) => {
		const value = prps[k];
		const { dft, morph } = (v && typeof v === 'object') ? v : {};
		if (!morph && (value !== undefined || dft === undefined))
			return;
		prps[k] = deepClone(dft);
	});
};

//applyBlueprintsNew.findMissingPrps
const findMissingPrps = (prps, spec) => {
	return Object.entries(spec)
		.filter(([k, propDef]) => {
			if (prps[k] !== undefined)
				return false;
			if (typeof propDef !== 'object' || propDef === null || propDef.required !== true)
				return false;
			return true;
		})
		.map(([k]) => k);
};

//applyBlueprintsNew.deletePrpIfMissing
const deletePrpIfMissing = (k, value, blueprint, prps, recurseConfig) => {
	if (isWildcard(value) && value.split(value[0]).length === 3) {
		const prp = value.substring(1, value.length - 1);
		const prpNamePreSplit = prp.replace('...', '');
		const prpName = prpNamePreSplit.includes('.') ? prpNamePreSplit.split('.')[0] : prpNamePreSplit;

		if (recurseConfig?.ignoreUndefinedPrps === true && recurseConfig.traitPrpSpec[prpName] === undefined)
			return false;

		//Host-scope chaining (traitPrps self-substitution pass only): a wildcard
		// naming a prp the HOST file declares in its own acceptPrps resolves when
		// the host is applied as a trait at runtime — keep it raw, never delete.
		// (Without this, {value: "$columnCellValue$"} loses `value` because
		// `columnCellValue` is a host prp, not one of these traitPrps.)
		if (recurseConfig?.hostSpec?.[prpName] !== undefined && prps[prpName] === undefined)
			return false;

		//Chained prps: when the ROOT prp value is itself a wildcard placeholder
		// ('$columnConfig$'), deep paths like '$columnConfig.traits$' look missing
		// here but resolve at runtime when the real object arrives — never delete.
		const rootValue = prps[prpName];
		if (typeof rootValue === 'string' && /^[%$][\w.]+[%$]$/.test(rootValue))
			return false;

		let prpValue = rootValue;
		if (prpNamePreSplit.includes('.'))
			prpValue = getDeepProperty(prps, prpNamePreSplit);

		if (prpValue === undefined) {
			delete blueprint[k];
			return true;
		}
	}

	return false;
};

//system/helpers/clone (deep overwrite merge) — used for "spread-" keys
const cloneOverwrite = (target, source) => {
	for (const k in source) {
		const v = source[k];
		if (v !== null && typeof v === 'object') {
			if (!target[k] || typeof target[k] !== 'object')
				target[k] = Array.isArray(v) ? [] : {};
			cloneOverwrite(target[k], v);
		} else
			target[k] = v;
	}
	return target;
};

//applyBlueprintsNew.applyValuePrp / recursivelyApplyValuePrps (minus resolveThemeAccessor)
let recursivelyApplyValuePrps;

const applyValuePrp = (blueprint, prps, recurseConfig, closestArrayAncestor, k, value) => {
	const type = typeof value;

	if (type === 'object' && value !== null) {
		recursivelyApplyValuePrps(value, prps, recurseConfig, closestArrayAncestor);
		return;
	} else if (type !== 'string')
		return;

	if (deletePrpIfMissing(k, value, blueprint, prps, recurseConfig))
		return;

	const isDirectReplace = value[0] === '$' && value.slice(-1) === '$';

	const finalValue = isDirectReplace
		? getVariableValue(value, prps)
		: getMorphedString(value, prps);

	if (value.indexOf('$...') === 0) {
		closestArrayAncestor.splice(k, 1, ...finalValue);
		return;
	} else if (k === 'spread-') {
		cloneOverwrite(blueprint, finalValue);
		delete blueprint[k];
		return;
	}

	blueprint[k] = finalValue;
};

recursivelyApplyValuePrps = (blueprint, prps, recurseConfig, closestArrayAncestor) => {
	if (Array.isArray(blueprint)) {
		closestArrayAncestor = blueprint;
		for (let k = 0; k < blueprint.length; k++)
			applyValuePrp(blueprint, prps, recurseConfig, closestArrayAncestor, k, blueprint[k]);
		return;
	}

	for (const [k, value] of Object.entries(blueprint))
		applyValuePrp(blueprint, prps, recurseConfig, closestArrayAncestor, k, value);
};

//applyBlueprintsNew.recursivelyApplyKeyPrps
const recursivelyApplyKeyPrps = (blueprint, prps, recurseConfig) => {
	Object.keys(blueprint).forEach(k => {
		const keyPrpDeleted = deletePrpIfMissing(k, k, blueprint, prps, recurseConfig);
		if (!keyPrpDeleted && isWildcard(k)) {
			const val = blueprint[k];
			const newKey = k[0] === '$'
				? getVariableValue(k, prps)
				: getMorphedString(k, prps);

			blueprint[newKey] = val;
			delete blueprint[k];
		}
	});
};

//helpers/cloneNoOverrideNoCopy (host wins, arrays merge index-wise)
const cloneRecursiveNoOverrideNoCopy = (o, newO) => {
	if (typeof o !== 'object' || !o)
		return o;

	if (Array.isArray(o)) {
		if (!newO?.push)
			newO = [];
		for (let i = 0; i < o.length; i++)
			newO[i] = cloneRecursiveNoOverrideNoCopy(o[i], newO[i]);
		return newO;
	}

	if (!newO || typeof newO !== 'object')
		newO = {};

	for (const i in o) {
		if (!Object.prototype.hasOwnProperty.call(o, i))
			continue;

		if (newO[i] === undefined) {
			newO[i] = o[i];
			continue;
		}

		const newValue = cloneRecursiveNoOverrideNoCopy(o[i], newO[i]);
		const setValue = newO[i] === undefined || (typeof newValue === 'object' && newValue !== null);
		if (!setValue)
			continue;

		newO[i] = newValue;
	}

	return newO;
};

const cloneNoOverrideNoCopy = (target, source) => {
	cloneRecursiveNoOverrideNoCopy(source, target);
	return target;
};

//traitManager.combineArrayProps
const combineArrayProps = ['scps', 'flows', 'morphProps', 'lookupFilters', 'lookupFlows', 'traitMappings'];

//traitManager.combineTraitAndMda (minus dev-mode traitMappings bookkeeping)
const combineTraitAndMda = (mda, trait) => {
	if (mda.scope && trait.scope) {
		const combinedScope = Array.isArray(mda.scope) ? mda.scope : [mda.scope];
		if (Array.isArray(trait.scope)) {
			trait.scope.forEach(s => {
				if (!combinedScope.includes(s))
					combinedScope.push(s);
			});
		} else if (!combinedScope.includes(trait.scope))
			combinedScope.push(trait.scope);

		mda.scope = combinedScope;
		delete trait.scope;
	}

	combineArrayProps.forEach(p => {
		if (trait?.prps?.[p]?.length && mda?.prps?.[p]?.length) {
			mda.prps[p].push(...trait.prps[p]);
			delete trait.prps[p];
		}
	});

	cloneNoOverrideNoCopy(mda, trait);
};

//traitManager.deleteAuthFieldsFromMda
const deleteAuthFields = (mda, auth) => {
	auth.forEach(a => {
		const p = a.split('.');
		const l = p.pop();
		let f = mda;
		p.forEach(seg => {
			if (f)
				f = f[seg];
		});
		if (f)
			delete f[l];
	});
};

//---------------------------------------------------------------- setup
const scanner = createScanner({ appDir: resolveAppDir(args) });
const { absFromRel, files, key, rel, ensembles, ensemblesByName } = scanner;

const epPath = args.entrypoints ? path.resolve(args.entrypoints) : defaultEntrypointsPath(TOOL_ROOT);

const norm = p => path.resolve(p).replace(/\\/g, '/');

//Resolve a traits-array path string the way the runtime/packager does — direct only,
// no fuzzy fallback (if it needs fuzz, we cannot be sure and must not merge).
const resolveTraitRef = (ref, hostAbsPath) => {
	if (typeof ref !== 'string' || ref.includes('%') || ref.includes('$') || ref.includes('{'))
		return null;

	if (ref.startsWith('@')) {
		const slash = ref.indexOf('/');
		if (slash === -1)
			return null;
		const e = ensemblesByName.get(ref.slice(1, slash));
		if (!e)
			return null;
		return norm(path.join(e.root, ref.slice(slash + 1) + '.json'));
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

//Rewrite the trait body's relative refs: after inlining, "./x" would resolve against
// the HOST file's folder instead of the trait's — so make them absolute "@ens/...".
const RELATIVE_REF = /^\.\/[^\s'"`<>|]+$/;
const rewriteRelativeRefs = (node, traitDir, traitEnsemble, warnings) => {
	const e = ensemblesByName.get(traitEnsemble);

	const rewrite = ref => {
		let p = ref.slice(2);
		let dir = traitDir;
		while (p.startsWith('../')) {
			dir = path.dirname(dir);
			p = p.slice(3);
		}
		const abs = norm(path.join(dir, p));
		if (!e || !abs.startsWith(e.root + '/')) {
			warnings.push(`relative ref escapes ensemble, left as-is: "${ref}"`);
			return ref;
		}

		//Only rewrite refs that actually resolve against the trait's folder. Ones that
		// don't are viewport-mount-relative (resolved at runtime against the mounting
		// viewport's stamped path, independent of which file the string sits in) —
		// rewriting those would bake in a wrong path.
		//fs check (not the pass-1 inventory) — later passes run against moved files.
		const resolves = ['.json', '.js', '.jsx'].some(ext => fs.existsSync(abs + ext)) || fs.existsSync(abs);
		if (!resolves) {
			warnings.push(`relative ref left as-is (does not resolve against trait folder — viewport-relative): "${ref}"`);
			return ref;
		}

		return `@${traitEnsemble}/${abs.slice(e.root.length + 1)}`;
	};

	const walk = v => {
		if (Array.isArray(v)) {
			for (let i = 0; i < v.length; i++) {
				if (typeof v[i] === 'string' && RELATIVE_REF.test(v[i]))
					v[i] = rewrite(v[i]);
				else
					walk(v[i]);
			}
		} else if (v !== null && typeof v === 'object') {
			for (const k of Object.keys(v)) {
				if (typeof v[k] === 'string' && RELATIVE_REF.test(v[k]))
					v[k] = rewrite(v[k]);
				else
					walk(v[k]);
			}
		}
	};

	walk(node);
};

//---------------------------------------------------------------- conflict analysis
/*
	Relaxed rules (user-approved): the ORDER in which traits contribute scps/flows/
	morphProps/lookupFilters/lookupFlows entries and scope-union order do NOT matter.
	A merge is only blocked when it would genuinely change a resolved value:

	  - a preceding entry has a dynamic path (runtime stops applying traits there —
	    the target is never applied at runtime)
	  - a preceding trait sets the same leaf path as the target, the host doesn't
	    shield it, and the VALUES differ (runtime: earlier wins; inlined: target wins)
	  - a preceding entry's `auth` would delete inlined target content at runtime
	  - a preceding trait cannot be resolved/analyzed statically (unknown keys)

	Preceding traits are analyzed through the same preparation pipeline the merge
	itself uses (relative-ref rewrite + full traitPrps substitution), so wildcard
	keys/values resolve to their real form before comparison. Conditional preceding
	entries are analyzed the same way — the condition only makes their contribution
	optional, which is irrelevant when there is no differing-value overlap.
*/

//Loose resolution for preceding-trait paths: direct first, then a unique path-suffix
// match within the same ensemble (mirrors fuzzyResolveRelative in scan-core — needed
// for "./../../../sharedGrids/x" refs that resolve against a mounting viewport).
const resolveTraitRefLoose = (ref, hostAbsPath, hostEnsemble) => {
	const direct = resolveTraitRef(ref, hostAbsPath);
	if (direct && fs.existsSync(direct))
		return direct;

	if (!ref.startsWith('./'))
		return null;

	let tail = ref.slice(2);
	while (tail.startsWith('../'))
		tail = tail.slice(3);
	if (tail.split('/').length < 2)
		return null;

	const e = ensemblesByName.get(hostEnsemble);
	if (!e)
		return null;

	const suffix = ('/' + tail + '.json').toLowerCase();
	const matches = [];
	for (const [k, f] of files) {
		if (k.startsWith(key(e.root) + '/') && k.endsWith(suffix))
			matches.push(f.path);
	}

	return matches.length === 1 ? matches[0] : null;
};

const ensembleOfPath = absPath => {
	const e = ensembles.find(x => norm(absPath).startsWith(x.root + '/'));
	return e ? e.name : '(app)';
};

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/*
	Flatten a prepared trait (body + hoisted nested root traits, resolved recursively)
	into leafPath -> value. Arrays are leaves. `scope`, `traitArray` and the
	concatenating array props (prps.scps etc.) are excluded from conflict leaves —
	both contributions survive a concat/union, only order changes (waived).
	Returns null when a nested trait cannot be resolved/analyzed.
*/
const leafContribution = (prepared, contextAbsPath, contextEnsemble, hostSpec, depth = 0) => {
	if (depth > 6)
		return null;

	const leaves = new Map();
	const arrayProps = new Set();

	const collect = (node, prefix) => {
		for (const [k, v] of Object.entries(node)) {
			const p = prefix ? `${prefix}.${k}` : k;

			if (p === 'scope' || p === 'traitArray')
				continue;
			if (prefix === 'prps' && combineArrayProps.includes(k)) {
				arrayProps.add(k);
				continue;
			}

			if (v !== null && typeof v === 'object' && !Array.isArray(v))
				collect(v, p);
			else if (!leaves.has(p))
				leaves.set(p, v);
		}
	};

	collect(prepared.trait, '');

	//Nested root traits contribute with lower priority (no-override) — first-wins.
	for (const t of prepared.hoisted ?? []) {
		const ref = typeof t === 'string' ? t : (typeof t?.trait === 'string' ? t.trait : null);
		const entryObj = typeof t === 'object' && t !== null ? t : {};

		let nestedPrepared = null;
		let nestedAbs = contextAbsPath;
		let nestedEnsemble = contextEnsemble;

		if (ref) {
			if (ref.includes('%') || ref.includes('$'))
				return null;
			const abs = resolveTraitRefLoose(ref, contextAbsPath, contextEnsemble);
			if (!abs)
				return null;
			nestedAbs = abs;
			nestedEnsemble = ensembleOfPath(abs);
			nestedPrepared = prepareTrait({ path: abs, ensemble: nestedEnsemble }, entryObj, [], hostSpec);
		} else if (entryObj.type && typeof entryObj.type === 'object')
			nestedPrepared = prepareInlineTrait(entryObj.type, entryObj, contextAbsPath, contextEnsemble, hostSpec);
		else
			return null;

		if (!nestedPrepared || nestedPrepared.unparseable)
			return null;

		const sub = leafContribution(nestedPrepared, nestedAbs, nestedEnsemble, hostSpec, depth + 1);
		if (!sub)
			return null;

		for (const [p, v] of sub.leaves) {
			if (!leaves.has(p))
				leaves.set(p, v);
		}
		sub.arrayProps.forEach(x => arrayProps.add(x));
	}

	return { leaves, arrayProps, hasMorph: !!prepared.hasMorph };
};

/*
	Does inlining the target (which sits after `preceding` entries) change behavior?
	Returns { conflict: string|null, warnings: [] }.
*/
const orderConflict = (precedingEntries, targetContrib, hostNode, hostAbsPath, hostEnsemble, hostSpec) => {
	const warnings = [];

	if (!targetContrib)
		return { conflict: 'target trait contribution not statically determinable', warnings };

	for (const t of precedingEntries) {
		const ref = typeof t === 'string' ? t : (typeof t?.trait === 'string' ? t.trait : null);
		const entryObj = typeof t === 'object' && t !== null ? t : {};

		if (ref && (ref.includes('%') || ref.includes('$')))
			return { conflict: 'a preceding trait entry has a dynamic path (runtime stops applying traits there)', warnings };

		//Prepare the preceding trait through the same pipeline as a real merge.
		let prepared = null;
		let precedingAbs = hostAbsPath;
		let precedingEnsemble = hostEnsemble;

		if (ref) {
			const abs = resolveTraitRefLoose(ref, hostAbsPath, hostEnsemble);
			if (!abs)
				return { conflict: `preceding trait "${ref}" cannot be resolved statically`, warnings };
			precedingAbs = abs;
			precedingEnsemble = ensembleOfPath(abs);
			prepared = prepareTrait({ path: abs, ensemble: precedingEnsemble }, entryObj, [], hostSpec);
		} else if (entryObj.type && typeof entryObj.type === 'object')
			prepared = prepareInlineTrait(entryObj.type, entryObj, hostAbsPath, hostEnsemble, hostSpec);
		else
			return { conflict: 'a preceding trait entry has an unrecognized shape', warnings };

		if (!prepared || prepared.unparseable)
			return { conflict: `preceding trait "${ref ?? '(inline)'}" cannot be analyzed (${prepared?.reason ?? 'unknown'})`, warnings };

		const contrib = leafContribution(prepared, precedingAbs, precedingEnsemble, hostSpec);
		if (!contrib)
			return { conflict: 'a preceding trait contribution is not statically determinable', warnings };

		//A preceding entry's auth deletes host fields at its application time — after
		// inlining, the target's content IS host fields and would get deleted.
		if (Array.isArray(entryObj.auth)) {
			for (const a of entryObj.auth) {
				for (const p of targetContrib.leaves.keys()) {
					if (p === a || p.startsWith(a + '.'))
						return { conflict: `a preceding trait entry's auth ("${a}") would delete inlined content`, warnings };
				}
			}
		}

		//Value conflicts: same leaf, not shielded by the host, different values.
		for (const [p, v] of contrib.leaves) {
			if (!targetContrib.leaves.has(p))
				continue;
			if (getDeepProperty(hostNode, p) !== undefined)
				continue; //host defines it — host wins in every order

			if (contrib.hasMorph || targetContrib.hasMorph)
				return { conflict: `overlapping path "${p}" with a morph-prps trait (values unknowable)`, warnings };

			if (!deepEqual(v, targetContrib.leaves.get(p)))
				return { conflict: `differing value at "${p}" vs preceding trait "${ref ?? '(inline)'}"`, warnings };
		}

		//Shared concatenating array props: order changes — waived, but recorded.
		for (const p of contrib.arrayProps) {
			if (targetContrib.arrayProps.has(p))
				warnings.push(`runtime prps.${p} order changed relative to "${ref ?? '(inline)'}"`);
		}
	}

	return { conflict: null, warnings };
};

//A wildcard whose root prp is bound to a runtime placeholder ({{…}}/((…))) and is
// DEEP-accessed (%prp.path%/$prp.path$, i.e. with a dot) can't resolve when inlined.
// Live, the repeater/state engine substitutes the placeholder into a real value
// BEFORE the trait is applied per row, so the deep access then resolves; inlined,
// the trait is gone and the engine only substitutes {{}}/(()) accessors. Depending
// on the shape the wildcard is either frozen as dead "%…%" text (embedded — e.g. a
// label cpt showing "%rowData.parent.cns_hed_cde%") or DELETED outright (whole-value
// — deletePrpIfMissing drops the key, e.g. "cpt": "%rowData.heading%" vanishes and
// the label goes blank). Both are wrong once inlined, so this is scanned on the RAW
// body BEFORE substitution (the delete case leaves no residue to find afterwards).
// Fail closed: keep the trait live (skip the merge).
const hasPlaceholderDeepAccess = (node, prps) => {
	const rootIsPlaceholderBound = token => {
		const root = token.split('.')[0];
		const bound = prps[root];
		return typeof bound === 'string' && /\{\{|\(\(/.test(bound);
	};
	const scanStr = s => {
		const re = /%([A-Za-z_][\w.]*)%|\$([A-Za-z_][\w.]*)\$/g;
		let m;
		while ((m = re.exec(s)) !== null) {
			const token = m[1] ?? m[2];
			if (token.includes('.') && rootIsPlaceholderBound(token))
				return true;
		}
		return false;
	};
	const walk = v => {
		if (typeof v === 'string')
			return scanStr(v);
		if (Array.isArray(v))
			return v.some(walk);
		if (v !== null && typeof v === 'object')
			return Object.keys(v).some(scanStr) || Object.values(v).some(walk);
		return false;
	};
	return walk(node);
};

//---------------------------------------------------------------- prepare + apply
/*
	prepareTrait: the static equivalent of applyTraitProps (traitManager.js) — loads
	a trait file, rewrites its relative refs, applies traitPrps defaults, substitutes
	%x%/$x$ and splits off the root-level nested traits. Shared between the actual
	merge and the preceding-trait conflict analysis, so both see identical semantics.

	Returns { trait, hoisted, hasMorph, missingRequired } or { unparseable, reason }.
	On missingRequired the body is returned UNSUBSTITUTED — that is what the runtime
	merges too (applyTraitProps returns early but combineTraitAndMda still runs).
*/
const prepareBody = (trait, entryObj, baseDir, ensemble, warnings, hostSpec) => {
	const spec = trait.acceptPrps;
	if (!spec || typeof spec !== 'object')
		return { unparseable: true, reason: 'no object acceptPrps' };

	const hasMorph = Object.values(spec).some(v => v && typeof v === 'object' && v.morph === true);
	const traitPrps = deepClone(entryObj.traitPrps ?? {});

	//Rewrite the trait body's relative refs BEFORE prp substitution (traitPrps values
	// coming from the host are host-relative already and must not be rewritten).
	rewriteRelativeRefs(trait, baseDir, ensemble, warnings);

	delete trait.acceptPrps;
	applyPrpDefaults(traitPrps, spec);

	const ignoreUndefinedPrps = trait.traitConfig?.ignoreUndefinedPrps ?? false;
	delete trait.traitConfig;

	const recurseConfig = { traitPrpSpec: spec, ignoreUndefinedPrps };

	//Self-substitution: values chaining to HOST acceptPrps stay raw (hostSpec guard) —
	// the body pass below must NOT get hostSpec (body tokens resolve against the
	// trait's OWN prps only, exactly like the runtime).
	const selfConfig = { traitPrpSpec: spec, ignoreUndefinedPrps, hostSpec };

	recursivelyApplyValuePrps(traitPrps, traitPrps, selfConfig);
	recursivelyApplyKeyPrps(traitPrps, traitPrps, selfConfig);

	const missing = findMissingPrps(traitPrps, spec);
	const missingRequired = missing.length ? missing : null;

	if (!missingRequired && !hasMorph) {
		//Fail closed on placeholder-bound deep wildcards (see hasPlaceholderDeepAccess):
		// checked on the RAW body, since the whole-value shape gets DELETED by the
		// substitution below and would leave nothing to detect afterwards.
		if (hasPlaceholderDeepAccess(trait, traitPrps))
			return { unparseable: true, reason: 'trait-prp bound to a runtime placeholder ({{…}}/((…))) is deep-accessed via %prp.path% — inlining would freeze or drop the wildcard' };

		recursivelyApplyValuePrps(trait, traitPrps, recurseConfig);
		recursivelyApplyKeyPrps(trait, traitPrps, recurseConfig);
	}

	const hoisted = Array.isArray(trait.traits) ? trait.traits : [];
	delete trait.traits;

	return { trait, hoisted, hasMorph, missingRequired };
};

const prepareTrait = (traitFile, entryObj, warnings, hostSpec) => {
	let trait;
	try {
		trait = JSON.parse(fs.readFileSync(traitFile.path, 'utf-8').replace(/^﻿/, ''));
	} catch {
		return { unparseable: true, reason: 'trait file is not valid JSON' };
	}

	return prepareBody(trait, entryObj, path.dirname(traitFile.path), traitFile.ensemble, warnings, hostSpec);
};

//Inline trait objects: traits: [{ type: { acceptPrps: {}, ... }, traitPrps }]
const prepareInlineTrait = (typeObj, entryObj, hostAbsPath, hostEnsemble, hostSpec) => {
	return prepareBody(deepClone(typeObj), entryObj, path.dirname(hostAbsPath), hostEnsemble, [], hostSpec);
};

/*
	applyPrepared: the static equivalent of the rest of applyTraits — auth deletion,
	hoisting the nested root traits into the host's traits array, traitArray splice,
	and combineTraitAndMda.
	Returns { ok: true } or { ok: false, reason }.
*/
const applyPrepared = ({ hostNode, entryIdx, prepared, parentArray, parentIndex }) => {
	const entry = hostNode.traits[entryIdx];
	const entryObj = typeof entry === 'object' ? entry : {};
	const { trait, hoisted } = prepared;

	//--- nested root traits: hoisted into the host's traits array (order-equivalent),
	// except conditional ones whose evaluation context would change.
	if (hoisted.some(t => t && typeof t === 'object' && t.condition))
		return { ok: false, reason: 'trait has conditional nested traits (condition context would change)' };

	//--- traitArray: the referencing array item gets REPLACED by the trait contents.
	if (trait.traitArray !== undefined) {
		if (!Array.isArray(trait.traitArray))
			return { ok: false, reason: 'traitArray is not an array' };
		if (!parentArray)
			return { ok: false, reason: 'traitArray trait used on a non-array-element node' };
		if (hostNode.traits.length !== 1)
			return { ok: false, reason: 'traitArray trait shares its node with other trait entries' };
		if (hoisted.length)
			return { ok: false, reason: 'traitArray trait also has nested root traits' };

		parentArray.splice(parentIndex, 1, ...trait.traitArray);
		return { ok: true };
	}

	//--- auth: fields deleted from the host node before the merge (traitManager order)
	if (Array.isArray(entryObj.auth))
		deleteAuthFields(hostNode, entryObj.auth);

	//--- replace the entry with the hoisted nested traits, then combine
	hostNode.traits.splice(entryIdx, 1, ...hoisted);
	if (!hostNode.traits.length)
		delete hostNode.traits;

	combineTraitAndMda(hostNode, trait);

	return { ok: true };
};

//---------------------------------------------------------------- doc walking
//Find every traits array whose entries include a ref string equal to `refStr`,
// with parent-array context. Returns [{ node, entryIdx, parentArray, parentIndex }].
const findTraitEntries = (doc, refStr) => {
	const found = [];

	const walk = (node, parentArray, parentIndex) => {
		if (Array.isArray(node)) {
			node.forEach((v, i) => {
				if (v !== null && typeof v === 'object')
					walk(v, node, i);
			});
			return;
		}
		if (node === null || typeof node !== 'object')
			return;

		/*
			A `traits` array is only a component trait APPLICATION when the node
			looks like a component or action. Data payloads can carry `traits` keys
			too (grid COLUMN definitions hold cell-trait lists consumed later via
			"$columnConfig.traits$") — inlining into those destroys the data.
		*/
		const isComponentContext =
			node.type !== undefined || node.wgts !== undefined || node.prps !== undefined ||
			node.id !== undefined || node.relId !== undefined || node.scope !== undefined ||
			node.acceptPrps !== undefined || node.condition !== undefined;

		if (Array.isArray(node.traits) && isComponentContext) {
			node.traits.forEach((t, i) => {
				const ref = typeof t === 'string' ? t : (typeof t?.trait === 'string' ? t.trait : null);
				if (ref === refStr)
					found.push({ node, entryIdx: i, parentArray, parentIndex });
			});
		}

		for (const v of Object.values(node)) {
			if (v !== null && typeof v === 'object')
				walk(v, null, -1);
		}
	};

	walk(doc, null, -1);
	return found;
};

//---------------------------------------------------------------- pass runner
const backupFile = (absPath, subdir) => {
	const dest = path.join(BACKUP, subdir, rel(absPath));
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	if (!fs.existsSync(dest))
		fs.copyFileSync(absPath, dest);
	return dest;
};

const writeDoc = (absPath, doc) => {
	fs.writeFileSync(absPath, JSON.stringify(doc, null, '\t'));
};

const allMerged = [];
const allSkipped = [];
let pass = 0;

for (pass = 1; pass <= MAX_PASSES; pass++) {
	const passScanner = pass === 1 ? scanner : createScanner({ appDir: resolveAppDir(args) });
	const { traitFiles, refsTo } = computeTraitRefs(passScanner, { entrypointsPath: epPath, field: args.field });

	const singleUse = [];
	for (const [k, f] of traitFiles) {
		const refs = refsTo.get(k) ?? [];
		if (refs.length === 1)
			singleUse.push({ traitKey: k, trait: f, ref: refs[0] });
	}

	//Traits being merged (and thus deleted) this pass — a trait whose single ref
	// lives inside one of these files must wait for the next pass.
	const mergingAway = new Set();
	const docs = new Map();       //hostKey -> parsed doc
	const dirtyHosts = new Set();
	const passMerged = [];
	const passSkipped = [];

	const skip = (t, reason) => passSkipped.push({ trait: t.trait.relPath, host: t.ref.referrer, reason });

	//Deterministic order
	singleUse.sort((a, b) => a.trait.relPath.localeCompare(b.trait.relPath));

	for (const t of singleUse) {
		if (ONLY && !ONLY.has(t.trait.relPath))
			continue;

		const { trait, ref } = t;

		if (ref.referrer === '(menu dataset)') {
			skip(t, 'only reference is a menu dataset entry (cannot inline)');
			continue;
		}
		if (ref.via.endsWith('(dynamic)')) {
			skip(t, 'only reference is dynamic (template/wildcard)');
			continue;
		}
		const referrerFile = files.get(key(ref.referrerPath)) ?? passScanner.files.get(passScanner.key(ref.referrerPath));
		if (!referrerFile || referrerFile.kind !== 'json') {
			skip(t, 'only reference is in JS/JSX code (mda built at runtime — cannot inline)');
			continue;
		}
		if (trait.isTheme || referrerFile.isTheme) {
			skip(t, 'theme/config file involved');
			continue;
		}
		if (mergingAway.has(passScanner.key(ref.referrerPath))) {
			skip(t, 'host is itself being merged away this pass (retried next pass)');
			continue;
		}

		//The mirror case: this trait's file received a merge earlier in this pass
		// (it is a dirty host). Reading it from disk as a merge SOURCE would use the
		// stale pre-merge content and leave the just-merged ref dangling.
		if (dirtyHosts.has(t.traitKey)) {
			skip(t, 'trait file was modified this pass (retried next pass)');
			continue;
		}

		//Load (cached) host doc
		const hostKey = passScanner.key(ref.referrerPath);
		let doc = docs.get(hostKey);
		if (doc === undefined) {
			try {
				doc = JSON.parse(fs.readFileSync(ref.referrerPath, 'utf-8').replace(/^﻿/, ''));
			} catch {
				skip(t, 'host file is not valid JSON');
				continue;
			}
			docs.set(hostKey, doc);
		}

		//Locate the entry — it must be a traits-array element whose path resolves
		// directly (no fuzzy) to this trait file.
		const rawRef = ref.via;
		const candidates = findTraitEntries(doc, rawRef)
			.filter(c => {
				const abs = resolveTraitRef(rawRef, ref.referrerPath);
				return abs && passScanner.key(abs) === t.traitKey;
			});

		if (candidates.length === 0) {
			skip(t, 'reference is not a traits-array entry (viewport value / traitDataManager / script usage)');
			continue;
		}
		if (candidates.length > 1) {
			skip(t, 'reference string appears in multiple traits arrays (ambiguous)');
			continue;
		}

		const site = candidates[0];
		const entry = site.node.traits[site.entryIdx];

		if (entry && typeof entry === 'object' && entry.condition) {
			skip(t, 'trait entry has a runtime condition');
			continue;
		}

		//Prepare the target trait (loads, rewrites relative refs, substitutes prps).
		//hostSpec: the host's own acceptPrps — entry traitPrps chaining to these
		// resolve at runtime when the host itself is applied, so they stay raw.
		const hostSpec = doc && typeof doc.acceptPrps === 'object' ? doc.acceptPrps : undefined;
		const warnings = [];
		const prepared = prepareTrait(trait, typeof entry === 'object' && entry !== null ? entry : {}, warnings, hostSpec);

		if (prepared.unparseable) {
			skip(t, prepared.reason);
			continue;
		}
		if (prepared.hasMorph) {
			skip(t, 'trait has morph:true acceptPrps (runtime state morphing)');
			continue;
		}
		if (prepared.missingRequired) {
			skip(t, `missing required traitPrps (${prepared.missingRequired.join(', ')}) — runtime merges it unsubstituted (authoring bug)`);
			continue;
		}

		//Order safety: non-first entries only block on genuine value conflicts with
		// preceding traits (scps/flows/scope ORDER is waived — recorded as warnings).
		if (site.entryIdx > 0) {
			const targetContrib = leafContribution(prepared, trait.path, trait.ensemble, hostSpec);
			const { conflict, warnings: orderWarnings } = orderConflict(
				site.node.traits.slice(0, site.entryIdx),
				targetContrib,
				site.node,
				ref.referrerPath,
				referrerFile.ensemble,
				hostSpec
			);
			if (conflict) {
				skip(t, `not first in traits array: ${conflict}`);
				continue;
			}
			warnings.push(...orderWarnings);
		}

		const res = applyPrepared({
			hostNode: site.node,
			entryIdx: site.entryIdx,
			prepared,
			parentArray: site.parentArray,
			parentIndex: site.parentIndex
		});

		if (!res.ok) {
			skip(t, res.reason);
			continue;
		}

		mergingAway.add(t.traitKey);
		dirtyHosts.add(hostKey);
		passMerged.push({
			trait: trait.relPath,
			host: ref.referrer,
			entryIndex: site.entryIdx,
			via: rawRef,
			warnings: warnings.length ? warnings : undefined
		});
	}

	allMerged.push(...passMerged);
	allSkipped.push(...passSkipped);

	console.log(`Pass ${pass}: ${passMerged.length} merged, ${passSkipped.length} skipped${APPLY ? '' : ' (dry-run)'}`);

	if (!APPLY || passMerged.length === 0)
		break;

	//Write host files (backing up their pre-merge versions first), then move the
	// merged trait files to the backup folder.
	for (const hostKey of dirtyHosts) {
		const f = passScanner.files.get(hostKey);
		backupFile(f.path, 'originals');
		writeDoc(f.path, docs.get(hostKey));
	}

	for (const m of passMerged) {
		const abs = absFromRel(m.trait);
		const dest = path.join(BACKUP, 'traits', m.trait);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.renameSync(abs, dest);
	}
}

//---------------------------------------------------------------- report
const reasonCounts = {};
allSkipped.forEach(s => {
	const r = s.reason.replace(/\(.*?\)/g, '').trim();
	reasonCounts[r] = (reasonCounts[r] ?? 0) + 1;
});

console.log(`\n================ Merge summary (${APPLY ? 'APPLIED' : 'DRY-RUN'}) ================\n`);
console.log(`  Merged:  ${allMerged.length} traits inlined into their single use location`);
console.log(`  Skipped: ${allSkipped.length}`);
Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]).forEach(([r, n]) => {
	console.log(`    ${String(n).padStart(5)}  ${r}`);
});

if (APPLY && allMerged.length) {
	const manifestPath = path.join(BACKUP, 'merge-manifest.json');
	let prior = [];
	try {
		prior = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')).merged ?? [];
	} catch {}
	fs.mkdirSync(BACKUP, { recursive: true });
	fs.writeFileSync(manifestPath, JSON.stringify({
		lastRun: new Date().toISOString(),
		merged: [...prior, ...allMerged]
	}, null, '\t'));
	console.log(`\n  Backups: ${BACKUP}`);
	console.log('    traits/     — the merged (now removed) trait files');
	console.log('    originals/  — pre-merge versions of every modified host file (first version per run)');
}

const reportPath = path.join(OUT_DIR, 'merge-report.json');
fs.writeFileSync(reportPath, JSON.stringify({
	generatedAt: new Date().toISOString(),
	mode: APPLY ? 'apply' : 'dry-run',
	passes: pass,
	merged: allMerged,
	skipped: allSkipped
}, null, '\t'));

console.log(`\n  Report: ${reportPath}`);
if (!APPLY)
	console.log('  Dry-run only — pass --apply to perform the merges. Further passes may unlock more merges.\n');
