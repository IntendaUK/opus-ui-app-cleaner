/* eslint-disable max-lines */

/*
	script-codegen — transpiles Opus UI declarative script actions to srcAction JS.

	Semantics replicated from opus-ui/src/components/scriptRunner (morphConfig.js,
	processAction.js, actions.js, actions/*.js):
	  - accessors: {{[scriptId.]state|variable|eval.…}} whole-value typed replace,
	    ((…)) / embedded {{…}} in-string splice (embedded {{}} JSON.stringifies),
	    ||scope.relId|| tokens, drilling rules (nested objects only convert
	    scriptId-prefixed accessors; ^-keys force drilling)
	  - per-action morphing happens at execution time → generated reads happen at
	    the same points
	  - actionCondition, branch (result-string keyed; stopScript stops only its own
	    action list — emitted as labeled-block breaks), storeAsVariable/pushToVariable
	  - comparison operators inlined with the exact opus semantics

	VARIABLES become plain JS variables (`let baseUrl = '…';`) — reads use the
	identifier, deleteVariable assigns undefined, pushVariable/setVariableKey mutate
	in place. The engine store is only touched at delegation boundaries: before a
	delegated runScript batch (or morph() fallback) every referenced local is synced
	in with setVariable, and after the batch every name the batch can mutate is
	synced back with getVariable. Variables the script only READS (trigger-set
	snapshot-* etc.) stay engine reads.

	Anything not natively translatable delegates:
	await runScript({ id, ownerId, actions: [raw] }).

	Output: { code, stats: { native, delegated, morphFallbacks }, skip? }
*/

const { prepareTraitArray } = require('./trait-prepare');

const NATIVE_TYPES = new Set([
	'setState', 'setMultiState', 'getState',
	'setVariable', 'setVariables', 'deleteVariable', 'deleteVariables',
	'pushVariable', 'popVariable', 'setVariableKey', 'deleteVariableKey',
	'applyComparison', 'stopScript', 'wait', 'log', 'clone', 'parseJson',
	'morphEntries', 'morphKeys', 'morphValues', 'morphFromEntries',
	'morphTypeOf', 'morphKeyPath', 'morphObject', 'joinArray', 'generateGuid',
	'morphIterateArray', 'findInArray', 'mapArray', 'findIndexInArray', 'filterArray',
	'showNotification', 'setTagState', 'createFlow', 'waitForCondition',
	'queryUrl', 'queryGateway', 'performRequest',
	'queueDelayedActions', 'cancelDelayedActions', 'queueIntervalActions', 'cancelIntervalActions',
	'getComponentHeight', 'getComponentWidth', 'getComponentPosition',
	'scrollComponent', 'scrollToComponent', 'openUrl', 'openLinkInTab',
	'stringify', 'splitString', 'resolveScopedId'
]);

const NET_IMPORT = 'import * as __net from \'@l2_util/scriptHelpers/net\';';

const VARIABLE_SET_TYPES = new Set([
	'setVariable', 'setVariables', 'deleteVariable', 'deleteVariables',
	'pushVariable', 'popVariable', 'setVariableKey'
]);

const HELPERS = {
	__isNil: 'const __isNil = v => v === null || v === undefined;',
	__toStr: 'const __toStr = v => __isNil(v) ? \'\' : String(v);',
	__toLower: 'const __toLower = v => __toStr(v).toLowerCase();',
	__toNum: 'const __toNum = v => { const n = parseFloat(v); return Number.isNaN(n) ? undefined : n; };',
	__isEqual: 'const __isEqual = (a, b) => (__isNil(a) || __isNil(b)) ? a === b : __toLower(a) === __toLower(b);',
	__isFalsy: 'const __isFalsy = a => a === null || a === undefined || a === \'\' || a === 0 || a === false;',
	__cmpNum: 'const __cmpNum = (a, b, f) => { const na = __toNum(a), nb = __toNum(b); return (na === undefined || nb === undefined) ? false : f(na, nb); };',
	__contains: 'const __contains = (a, b) => (__isNil(a) || __isNil(b)) ? false : __toLower(a).includes(__toLower(b));',
	__deepClone: 'const __deepClone = v => { if (v === null || typeof v !== \'object\') return v; const r = Array.isArray(v) ? [] : {}; for (const k in v) r[k] = __deepClone(v[k]); return r; };',
	__sleep: 'const __sleep = ms => new Promise(res => setTimeout(res, ms));',
	__deep: 'const __deep = (v, p) => { for (const s of String(p).split(\'.\')) { if (v === null || v === undefined) return v; v = s === \'last\' && Array.isArray(v) ? v[v.length - 1] : v[s]; } return v; };',
	__setKey: 'const __setKey = (o, p, v) => { const parts = String(p).split(\'.\'); const last = parts.pop(); let t = o; for (const s of parts) { if (t === null || t === undefined) return; t = t[s]; } if (t !== null && t !== undefined) t[last] = v; };',
	__delKey: 'const __delKey = (o, p) => { const parts = String(p).split(\'.\'); const last = parts.pop(); let t = o; for (const s of parts) { if (t === null || t === undefined) return; t = t[s]; } if (t !== null && t !== undefined) delete t[last]; };',
	__buildMsg: 'const __buildMsg = c => ({ msg: c.msg, type: c.msgType ?? \'info\', autoClose: c.autoClose ?? true, isGlobal: c.isGlobal ?? false, duration: c.duration });',
	__absPos: 'const __absPos = n => { let left = n.offsetLeft, top = n.offsetTop; if (getComputedStyle(n).position !== \'absolute\') { let p = n.offsetParent; while (p) { left += p.offsetLeft; top += p.offsetTop; if (getComputedStyle(p).position === \'absolute\') break; p = p.offsetParent; } } return { left, right: left + n.offsetWidth, top, bottom: top + n.offsetHeight, width: n.offsetWidth, height: n.offsetHeight }; };',
	__tryEval: 'const __tryEval = f => { try { return f(); } catch (e) { console.error(\'Evaluation crashed\', e); } };',
	//Trait-prp wildcard splices (engine getMorphedString/getVariableValue semantics:
	// undefined prp keeps the raw wildcard text; %-form text-splices with array
	// join(\' \'); $-form embeds JSON (string arrays join), chained wildcards raw).
	__wjoin: 'const __wjoin = (v, raw) => v === undefined ? raw : (Array.isArray(v) ? v.join(\' \') : String(v));',
	__wdirect: 'const __wdirect = (v, raw) => { if (v === undefined) return raw; if (typeof v === \'string\' && /^[%$][\\w.]+[%$]$/.test(v)) return v; if (Array.isArray(v) && v.every(x => typeof x === \'string\')) return JSON.stringify(v.join(\' \')); const o = JSON.stringify(v); return o === undefined ? raw : o; };',
	__wval: 'const __wval = (v, raw) => v === undefined ? raw : v;',
	//%x%/$x$ used in eval CODE position: the runtime spliced the value as text then
	// eval-parsed it, so a scalar string ("3", "true") must parse back to its value.
	__wcode: 'const __wcode = (v, raw) => { const s = v === undefined ? raw : v; if (typeof s !== \'string\') return s; try { return JSON.parse(s); } catch { return s; } };'
};

//Generated actions import these helpers from a shared l2_util module instead of
// inlining a copy of each one in every file. convert-scripts deposits the module
// (buildHelperModule) on --apply; the assembled file emits a named import of only
// the helpers it uses.
const HELPER_MODULE = '@l2_util/scriptHelpers/codegen';

//The shared module's source, GENERATED from HELPERS so the two can never drift.
// Helpers are arrow fns that reference each other only at call time, so plain
// declaration order (dependencies first, as in HELPERS) is safe for the exports.
const buildHelperModule = () =>
	'/*\n' +
	'\tShared runtime helpers for converted source actions. GENERATED by\n' +
	'\topus-ui-app-cleaner (script-codegen HELPERS) and re-deposited on every\n' +
	'\t--apply — do not edit by hand.\n\n' +
	'\tNOTE: this file must be COMMITTED to l2_util — generated actions import it,\n' +
	'\tand an untracked copy gets wiped by git clean.\n' +
	'*/\n\n' +
	Object.values(HELPERS).map(def => def.replace(/^const /, 'export const ')).join('\n') +
	'\n';

const OPERATOR_EXPR = {
	isEqual: (a, b) => `__isEqual(${a}, ${b})`,
	isEqualCase: (a, b) => `(${a}) === (${b})`,
	isNotEqual: (a, b) => `!__isEqual(${a}, ${b})`,
	isTruthy: a => `!__isFalsy(${a})`,
	isNotTruthy: a => `__isFalsy(${a})`,
	isFalsy: a => `__isFalsy(${a})`,
	isNotFalsy: a => `!__isFalsy(${a})`,
	isGreaterThan: (a, b) => `__cmpNum(${a}, ${b}, (x, y) => x > y)`,
	isGreaterEqualThan: (a, b) => `__cmpNum(${a}, ${b}, (x, y) => x >= y)`,
	isLessThan: (a, b) => `__cmpNum(${a}, ${b}, (x, y) => x < y)`,
	isLessEqualThan: (a, b) => `__cmpNum(${a}, ${b}, (x, y) => x <= y)`,
	doesContain: (a, b) => `__contains(${a}, ${b})`,
	doesNotContain: (a, b) => `!__contains(${a}, ${b})`,
	containedIn: (a, b) => `__contains(${b}, ${a})`,
	notContainedIn: (a, b) => `!__contains(${b}, ${a})`
};

const CMP_HELPERS = ['__isNil', '__toStr', '__toLower', '__isEqual', '__isFalsy', '__toNum', '__cmpNum', '__contains'];

const JS_IDENT = /^[A-Za-z_$][\w$]*$/;
const RESERVED = new Set([
	'script', 'config', 'ownerId', 'scriptId', 'triggeredFrom', 'morph', 'resolveId',
	'getState', 'setState', 'getExternalState', 'setExternalState', 'getVariable', 'theme', 'getIdsWithTag', 'createFlow',
	'setVariable', 'runScript', 'let', 'const', 'var', 'return', 'if', 'else', 'for',
	'while', 'break', 'continue', 'new', 'function', 'async', 'await', 'true', 'false',
	'null', 'undefined', 'this', 'class', 'switch', 'case', 'default', 'delete', 'in', 'of'
]);

const SCOPED_TOKEN = /\|\|[\w.$%/-]+\|\|/g;

//Trait-prp wildcards (%x% morph / $x$ direct). Substituted at trait-application
// time — a static JS file can't receive per-application values, so each span is
// extracted VERBATIM into the emitted action's __traitParams (where the trait
// engine keeps substituting it) and the JS reads config.__traitParams.<name>.
const WILDCARD_SPAN = /%[A-Za-z_][\w.]*%|\$[A-Za-z_][\w.]*\$/g;
const WILDCARD_WHOLE = /^(?:%[A-Za-z_][\w.]*%|\$[A-Za-z_][\w.]*\$)$/;
const hasWildcard = s => {
	WILDCARD_SPAN.lastIndex = 0;
	return WILDCARD_SPAN.test(s);
};

class SkipScript extends Error {}

class Codegen {
	constructor ({ scriptId, traitResolver, ensembles, syncVars }) {
		this.scriptId = scriptId;
		this.traitResolver = traitResolver ?? null;
		this.ensembles = ensembles ?? [];
		//Variable names OTHER scripts read via {{x.scopedVariable.<thisId>.<name>}}.
		// Writes to these must also hit the engine store (setVariable interface) or
		// the cross-script reads silently break — locals are invisible to the engine.
		this.syncVars = syncVars ?? new Set();

		//Repeater rowMda placeholders (((rowData.x)) etc.) found in this script:
		// verbatim span text -> config param name. The converter re-emits each span
		// under the action's __rowParams so it STAYS in the JSON where the repeater's
		// per-row clone substitutes it; generated JS reads the substituted value from
		// config.__rowParams at run time.
		this.rowParams = new Map();

		//Trait-prp wildcards (%x%/$x$) found in this script: verbatim span ->
		// config param name, emitted under the action's __traitParams (same
		// mechanism as rowParams — the trait engine substitutes the JSON).
		this.traitParams = new Map();
		this.flattenStack = [];
		this.helpers = new Set();
		this.imports = new Set(); //module import lines
		this.stats = { native: 0, delegated: 0, morphFallbacks: 0, flattenedTraits: 0 };
		this.tempCount = 0;
		this.usesArgs = new Set();

		//Literal-variable state: name -> { ident, declared: bool }
		this.locals = new Map();
		this.hoisted = [];        //lines like 'let x = getVariable(\'x\');' or 'let y;'
		this.inlinePlan = new Set(); //names whose FIRST event is a top-level set → inline `let x = …;`
		this.usedIdents = new Set();
	}

	temp (prefix = '__t') {
		return `${prefix}${++this.tempCount}`;
	}

	use (name) {
		this.usesArgs.add(name);
	}

	helper (...names) {
		names.forEach(n => this.helpers.add(n));
	}

	identFor (name) {
		const existing = this.locals.get(name);
		if (existing)
			return existing.ident;

		let ident = String(name).replace(/[^\w$]/g, '_');
		if (!JS_IDENT.test(ident) || RESERVED.has(ident) || this.usedIdents.has(ident))
			ident = `v_${ident}`;
		while (this.usedIdents.has(ident))
			ident += '_';
		this.usedIdents.add(ident);

		this.locals.set(name, { ident, declared: false });
		return ident;
	}

	//Marks a name local, hoisting a declaration unless it is inline-planned.
	ensureLocal (name, { engineInit = false } = {}) {
		const had = this.locals.has(name);
		const ident = this.identFor(name);
		const entry = this.locals.get(name);

		if (!entry.declared && !this.inlinePlan.has(name)) {
			entry.declared = true;
			if (engineInit) {
				this.use('getVariable');
				this.hoisted.push(`let ${ident} = getVariable(${JSON.stringify(name)});`);
			} else
				this.hoisted.push(`let ${ident};`);
		}

		return { ident, isNew: !had };
	}

	//Zero-delegation: what used to fall back to the engine's morph() now aborts
	// the script conversion (fn.* accessors, scopedVariable, unparseable evals).
	morphFallback (raw) {
		throw new SkipScript(`accessor not convertible to vanilla JS: ${String(raw).slice(0, 80)}`);
	}

	/*
		Repeater placeholder span -> config.__rowParams access, or null.
		{{...}} whole-value form is only substituted by the repeater's directReplace
		for row* roots (its checker is the literal '{{row'), so parentId is only
		valid in the ((...)) string-splice form — same as declarative behavior.
	*/
	rowParamExpr (sp, spanText) {
		const roots = sp.open === '(('
			? /^(?:rowData|rowNumber|rowDataConcat|rowPrps|parentId)(?:\.[\w$-]+)*$/
			: /^(?:rowData|rowNumber|rowDataConcat|rowPrps)(?:\.[\w$-]+)*$/;
		if (!roots.test(sp.inner))
			return null;

		let name = this.rowParams.get(spanText);
		if (!name) {
			name = sp.inner.replace(/[^\w$]/g, '_') + (sp.open === '{{' ? '_v' : '');
			while ([...this.rowParams.values()].includes(name))
				name += '_';
			this.rowParams.set(spanText, name);
		}
		this.use('config');
		return `config.__rowParams.${name}`;
	}

	//Trait-prp wildcard span -> config.__traitParams access.
	traitParamExpr (spanText) {
		let name = this.traitParams.get(spanText);
		if (!name) {
			name = spanText.slice(1, -1).replace(/[^\w$]/g, '_') + (spanText[0] === '$' ? '_d' : '');
			while ([...this.traitParams.values()].includes(name))
				name += '_';
			this.traitParams.set(spanText, name);
		}
		this.use('config');
		return `config.__traitParams.${name}`;
	}

	/*
		Escapes a raw literal text segment for a template literal, splicing the two
		TEXT-substitution layers the engine ran over raw strings:
		  - ||scoped.id|| tokens -> resolveId(...) (wildcards INSIDE a token splice
		    into the token text first — the trait engine substituted them there);
		  - %x%/$x$ trait-prp wildcards -> __traitParams splices (engine morph
		    semantics: %-form text splice, $-form embedded JSON).
		Spliced ${…} expressions are never post-processed.
	*/
	litSegment (raw, { keepTheme = false } = {}) {
		const esc = x => {
			let e = x.replace(/[`\\$]/g, c => '\\' + c);
			if (keepTheme)
				e = e.replace(/\\\$\\\{theme\./g, '${theme.');
			return e;
		};

		const wildcardSplice = t => {
			if (t[0] === '$') {
				this.helper('__wdirect');
				return '${__wdirect(' + this.traitParamExpr(t) + ', ' + JSON.stringify(t) + ')}';
			}
			this.helper('__wjoin');
			return '${__wjoin(' + this.traitParamExpr(t) + ', ' + JSON.stringify(t) + ')}';
		};

		const combined = new RegExp(`${SCOPED_TOKEN.source}|${WILDCARD_SPAN.source}`, 'g');
		let out = '';
		let last = 0;
		for (const m of raw.matchAll(combined)) {
			out += esc(raw.slice(last, m.index));
			const t = m[0];
			if (t.startsWith('||')) {
				this.use('resolveId');
				if (hasWildcard(t)) {
					//Scoped token whose TEXT contains wildcards: build the token first.
					let inner = '';
					let p = 0;
					for (const w of t.matchAll(WILDCARD_SPAN)) {
						inner += esc(t.slice(p, w.index)) + wildcardSplice(w[0]);
						p = w.index + w[0].length;
					}
					inner += esc(t.slice(p));
					out += '${resolveId(`' + inner + '`)}';
				} else
					out += '${resolveId(' + JSON.stringify(t) + ')}';
			} else
				out += wildcardSplice(t);
			last = m.index + t.length;
		}
		out += esc(raw.slice(last));
		return out;
	}

	//---------------------------------------------------------- accessor parsing
	findAccessorSpans (s) {
		const spans = [];
		let i = 0;
		while (i < s.length - 1) {
			const open = s.substr(i, 2);
			if (open !== '{{' && open !== '((') {
				i++;
				continue;
			}
			const close = open === '{{' ? '}}' : '))';
			let depth = 1;
			let j = i + 2;
			while (j < s.length - 1 && depth > 0) {
				const c = s.substr(j, 2);
				if (c === open) {
					depth++;
					j += 2;
				} else if (c === close) {
					depth--;
					j += 2;
				} else
					j++;
			}
			if (depth === 0) {
				spans.push({ start: i, end: j, open, inner: s.slice(i + 2, j - 2) });
				i = j;
			} else
				i += 2;
		}
		return spans;
	}

	accessorExpr (inner, ctx, rawWithDelims) {
		let tokens = inner;

		let prefixed = false;
		for (const sid of ctx.scopeIds) {
			if (tokens.startsWith(sid + '.')) {
				tokens = tokens.slice(sid.length + 1);
				prefixed = true;
				break;
			}
		}

		const type = tokens.split('.')[0];
		if (!['variable', 'scopedVariable', 'state', 'eval', 'fn'].includes(type))
			return null;

		if (!prefixed && !ctx.drilled)
			return null;

		const rest = tokens.slice(type.length + 1);

		//Trait-prp wildcards INSIDE accessor grammar (component ids, variable
		// names, drill paths) aren't expressible as config params — fail closed
		// rather than freeze the wildcard text into the accessor.
		if (type !== 'eval' && hasWildcard(rest))
			return this.morphFallback(rawWithDelims, ctx);

		if (type === 'variable') {
			//Dynamic drill-path segments ({{variable.records.((state.self.idx))}}):
			// the engine resolves inner accessors innermost-first, splicing their
			// values into the path text. Replicate with a template-literal path.
			let dynPathTpl = null;
			const pathSpans = this.findAccessorSpans(rest);
			if (pathSpans.length) {
				if (pathSpans[0].start === 0)
					return this.morphFallback(rawWithDelims, ctx); //dynamic variable NAME — unsupported
				const escPath = s => s.replace(/[`\\$]/g, x => '\\' + x);
				let tpl = '';
				let pos = 0;
				for (const sp of pathSpans) {
					const innerExpr = this.accessorExpr(sp.inner, { ...ctx, drilled: true }, rest.slice(sp.start, sp.end));
					if (innerExpr === null)
						return this.morphFallback(rawWithDelims, ctx);
					tpl += escPath(rest.slice(pos, sp.start)) + `\${String(${innerExpr})}`;
					pos = sp.end;
				}
				tpl += escPath(rest.slice(pos));
				dynPathTpl = tpl;
			}

			const staticPart = pathSpans.length ? rest.slice(0, pathSpans[0].start) : rest;
			const [name, ...subs] = staticPart.split('.');

			//Chain-scope locals (record/rowNum and chain-set vars) win first.
			const chainIdent = ctx.chainLocals?.get(name);
			let base;
			if (chainIdent)
				base = chainIdent;
			else if (this.locals.has(name))
				base = this.locals.get(name).ident;
			else {
				this.use('getVariable');
				base = `getVariable(${JSON.stringify(name)})`;
			}

			if (dynPathTpl !== null) {
				this.helper('__deep');
				//Drop the leading "name." from the template (name is plain text there).
				return `__deep(${base}, \`${dynPathTpl.slice(name.length + 1)}\`)`;
			}

			if (!subs.length)
				return base;
			this.helper('__deep');
			return `__deep(${base}, ${JSON.stringify(subs.join('.'))})`;
		}

		if (type === 'state') {
			let src = rest;
			let idExpr;
			if (src.startsWith('((')) {
				//Dynamic component id: {{state.((state.self.openTabId)).key}} — the
				// id is itself an accessor, resolved innermost-first at runtime.
				const sp = this.findAccessorSpans(src)[0];
				if (!sp || sp.start !== 0)
					return this.morphFallback(rawWithDelims, ctx);
				const innerExpr = this.accessorExpr(sp.inner, { ...ctx, drilled: true }, src.slice(0, sp.end));
				if (innerExpr === null)
					return this.morphFallback(rawWithDelims, ctx);
				idExpr = `String(${innerExpr})`;
				src = src.slice(sp.end + 1); //skip the '.' after '))'
			} else if (src.startsWith('||')) {
				const end = src.indexOf('||', 2);
				if (end === -1)
					return null;
				idExpr = JSON.stringify(src.slice(0, end + 2));
				src = src.slice(end + 3);
			} else {
				const dot = src.indexOf('.');
				const id = dot === -1 ? src : src.slice(0, dot);
				src = dot === -1 ? '' : src.slice(dot + 1);
				//Fail closed: an id segment still containing accessor syntax means an
				// unrecognized shape — skip the script rather than emit garbage.
				if (/[({]\(|\{\{|\)\)|\}\}/.test(id))
					return this.morphFallback(rawWithDelims, ctx);
				idExpr = id === 'self' ? null : JSON.stringify(id);
			}

			if (!src)
				return null;

			const base = idExpr === null
				? (this.use('getState'), '(getState() ?? {})')
				: (this.use('getExternalState'), `(getExternalState(${idExpr}) ?? {})`);

			//Dynamic key-path segments ({{state.||grid.dataManager||.fetchedData.
			// ((state.||entry||.index)).errormessage}}): the engine resolves inner
			// accessors innermost-first and splices their values into the path
			// text. Replicate with a template-literal path (same as the variable
			// branch); a failed inner resolution fails the whole script closed.
			if (/\(\(|\{\{/.test(src)) {
				const pathSpans = this.findAccessorSpans(src);
				if (!pathSpans.length || pathSpans[0].start === 0)
					return this.morphFallback(rawWithDelims, ctx);
				const escPath = x => x.replace(/[`\\$]/g, c => '\\' + c);
				let tpl = '';
				let pos = 0;
				for (const sp of pathSpans) {
					const innerExpr = this.accessorExpr(sp.inner, { ...ctx, drilled: true }, src.slice(sp.start, sp.end));
					if (innerExpr === null)
						return this.morphFallback(rawWithDelims, ctx);
					tpl += escPath(src.slice(pos, sp.start)) + `\${String(${innerExpr})}`;
					pos = sp.end;
				}
				tpl += escPath(src.slice(pos));
				this.helper('__deep');
				return `__deep(${base}, \`${tpl}\`)`;
			}

			const [key, ...subs] = src.split('.');
			const keyed = JS_IDENT.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;
			if (!subs.length)
				return keyed;
			this.helper('__deep');
			return `__deep(${keyed}, ${JSON.stringify(subs.join('.'))})`;
		}

		if (type === 'eval')
			return this.evalExpr(rest, ctx, rawWithDelims);

		//Theme-function accessors ({{fn.getMessage}}): the engine morphs the
		// PARENT object's fnArgs[<key>] and calls the registered function. The
		// fnArgs context is threaded per key by valueExpr/actionCfgExpr, with a
		// value-keyed fallback for generators that build configs manually.
		if (type === 'fn') {
			const fnName = rest.split('.')[0] || rest;
			const argsRaw = ctx.fnArgsRaw !== undefined ? ctx.fnArgsRaw : ctx.fnByValue?.get(rawWithDelims);
			if (argsRaw === undefined)
				return this.morphFallback(rawWithDelims, ctx);
			this.use('fn');
			return `fn(${JSON.stringify(fnName)}, ${this.valueExpr(argsRaw, { ...ctx, drilled: true, fnArgsRaw: undefined, fnByValue: undefined })})`;
		}

		return this.morphFallback(rawWithDelims, ctx);
	}

	evalExpr (body, ctx, rawWithDelims) {
		const spans = this.findAccessorSpans(body);
		const hasWildcards = hasWildcard(body);

		if (/[%$]\.\.\./.test(body))
			throw new SkipScript('spread trait-prp wildcard ($...x$) inside eval');

		/*
			Eval bodies containing accessors or theme refs replicate the runtime's
			TEXTUAL SPLICE exactly: the body becomes a JS template literal where
			((…)) splices the raw value, embedded {{…}} splices JSON.stringify of
			the value (morphConfig semantics — authors quote string accessors, so
			splicing must happen inside the text), ||…|| splices the resolved id,
			and {theme.x} text survives into the packaged string where
			applyThemesToMdaPackage resolves it at app boot. The template is then
			eval'd — the exact post-splice text the declarative engine evaluated.
		*/
		if (spans.length || hasWildcards) {
			//Names the eval body DECLARES as locals (const/let/var/function). A reference
			// to a script variable of the same name (e.g. `{{variable.result}}` while the
			// body also does `const result = {}`) would, once inlined into one scope, bind
			// to the not-yet-declared local — a TDZ crash. Such references are captured
			// into a unique temp BEFORE the body so they resolve to the outer value.
			const localDecls = new Set();
			for (const m of body.matchAll(/\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g))
				localDecls.add(m[1]);

			//Resolve each accessor span to its expression ONCE (accessorExpr mutates
			// ctx/helpers); both the inline attempt and the eval fallback reuse these.
			const accExpr = new Map();
			let shadowUnhoistable = false;
			for (const sp of spans) {
				const spanText = body.slice(sp.start, sp.end);
				let expr = this.accessorExpr(sp.inner, { ...ctx, drilled: true }, spanText) ?? this.rowParamExpr(sp, spanText);
				if (expr === null)
					return this.morphFallback(rawWithDelims, ctx);
				//Bare-identifier reads (script/chain locals) collide with an eval-body local
				// of the same name — hoist them out to a temp (or, if there's nowhere to
				// hoist, fall back to eval, whose value-splice reads the outer var before
				// the local shadows it).
				if (/^[A-Za-z_$][\w$]*$/.test(expr) && localDecls.has(expr)) {
					if (Array.isArray(ctx.pre)) {
						const t = this.temp('__ev');
						ctx.pre.push(`const ${t} = ${expr};`);
						expr = t;
					} else
						shadowUnhoistable = true;
				}
				accExpr.set(sp.start, expr);
			}

			//Preferred: emit REAL inline JS (no eval()). Theme refs resolve at app boot
			// from the packaged text, so those keep eval. buildInlineEvalCode substitutes
			// accessors AND trait-prp wildcards in the correct context — a span inside a
			// string literal reopens that literal as a template so the value interpolates
			// instead of landing as dead text — and returns null for shapes it won't risk
			// (a trait-prp wildcard in CODE position, an unterminated string). Both ((…))
			// and {{…}} become the VALUE (the runtime spliced the value as text then
			// eval-parsed it, round-tripping to the value). emitInlineEvalCode then
			// syntax-checks, so anything that won't parse falls through to eval below.
			if (!shadowUnhoistable) {
				const code = this.buildInlineEvalCode(body, spans, accExpr);
				if (code !== null) {
					const inlined = this.emitInlineEvalCode(code);
					if (inlined !== null)
						return inlined;
				}
			}

			//Fallback: replicate the runtime's TEXTUAL SPLICE + eval. ((…)) splices the
			// raw value, embedded {{…}} splices JSON.stringify of the value, ||…|| /
			// {theme.x} and trait-prp wildcards resolve in the LITERAL text (litSegment).
			const esc = s => this.litSegment(s, { keepTheme: true });
			let tpl = '';
			let pos = 0;
			for (const sp of spans) {
				tpl += esc(body.slice(pos, sp.start));
				tpl += sp.open === '((' ? '${' + accExpr.get(sp.start) + '}' : '${JSON.stringify(' + accExpr.get(sp.start) + ')}';
				pos = sp.end;
			}
			tpl += esc(body.slice(pos));

			this.helper('__tryEval');
			return '__tryEval(() => eval(`' + tpl + '`))';
		}

		//No accessor spans/theme/wildcards here — only scoped ids (||...||) or plain JS.
		// buildInlineEvalCode inlines both (scoped id -> resolveId); if it can't, fall
		// back to the runtime text-splice + eval via litSegment.
		const staticCode = this.buildInlineEvalCode(body, [], new Map());
		if (staticCode !== null) {
			const inlined = this.emitInlineEvalCode(staticCode);
			if (inlined !== null)
				return inlined;
		}

		this.helper('__tryEval');
		return '__tryEval(() => eval(`' + this.litSegment(body, { keepTheme: true }) + '`))';
	}

	//Wrap a fully-substituted JS body (accessors already replaced by expressions, no
	// eval-only theme/wildcard text) as `__tryEval(() => …)` — a single expression,
	// or a statement block ending in a returned expression. Syntax-checks the result:
	// raw ((…)) splices used as CODE text (dynamic identifiers or property paths)
	// yield invalid JS when inlined, so those return null and the caller falls back
	// to eval.
	emitInlineEvalCode (finalBody) {
		const bodyStr = finalBody.trim().replace(/;\s*$/, '');
		const segments = this.splitStatements(bodyStr).map(x => x.trim()).filter(Boolean);
		const isBlock = segments.length > 1 || /^(const|let|var|if|for|while|switch)\b/.test(bodyStr);

		let inner;
		if (isBlock) {
			const last = segments.pop();
			if (!last)
				return null;
			const stmts = segments.join('; ') + (segments.length ? '; ' : '');
			//A body ending in a STATEMENT (control flow / declaration / side-effect
			// assignment, e.g. "if (el) el.style.height = '5px'") has no result
			// expression to return — run it for effect (the IIFE yields undefined,
			// matching eval of a statement-ending body). `return` as the last segment
			// already carries its own value.
			inner = /^(const|let|var|if|for|while|switch|throw|try|do|function|break|continue|return)\b/.test(last)
				? `{ ${stmts}${last}; }`
				: `{ ${stmts}return ${last}; }`;
		} else
			inner = `(${bodyStr})`;

		try {
			//Syntax-only check — undefined interface refs (getState, resolveId, …) are
			// RUNTIME, not syntax, errors, so they don't trip this.
			// eslint-disable-next-line no-new-func
			new Function(isBlock ? inner : `return ${inner};`);
		} catch {
			return null;
		}

		//The runtime wrapped every eval in try/catch, but a single expression that
		// can't throw (no method call, `new`, or callback) doesn't need the __tryEval
		// wrapper — emit it bare. Blocks and call-bearing expressions keep the guard.
		const canThrow = isBlock || /\.\s*[A-Za-z_$][\w$]*\s*\(|\bnew\s|=>/.test(bodyStr);
		if (!canThrow)
			return inner;

		this.helper('__tryEval');
		return `__tryEval(() => ${inner})`;
	}

	//Build real inline JS from an eval body: accessor spans become their value
	// expressions and trait-prp wildcard spans become their __traitParams reads, each
	// spliced in the right context. A span inside a string literal reopens that literal
	// as a template literal (`) so the value interpolates rather than landing as dead
	// text (what the licence '((variable.baseUrl))' case needed). Returns null for
	// shapes not represented safely — a trait-prp wildcard in CODE position (text-splice
	// semantics unclear) or an unterminated string — so the caller keeps eval.
	buildInlineEvalCode (body, accSpans, accExpr) {
		//Collect every token span (earliest-wins, non-overlapping): accessors, then
		// trait-prp wildcards, scoped ids, theme refs. A match already inside another
		// span (e.g. a ||scope|| inside a {{...}} accessor) is dropped.
		const spanList = accSpans.map(sp => ({ start: sp.start, end: sp.end, kind: 'acc', expr: accExpr.get(sp.start) }));
		const addMatches = (re, kind) => {
			re.lastIndex = 0;
			let m;
			while ((m = re.exec(body)) !== null) {
				const s = m.index;
				if (!spanList.some(x => s >= x.start && s < x.end))
					spanList.push({ start: s, end: s + m[0].length, kind, tok: m[0] });
			}
		};
		addMatches(WILDCARD_SPAN, 'wild');
		addMatches(SCOPED_TOKEN, 'scoped');
		addMatches(/\{theme\.[\w./-]+\}/g, 'theme');
		spanList.sort((a, b) => a.start - b.start);
		const clean = [];
		let lastEnd = 0;
		for (const s of spanList) {
			if (s.start >= lastEnd) {
				clean.push(s);
				lastEnd = s.end;
			}
		}
		const spanAt = new Map(clean.map(s => [s.start, s]));

		//A token in CODE position becomes a value expression; in TEMPLATE position it
		// becomes a ${...} interpolation. %x% code-position parses the spliced scalar
		// (__wcode); %x%/$x$ in template text splice as string/JSON (__wjoin/__wdirect).
		const exprOf = (s, inTpl) => {
			if (s.kind === 'acc')
				return inTpl ? '${' + s.expr + '}' : `(${s.expr})`;
			if (s.kind === 'scoped') {
				this.use('resolveId');
				const r = `resolveId(${JSON.stringify(s.tok)})`;
				return inTpl ? '${' + r + '}' : r;
			}
			if (s.kind === 'theme') {
				this.use('theme');
				const r = `theme(${JSON.stringify(s.tok.slice(7, -1))})`;
				//In template position the call is parenthesised — `${(theme(…))}`, never
				// `${theme(…)}`. The bare form's `{theme(` substring collides with
				// opus-ui's boot-time theme-accessor regex ({theme.(.*?)}, whose `.`
				// matches the `(`); it would resolve the garbage token to undefined and
				// leave `$undefined` in the packaged text before the module is parsed.
				// The leading `(` breaks the `{theme` adjacency. (Template interiors are
				// opaque to formatCode, so this survives formatting verbatim.)
				return inTpl ? '${(' + r + ')}' : r;
			}
			const param = this.traitParamExpr(s.tok);
			if (inTpl) {
				if (s.tok[0] === '$') {
					this.helper('__wdirect');
					return '${__wdirect(' + param + ', ' + JSON.stringify(s.tok) + ')}';
				}
				this.helper('__wjoin');
				return '${__wjoin(' + param + ', ' + JSON.stringify(s.tok) + ')}';
			}
			if (s.tok[0] === '$') {
				this.helper('__wval');
				return `__wval(${param}, ${JSON.stringify(s.tok)})`;
			}
			this.helper('__wcode');
			return `__wcode(${param}, ${JSON.stringify(s.tok)})`;
		};

		//Lexer with a context stack. Frames: code (base, or braced from a template
		// ${...}), str ('/" with no token inside — copied verbatim), tpl (a template
		// literal — a real `...` or a '/" reopened as ` because it holds a token).
		const stack = [{ kind: 'code', depth: 0, braced: false }];
		const top = () => stack[stack.length - 1];
		let out = '';
		let i = 0;
		const lastSigChar = () => {
			for (let k = out.length - 1; k >= 0; k--) {
				if (!/\s/.test(out[k]))
					return out[k];
			}
			return null;
		};

		while (i < body.length) {
			const span = spanAt.get(i);
			if (span) {
				const t = top();
				if (t.kind === 'str')
					return null;
				out += exprOf(span, t.kind === 'tpl');
				i = span.end;
				continue;
			}

			const c = body[i];
			const t = top();

			if (t.kind === 'code') {
				if (c === '\'' || c === '"') {
					const end = this.findStringLiteralEnd(body, i);
					if (end === -1)
						return null;
					//A string whose ENTIRE content is one {theme.x} accessor becomes a
					// bare theme(…) call rather than a reopened template. The call returns
					// the resolved value (matching the runtime's whole-string splice, and
					// keeping object-valued themes intact) AND avoids emitting `${theme(`
					// — see the theme branch of exprOf for why that substring is toxic.
					const solo = spanAt.get(i + 1);
					if (solo && solo.kind === 'theme' && solo.end === end) {
						out += exprOf(solo, false);
						i = end + 1;
						continue;
					}
					if (clean.some(s => s.start > i && s.start < end)) {
						stack.push({ kind: 'tpl', close: c, converted: true });
						out += '`';
					} else {
						stack.push({ kind: 'str', close: c });
						out += c;
					}
					i++;
					continue;
				}
				if (c === '`') {
					stack.push({ kind: 'tpl', close: '`', converted: false });
					out += '`';
					i++;
					continue;
				}
				if (c === '{') {
					t.depth++;
					out += c;
					i++;
					continue;
				}
				if (c === '}') {
					if (t.braced && t.depth === 0) {
						stack.pop();
						out += c;
						i++;
						continue;
					}
					if (t.depth > 0)
						t.depth--;
					out += c;
					i++;
					continue;
				}
				if (c === '/') {
					//Regex literal or comment: copy verbatim so quotes inside don't
					// desync the lexer. -1 means it's a division operator.
					const end = this.scanSlash(body, i, lastSigChar());
					if (end !== -1) {
						out += body.slice(i, end);
						i = end;
						continue;
					}
				}
				out += c;
				i++;
				continue;
			}

			if (t.kind === 'str') {
				if (c === '\\') {
					out += c + (body[i + 1] ?? '');
					i += 2;
					continue;
				}
				if (c === t.close)
					stack.pop();
				out += c;
				i++;
				continue;
			}

			//t.kind === 'tpl'
			if (c === '\\') {
				out += c + (body[i + 1] ?? '');
				i += 2;
				continue;
			}
			if (c === t.close) {
				stack.pop();
				out += '`';
				i++;
				continue;
			}
			if (!t.converted && c === '$' && body[i + 1] === '{') {
				stack.push({ kind: 'code', depth: 0, braced: true });
				out += '${';
				i += 2;
				continue;
			}
			if (t.converted && c === '`') {
				out += '\\`';
				i++;
				continue;
			}
			if (t.converted && c === '$' && body[i + 1] === '{') {
				out += '\\${';
				i += 2;
				continue;
			}
			out += c;
			i++;
		}

		return stack.length === 1 ? out : null;
	}

	//Index of the closing quote for the string literal opened at openIdx (honouring
	// backslash escapes), or -1 if unterminated. Span contents carry no quote chars.
	findStringLiteralEnd (str, openIdx) {
		const qc = str[openIdx];
		for (let i = openIdx + 1; i < str.length; i++) {
			if (str[i] === '\\') {
				i++;
				continue;
			}
			if (str[i] === qc)
				return i;
		}
		return -1;
	}

	//At a '/', return the index just past a regex literal or comment, or -1 if the '/'
	// is a division operator. A regex is only recognised in operand position (decided
	// from the previous significant char: `a / b` stays division, `.replace(/x/, …)` is
	// a regex). This keeps quote/backtick chars INSIDE a regex from being misread as
	// string delimiters by the lexer / statement splitter.
	scanSlash (s, i, prevSig) {
		if (s[i + 1] === '/') {
			let j = i + 2;
			while (j < s.length && s[j] !== '\n')
				j++;
			return j;
		}
		if (s[i + 1] === '*') {
			const e = s.indexOf('*/', i + 2);
			return e === -1 ? s.length : e + 2;
		}
		if (prevSig !== null && /[\w$)\].]/.test(prevSig))
			return -1;
		let j = i + 1;
		let inClass = false;
		let closed = false;
		while (j < s.length) {
			const ch = s[j];
			if (ch === '\\') {
				j += 2;
				continue;
			}
			if (ch === '\n')
				break;
			if (ch === '[')
				inClass = true;
			else if (ch === ']')
				inClass = false;
			else if (ch === '/' && !inClass) {
				j++;
				closed = true;
				break;
			}
			j++;
		}
		if (!closed)
			return -1;
		while (j < s.length && /[a-z]/i.test(s[j]))
			j++;
		return j;
	}

	//Split a JS body into top-level statements: on a depth-0 ';', and after a depth-0
	// '}' that closes a STATEMENT block (if/for/while/switch/try/bare block or an
	// arrow/function body used as a statement) so a trailing result expression that
	// follows a block with no ';' (e.g. "if (x) {...} else {...} result") becomes its
	// own statement. A '}' followed by else/catch/finally/while or by punctuation/an
	// operator (i.e. an object-literal or expression '}') is NOT a boundary.
	splitStatements (s) {
		const parts = [];
		let depth = 0;
		let quote = null;
		let cur = '';
		const lastSig = str => {
			for (let k = str.length - 1; k >= 0; k--) {
				if (!/\s/.test(str[k]))
					return str[k];
			}
			return null;
		};
		for (let i = 0; i < s.length; i++) {
			const c = s[i];
			if (quote) {
				cur += c;
				if (c === '\\') {
					cur += s[i + 1] ?? '';
					i++;
				} else if (c === quote)
					quote = null;
				continue;
			}
			if (c === '\'' || c === '"' || c === '`') {
				quote = c;
				cur += c;
				continue;
			}
			if (c === '/') {
				//Skip regex literals/comments so quotes inside them don't desync this.
				const end = this.scanSlash(s, i, lastSig(cur));
				if (end !== -1) {
					cur += s.slice(i, end);
					i = end - 1;
					continue;
				}
			}
			if (c === '(' || c === '[' || c === '{') {
				depth++;
				cur += c;
				continue;
			}
			if (c === ')' || c === ']' || c === '}') {
				depth--;
				cur += c;
				if (c === '}' && depth === 0) {
					let j = i + 1;
					while (j < s.length && /\s/.test(s[j]))
						j++;
					const rest = s.slice(j);
					if (j < s.length && !/^(else|catch|finally|while)\b/.test(rest) && !/^[).,;:?\]}=+\-*/%<>&|^]/.test(rest)) {
						parts.push(cur);
						cur = '';
					}
				}
				continue;
			}
			if (c === ';' && depth === 0) {
				parts.push(cur);
				cur = '';
				continue;
			}
			cur += c;
		}
		if (cur.trim())
			parts.push(cur);
		return parts;
	}

	hasTopLevelSemicolon (s) {
		return this.splitTopLevel(s, ';').length > 1;
	}

	splitTopLevel (s, sep) {
		const parts = [];
		let depth = 0;
		let quote = null;
		let cur = '';
		for (let i = 0; i < s.length; i++) {
			const c = s[i];
			if (quote) {
				cur += c;
				if (c === '\\') {
					cur += s[i + 1] ?? '';
					i++;
				} else if (c === quote)
					quote = null;
				continue;
			}
			if (c === '\'' || c === '"' || c === '`') {
				quote = c;
				cur += c;
				continue;
			}
			if ('({['.includes(c))
				depth++;
			else if (')}]'.includes(c))
				depth--;
			if (c === sep && depth === 0) {
				parts.push(cur);
				cur = '';
				continue;
			}
			cur += c;
		}
		parts.push(cur);
		return parts;
	}

	stringExpr (s, ctx) {
		/*
			Legacy "eval-" string form (getMorphedValue, morphConfig.js:310): in a
			drilled position, a string containing 'eval-' has the first occurrence
			removed and the REMAINDER evaluated as JS — after accessor replacement,
			which is exactly what evalExpr replicates. Theme accessors ({theme.x})
			inside the JS can't be resolved statically (and would be a syntax error
			verbatim), so those strings go through the morph() runtime fallback.
		*/
		//Whole-value theme accessors resolve LIVE via the interface — the package-
		// time text splice can only represent scalars, so object-valued theme
		// entries (e.g. l2_menu_tree_sizing.prpsLogoCollapsed) would be destroyed
		// as '[object Object]' if left as string literals.
		if (/^\{theme\.[\w./-]+\}$/.test(s)) {
			this.use('theme');
			return `theme(${JSON.stringify(s.slice(7, -1))})`;
		}

		if (ctx.drilled && s.includes('eval-'))
			return this.evalExpr(s.replace('eval-', ''), ctx, s);

		/*
			Relative trait refs ("./x") resolve against the containing FILE — and
			this string is moving from the host JSON into actions/<name>.js, one
			folder down. Rewrite to the absolute @ensemble form (existence-gated,
			exactly like trait-prepare does when content changes folders).
		*/
		if (/^\.\/[^\s'"`<>|]+$/.test(s) && this.traitResolver && this.ensembles.length) {
			const abs = this.traitResolver(s);
			if (abs) {
				const normAbs = String(abs).replace(/\\/g, '/').replace(/\.json$/i, '');
				const e = this.ensembles.find(x => normAbs.startsWith(x.root + '/'));
				if (e)
					return JSON.stringify(`@${e.name}/${normAbs.slice(e.root.length + 1)}`);
			}
		}

		//Trait-prp wildcards. Spread form splices ARRAYS into the parent — not
		// expressible as a config param; fail closed.
		if (/[%$]\.\.\./.test(s))
			throw new SkipScript('spread trait-prp wildcard ($...x$)');

		//Whole-value wildcard: $x$ passes the EXACT value (objects intact), %x%
		// string-coerces (arrays join(' ')); undefined prps keep the raw text.
		if (WILDCARD_WHOLE.test(s)) {
			const p = this.traitParamExpr(s);
			if (s[0] === '$') {
				this.helper('__wval');
				return `__wval(${p}, ${JSON.stringify(s)})`;
			}
			this.helper('__wjoin');
			return `__wjoin(${p}, ${JSON.stringify(s)})`;
		}

		const spans = this.findAccessorSpans(s);

		if (spans.length === 1 && spans[0].open === '{{' && spans[0].start === 0 && spans[0].end === s.length) {
			const expr = this.accessorExpr(spans[0].inner, ctx, s) ?? this.rowParamExpr(spans[0], s);
			if (expr !== null)
				return expr;
		}

		if (spans.length === 0) {
			if (new RegExp(`^${SCOPED_TOKEN.source}$`).test(s) && !hasWildcard(s)) {
				this.use('resolveId');
				return `resolveId(${JSON.stringify(s)})`;
			}
			SCOPED_TOKEN.lastIndex = 0;
			if (SCOPED_TOKEN.test(s) || hasWildcard(s)) {
				SCOPED_TOKEN.lastIndex = 0;
				return '`' + this.litSegment(s) + '`';
			}
			return JSON.stringify(s);
		}

		//Literal text segments: escape, resolve ||…|| tokens (fixScopeIds ran over
		// the raw string at morph time) and splice trait-prp wildcard params.
		// Spliced ${…} expressions are NEVER post-processed — their internal
		// "||…||" string literals resolve at call time via the interface, and
		// rewriting them corrupts the emitted JS.
		let tpl = '';
		let pos = 0;
		for (const sp of spans) {
			const spanText = s.slice(sp.start, sp.end);
			const expr = this.accessorExpr(sp.inner, ctx, spanText) ?? this.rowParamExpr(sp, spanText);
			if (expr === null) {
				tpl += this.litSegment(s.slice(pos, sp.start));
				tpl += this.retainedSpanTpl(spanText, ctx);
				pos = sp.end;
				continue;
			}
			tpl += this.litSegment(s.slice(pos, sp.start));
			tpl += sp.open === '{{' ? '${JSON.stringify(' + expr + ')}' : '${' + expr + '}';
			pos = sp.end;
		}
		tpl += this.litSegment(s.slice(pos));

		return '`' + tpl + '`';
	}

	/*
		A span kept as literal text (foreign-prefixed / undrilled shapes the LATER
		consumer resolves) can still contain INNER spans the RUNNING script would
		have replaced — the engine's char-scan resolves innermost spans regardless
		of what encloses them ({{sSST.eval. … {{sSRC.state.x}} … }} running inside
		sSRC bakes the inner state value into the retained text). Resolve those
		inner spans here, splicing with the engine's embedded-replacement escaping
		(JSON.stringify + brace padding, morphConfig.js:274) so the consumer's own
		scan never trips on braces inside the spliced value.
	*/
	retainedSpanTpl (text, ctx) {
		//Literal chunks of retained accessor text still get their ||…|| tokens
		// resolved and their trait-prp wildcards spliced (the engine's text
		// substitutions ran over the whole raw string) — but spliced ${…}
		// expressions are never touched.
		const esc = x => this.litSegment(x);
		const inner = text.slice(2, -2);
		const spans = this.findAccessorSpans(inner);
		if (!spans.length)
			return esc(text);

		let tpl = esc(text.slice(0, 2));
		let pos = 0;
		for (const sp of spans) {
			const spanText = inner.slice(sp.start, sp.end);
			const expr = this.accessorExpr(sp.inner, ctx, spanText) ?? this.rowParamExpr(sp, spanText);
			if (expr === null) {
				tpl += esc(inner.slice(pos, sp.start));
				tpl += this.retainedSpanTpl(spanText, ctx);
				pos = sp.end;
				continue;
			}
			tpl += esc(inner.slice(pos, sp.start));
			tpl += sp.open === '{{'
				? '${JSON.stringify(' + expr + ")?.replaceAll('}}', ' } } ').replaceAll('{{', ' { {  ')}"
				: '${' + expr + '}';
			pos = sp.end;
		}
		tpl += esc(inner.slice(pos)) + esc(text.slice(-2));
		return tpl;
	}

	valueExpr (v, ctx) {
		if (typeof v === 'string')
			return this.stringExpr(v, ctx);

		if (Array.isArray(v))
			return `[${v.map(x => this.valueExpr(x, ctx)).join(', ')}]`;

		if (v !== null && typeof v === 'object') {
			//Packager semantics: an inlineKeys array at ANY object depth joins the
			// listed keys' array-of-lines values with ' ' at package time. Converted
			// scripts bypass the packager's JSON pass, so replicate it here.
			if (Array.isArray(v.inlineKeys)) {
				const joined = { ...v };
				for (const k of joined.inlineKeys) {
					if (Array.isArray(joined[k]))
						joined[k] = joined[k].join(' ');
				}
				delete joined.inlineKeys;
				v = joined;
			}

			const parts = Object.entries(v).map(([k, val]) => {
				//Wildcard OBJECT KEYS get renamed by the trait engine — a static
				// object literal can't express that; fail closed.
				if (hasWildcard(k))
					throw new SkipScript(`trait-prp wildcard in object key: ${k}`);
				let key = k;
				let childCtx = ctx;
				if (k[0] === '^') {
					key = k.slice(1);
					childCtx = { ...ctx, drilled: true };
				} else if (val !== null && typeof val === 'object')
					//morphConfig only DROPS drilling for un-careted OBJECT children;
					// string/primitive children inherit the parent's drilling.
					childCtx = { ...ctx, drilled: false };

				//{{fn.*}} accessors read the PARENT's fnArgs[<key>] — thread it.
				if (v.fnArgs && v.fnArgs[key] !== undefined)
					childCtx = { ...childCtx, fnArgsRaw: v.fnArgs[key] };

				const keyOut = JS_IDENT.test(key) ? key : JSON.stringify(key);
				return `${keyOut}: ${this.valueExpr(val, childCtx)}`;
			});
			return `{ ${parts.join(', ')} }`;
		}

		return JSON.stringify(v);
	}

	//---------------------------------------------------------- comparisons
	//Shallow copy with leading '^' stripped from plain-word keys (deep keys inside
	// value objects keep their carets — valueExpr interprets those for drilling).
	normalizeCaretKeys (obj) {
		if (!obj || typeof obj !== 'object' || Array.isArray(obj))
			return obj;

		let changed = false;
		const out = {};
		const caretKeys = [];
		for (const [k, v] of Object.entries(obj)) {
			if (k[0] === '^' && /^\^[\w$]+$/.test(k)) {
				out[k.slice(1)] = v;
				caretKeys.push(k.slice(1));
				changed = true;
			} else
				out[k] = v;
		}
		if (!changed)
			return obj;
		//Remember which keys carried the drilling marker (morphConfig semantics:
		// object/array values only drill when caret-prefixed; strings always do).
		Object.defineProperty(out, '__caretKeys', { value: caretKeys, enumerable: false });
		return out;
	}

	//Builds an object-literal expression from an action's config keys with the
	// runtime's per-key drilling: top-level strings drill, object/array values
	// only when their key was caret-prefixed.
	actionCfgExpr (action, ctx, omit = []) {
		const caret = action.__caretKeys ?? [];
		const skip = new Set(['type', 'branch', 'actionCondition', 'storeAsVariable', 'pushToVariable', 'comment', 'log', 'id', ...omit]);

		const parts = [];
		for (const [k, val] of Object.entries(action)) {
			if (skip.has(k))
				continue;
			if (hasWildcard(k))
				throw new SkipScript(`trait-prp wildcard in config key: ${k}`);
			const drilled = typeof val === 'string' || caret.includes(k);
			const childCtx = { ...ctx, drilled };
			//{{fn.*}} accessors read the ACTION's fnArgs[<key>] — thread it.
			if (action.fnArgs && action.fnArgs[k] !== undefined)
				childCtx.fnArgsRaw = action.fnArgs[k];
			const keyOut = JS_IDENT.test(k) ? k : JSON.stringify(k);
			parts.push(`${keyOut}: ${this.valueExpr(val, childCtx)}`);
		}
		return `{ ${parts.join(', ')} }`;
	}

	comparisonExpr (cfg, ctx) {
		cfg = this.normalizeCaretKeys(cfg);
		const { operator, comparisons } = cfg;

		//A trait-prp wildcard (%x%/$x$) as a comparison operand can't be faithfully
		// converted: __traitParams keeps the raw token when the prp is undefined
		// (engine morph semantics), and a raw token string is truthy / never equal —
		// so isTruthy/isFalsy/isEqual guards flip vs the declarative runtime, firing
		// branches that should be skipped (e.g. opening "%data.openDashboard%"). Fail
		// closed: keep the whole script declarative.
		for (const operandKey of ['value', 'compareValue', 'source', 'key']) {
			const v = cfg[operandKey];
			if (typeof v === 'string' && hasWildcard(v))
				throw new SkipScript(`trait-prp wildcard in comparison ${operandKey} (${v}) — truthiness/equality not faithfully convertible`);
		}

		if (['all', 'some', 'none'].includes(operator)) {
			if (!Array.isArray(comparisons))
				return null;
			const parts = comparisons.map(c => this.comparisonExpr(c, ctx));
			if (parts.some(p => p === null))
				return null;
			const joined = parts.map(p => `(${p})`).join(operator === 'some' ? ' || ' : ' && ');
			return operator === 'none' ? `!(${parts.map(p => `(${p})`).join(' || ')})` : joined;
		}

		const op = OPERATOR_EXPR[operator];
		if (!op && operator !== 'case')
			return null;

		let aExpr;
		if (cfg.value !== undefined)
			aExpr = this.valueExpr(cfg.value, { ...ctx, drilled: true });
		else if (cfg.source !== undefined) {
			this.use('getExternalState');
			const src = this.valueExpr(cfg.source, { ...ctx, drilled: true });
			const key = cfg.key !== undefined ? this.valueExpr(cfg.key, { ...ctx, drilled: true }) : '\'value\'';
			const t = this.temp('__c');
			ctx.pre.push(`const ${t} = (getExternalState(${src}) ?? {})[${key}];`);
			if (operator === 'case')
				return t;
			this.helper(...CMP_HELPERS);
			return `${t} !== undefined && ${op(t, cfg.compareValue !== undefined ? this.valueExpr(cfg.compareValue, { ...ctx, drilled: true }) : 'undefined')}`;
		} else
			return null;

		if (operator === 'case')
			return aExpr;

		this.helper(...CMP_HELPERS);
		const bExpr = cfg.compareValue !== undefined ? this.valueExpr(cfg.compareValue, { ...ctx, drilled: true }) : 'undefined';
		return op(aExpr, bExpr);
	}

	//---------------------------------------------------------- variable helpers
	//Resolves which local map an action's variable belongs to. Returns
	// { kind: 'main' | 'chain', name } or null (foreign scope → delegate).
	variableTarget (action, ctx) {
		const { scope } = action;
		if (scope === undefined)
			return { kind: ctx.chainLocals ? 'chain' : 'main' };
		if (scope === this.scriptId)
			return { kind: 'main' };
		if (ctx.chainScopeId && scope === ctx.chainScopeId)
			return { kind: 'chain' };
		return null;
	}

	//Engine-store sync for producer variables (see syncVars in the constructor).
	// Only main-scope writes sync — chain vars live under a different store key.
	syncVarLines (name, target, ident, indent) {
		if (target?.kind !== 'main' || !this.syncVars.has(name))
			return [];
		this.use('setVariable');
		return [`${indent}setVariable(${JSON.stringify(name)}, ${ident});`];
	}

	//Returns the assignable ident for (targetKind, name), declaring as needed.
	assignableIdent (name, target, ctx) {
		if (typeof name !== 'string' || !name)
			return null;

		if (target.kind === 'chain') {
			let ident = ctx.chainLocals.get(name);
			if (!ident) {
				ident = this.identForChain(name, ctx);
				ctx.chainLocals.set(name, ident);
			}
			return ident;
		}

		return this.ensureLocal(name).ident;
	}

	identForChain (name, ctx) {
		let ident = String(name).replace(/[^\w$]/g, '_');
		if (!JS_IDENT.test(ident) || RESERVED.has(ident) || this.usedIdents.has(ident))
			ident = `c_${ident}`;
		while (this.usedIdents.has(ident))
			ident += '_';
		this.usedIdents.add(ident);
		//Chain vars persist across loop iterations at runtime → hoist at fn top.
		this.hoisted.push(`let ${ident};`);
		return ident;
	}

	//---------------------------------------------------------- delegation sync
	collectMutatedNames (actions, acc = new Set()) {
		for (const a of Array.isArray(actions) ? actions : [actions]) {
			if (!a || typeof a !== 'object')
				continue;
			if (typeof a.storeAsVariable === 'string')
				acc.add(a.storeAsVariable);
			if (typeof a.pushToVariable === 'string')
				acc.add(a.pushToVariable);
			if (VARIABLE_SET_TYPES.has(a.type) && (a.scope === undefined || a.scope === this.scriptId)) {
				if (typeof a.name === 'string')
					acc.add(a.name);
				if (a.variables && typeof a.variables === 'object')
					(Array.isArray(a.variables) ? a.variables : Object.keys(a.variables)).forEach(n => {
						if (typeof n === 'string')
							acc.add(n);
					});
			}
			for (const v of Object.values(a)) {
				if (v && typeof v === 'object')
					this.collectMutatedNames(Array.isArray(v) ? v : [v], acc);
			}
		}
		return acc;
	}

	//---------------------------------------------------------- actions
	/*
		Zero-delegation: every action must translate to vanilla JS. An action that
		cannot (unknown type, dynamic construct) aborts the WHOLE script conversion
		(SkipScript) — the script stays declarative JSON and is reported.
	*/
	genActions (actions, ctx, indent) {
		const lines = [];

		for (const action of actions) {
			//{traits:[…]} actions (traitArray fragments) flatten inline at build time.
			if (action && typeof action === 'object' && Array.isArray(action.traits) && !action.type) {
				lines.push(...this.genFlattenedTraits(action, ctx, indent));
				continue;
			}

			const out = this.genAction(action, ctx, indent);
			if (out === null) {
				const type = action?.type ?? (action?.blueprint ? 'blueprint' : 'unknown');
				throw new SkipScript(`unsupported action (type: ${type})`);
			}
			this.stats.native++;
			lines.push(...out);
		}

		return lines;
	}

	//applyTraitsToArray at build time: resolve each trait entry, substitute its
	// traitPrps, splice the traitArray actions inline (recursively via genActions).
	genFlattenedTraits (action, ctx, indent) {
		if (!this.traitResolver)
			throw new SkipScript('traits action but no trait resolver configured');

		const lines = [];

		for (const entry of action.traits) {
			const ref = typeof entry === 'string' ? entry : entry?.trait;
			const entryObj = typeof entry === 'object' && entry !== null ? entry : {};

			if (typeof ref !== 'string' || ref.includes('%') || ref.includes('$') || ref.includes('{'))
				throw new SkipScript(`dynamic trait path in actions: ${JSON.stringify(ref).slice(0, 60)}`);

			const absPath = this.traitResolver(ref);
			if (!absPath)
				throw new SkipScript(`unresolvable trait in actions: ${ref}`);

			if (this.flattenStack.includes(absPath))
				throw new SkipScript(`trait flattening cycle at ${ref}`);

			const prepared = prepareTraitArray({
				absPath,
				traitPrps: entryObj.traitPrps ?? {},
				ensembles: this.ensembles
			});
			if (prepared.skip)
				throw new SkipScript(`trait ${ref}: ${prepared.skip}`);

			this.stats.flattenedTraits++;
			this.flattenStack.push(absPath);
			let body;
			try {
				body = this.genActions(prepared.actions, ctx, entryObj.condition ? indent + '\t' : indent);
			} finally {
				this.flattenStack.pop();
			}

			//Entry condition → native if (isConditionMet evaluates the same
			// comparison configs as applyComparison).
			if (entryObj.condition) {
				const pre = [];
				const cond = this.comparisonExpr(entryObj.condition, { ...ctx, pre });
				if (cond === null)
					throw new SkipScript(`unconvertible condition on trait entry ${ref}`);
				lines.push(...pre.map(p => indent + p));
				lines.push(`${indent}if (${cond}) {`);
				lines.push(...body);
				lines.push(`${indent}}`);
			} else
				lines.push(...body);
		}

		return lines;
	}

	/* eslint-disable-next-line complexity */
	genAction (action, ctx, indent) {
		if (!action || typeof action !== 'object' || Array.isArray(action))
			return null;
		if (action.srcAction || action.srcActions || action.traits || action.blueprint || action.handler || action.suite)
			return null;
		if (!NATIVE_TYPES.has(action.type))
			return null;
		if (Object.keys(action).some(k => k === 'spread-' || (k[0] !== '^' && k.includes('{{'))))
			return null;

		//Caret-prefixed keys ("^condition", "^value", …) are morphConfig's drilling
		// marker: the runtime strips the ^ and reads the plain key, with the nested
		// object's accessors resolved. The generators already treat action-level
		// values as drilled, so normalizing here (into a COPY — delegated actions
		// must keep their carets for the engine) replicates the semantics. Missing
		// this made "^condition" stopScripts unconditional returns.
		action = this.normalizeCaretKeys(action);

		//inlineKeys: multi-line eval values authored as arrays of lines. The
		// packager joins them with ' ' before runtime — replicate that here so the
		// joined "{{eval.…}}" string converts as ONE eval, not per-element.
		if (Array.isArray(action.inlineKeys)) {
			action = { ...action };
			for (const k of action.inlineKeys) {
				if (Array.isArray(action[k]) && action[k].every(x => typeof x === 'string'))
					action[k] = action[k].join(' ');
			}
			delete action.inlineKeys;
		}

		const lines = [];
		const pre = [];

		//{{fn.*}} args for generators that read action keys directly (the engine
		// keys fnArgs by the CONFIG KEY; map by the key's VALUE so accessorExpr
		// can find the args even without key context).
		let fnByValue = null;
		if (action.fnArgs && typeof action.fnArgs === 'object') {
			fnByValue = new Map();
			for (const [k, fa] of Object.entries(action.fnArgs)) {
				if (typeof action[k] === 'string')
					fnByValue.set(action[k], fa);
			}
		}

		const actx = fnByValue ? { ...ctx, pre, fnByValue } : { ...ctx, pre };

		let bodyLines;
		let resultExpr = null;

		try {
			({ bodyLines, resultExpr } = this.genActionCore(action, actx, indent));
		} catch (e) {
			if (e instanceof SkipScript)
				throw e;
			return null;
		}
		if (bodyLines === null)
			return null;

		/*
			Eval ride-along: the engine morphs EVERY config key before running an
			action, so a "{{eval.…}}" string under a key the action never reads
			still EXECUTES as a side effect of morphing (the deleteVariable+eval
			pattern in l2_grid's virtualizers). Native generators read only their
			own keys — replicate the evaluation before the action body.
		*/
		if (typeof action.eval === 'string' && action.eval.includes('{{eval')) {
			const sideEffect = this.stringExpr(action.eval, { ...actx, drilled: true });
			bodyLines.unshift(`${indent}${sideEffect};`);
		}

		const makePost = expr => {
			const out = [];
			if (action.storeAsVariable) {
				const target = this.variableTarget({ scope: undefined }, ctx);
				const ident = this.assignableIdent(action.storeAsVariable, target, ctx);
				out.push(`${indent}${ident} = ${expr};`);
				out.push(...this.syncVarLines(action.storeAsVariable, target, ident, indent));
			} else if (action.pushToVariable) {
				const target = this.variableTarget({ scope: undefined }, ctx);
				const ident = this.assignableIdent(action.pushToVariable, target, ctx);
				out.push(`${indent}${ident} = ${ident} || [];`);
				out.push(`${indent}${ident}.push(${expr});`);
				out.push(...this.syncVarLines(action.pushToVariable, target, ident, indent));
			}
			return out;
		};
		if ((action.storeAsVariable || action.pushToVariable) && !resultExpr)
			return null;
		const post = action.branch ? [] : makePost(resultExpr);

		const branchLines = [];
		if (action.branch) {
			if (!resultExpr)
				return null;
			const fn = this.temp('__r');
			const branchScopes = [...(ctx.scopeIds ?? [])];
			if (action.id && !branchScopes.includes(action.id))
				branchScopes.push(action.id);

			//A boolean two-way branch (keys are only 'true'/'false' — from isTruthy /
			// isEqual / etc.) compiles to plain if/else on the boolean result, not the
			// generic String(result) === key match used for `case`-style string keys.
			const branchKeys = Object.keys(action.branch);
			const isBoolBranch = branchKeys.every(k => k === 'true' || k === 'false');

			Object.entries(action.branch).forEach(([key, list], n) => {
				const listActions = Array.isArray(list) ? list : [list];
				const hasStop = JSON.stringify(listActions).includes('"stopScript"');
				const label = hasStop ? this.temp('__list') : null;
				const bodyIndent = label ? indent + '\t\t' : indent + '\t';
				const sub = this.genActions(listActions, {
					...ctx,
					scopeIds: branchScopes,
					stopStmt: label ? `break ${label};` : ctx.stopStmt
				}, bodyIndent);

				let head;
				if (isBoolBranch && branchKeys.length === 2)
					head = n === 0 ? `${indent}if (${key === 'true' ? fn : `!(${fn})`}) {` : `${indent}else {`;
				else if (isBoolBranch)
					head = `${indent}if (${key === 'true' ? fn : `!(${fn})`}) {`;
				else
					head = `${indent}${n === 0 ? 'if' : 'else if'} (String(${fn}) === ${JSON.stringify(key)}) {`;
				branchLines.push(head);
				if (label) {
					branchLines.push(`${indent}\t${label}: {`);
					branchLines.push(...sub);
					branchLines.push(`${indent}\t}`);
				} else
					branchLines.push(...sub);
				branchLines.push(`${indent}}`);
			});

			const boundPost = makePost(fn);
			if (action.actionCondition) {
				const cond = this.comparisonExpr(action.actionCondition, actx);
				if (cond === null)
					return null;
				lines.push(...pre.map(p => indent + p));
				lines.push(`${indent}if (${cond}) {`);
				lines.push(...bodyLines.map(l => '\t' + l));
				lines.push(`\t${indent}const ${fn} = ${resultExpr};`);
				lines.push(...boundPost.map(l => '\t' + l));
				lines.push(...branchLines.map(l => '\t' + l));
				lines.push(`${indent}}`);
				return lines;
			}
			lines.push(...pre.map(p => indent + p));
			lines.push(...bodyLines);
			lines.push(`${indent}const ${fn} = ${resultExpr};`);
			lines.push(...boundPost);
			lines.push(...branchLines);
			return lines;
		}

		if (action.actionCondition) {
			const cond = this.comparisonExpr(action.actionCondition, actx);
			if (cond === null)
				return null;
			const out = [];
			out.push(...pre.map(p => indent + p));
			out.push(`${indent}if (${cond}) {`);
			out.push(...bodyLines.map(l => '\t' + l));
			out.push(...post.map(l => '\t' + l));
			out.push(`${indent}}`);
			return out;
		}

		lines.push(...pre.map(p => indent + p));
		lines.push(...bodyLines);
		lines.push(...post);
		return lines;
	}

	/* eslint-disable-next-line complexity, max-lines-per-function */
	genActionCore (action, ctx, indent) {
		const v = val => this.valueExpr(val, { ...ctx, drilled: true });
		const t = action.type;

		if (t === 'setState') {
			const key = action.key !== undefined ? v(action.key) : '\'value\'';
			const val = action.value !== undefined ? v(action.value) : 'undefined';
			const keyLit = action.key === undefined || (typeof action.key === 'string' && JS_IDENT.test(action.key) && !action.key.includes('{'));
			const stateObj = keyLit
				? `{ ${action.key ?? 'value'}: ${val} }`
				: `{ [${key}]: ${val} }`;
			if (action.target === undefined) {
				this.use('setState');
				return { bodyLines: [`${indent}setState(${stateObj});`], resultExpr: null };
			}
			this.use('setExternalState');
			return { bodyLines: [`${indent}setExternalState(${v(action.target)}, ${stateObj});`], resultExpr: null };
		}

		if (t === 'setMultiState') {
			const val = v(action.value ?? {});
			if (action.target === undefined) {
				this.use('setState');
				return { bodyLines: [`${indent}setState(${val});`], resultExpr: null };
			}
			this.use('setExternalState');
			return { bodyLines: [`${indent}setExternalState(${v(action.target)}, ${val});`], resultExpr: null };
		}

		if (t === 'getState') {
			this.use('getExternalState');
			const key = action.key !== undefined ? v(action.key) : '\'value\'';
			return { bodyLines: [], resultExpr: `(getExternalState(${v(action.source)}) ?? {})[${key}]` };
		}

		//---- literal variables
		if (VARIABLE_SET_TYPES.has(t)) {
			const target = this.variableTarget(action, ctx);

			//FOREIGN static scope: the declarative action wrote another script's
			// engine-store entries — replicate through the interface's scoped
			// setVariable/getVariable (the store is global, keyed <scope>-<name>).
			if (!target && typeof action.scope === 'string' && !/\{\{|\(\(/.test(action.scope) && !hasWildcard(action.scope)) {
				const scope = JSON.stringify(action.scope);

				if (t === 'setVariable' && typeof action.name === 'string') {
					this.use('setVariable');
					return { bodyLines: [`${indent}setVariable(${JSON.stringify(action.name)}, ${v(action.value)}, ${scope});`], resultExpr: null };
				}
				if (t === 'setVariables' && action.variables && typeof action.variables === 'object') {
					this.use('setVariable');
					const lines = Object.entries(action.variables).map(([name, val]) =>
						`${indent}setVariable(${JSON.stringify(name)}, ${v(val)}, ${scope});`);
					return { bodyLines: lines, resultExpr: null };
				}
				if (t === 'deleteVariable' || t === 'deleteVariables') {
					this.use('setVariable');
					const names = (t === 'deleteVariable' ? [action.name] : (action.variables ?? [])).filter(n => typeof n === 'string');
					return { bodyLines: names.map(n => `${indent}setVariable(${JSON.stringify(n)}, undefined, ${scope});`), resultExpr: null };
				}
				if (t === 'deleteVariableKey' && typeof action.name === 'string' && action.key !== undefined) {
					this.use('getVariable');
					this.helper('__delKey');
					//Mutates the stored object in place — same reference the store holds.
					return { bodyLines: [`${indent}__delKey(getVariable(${JSON.stringify(action.name)}, ${scope}), ${v(action.key)});`], resultExpr: null };
				}
			}

			if (!target)
				return { bodyLines: null };

			if (t === 'setVariable') {
				const ident = this.assignableIdent(action.name, target, ctx);
				if (!ident)
					return { bodyLines: null };
				const entry = this.locals.get(action.name);
				const decl = target.kind === 'main' && this.inlinePlan.has(action.name) && entry && !entry.declared;
				if (decl)
					entry.declared = true;
				return {
					bodyLines: [
						`${indent}${decl ? 'let ' : ''}${ident} = ${v(action.value)};`,
						...this.syncVarLines(action.name, target, ident, indent)
					],
					resultExpr: null
				};
			}

			if (t === 'setVariables') {
				if (!action.variables || typeof action.variables !== 'object')
					return { bodyLines: null };
				const lines = Object.entries(action.variables).flatMap(([name, val]) => {
					const ident = this.assignableIdent(name, target, ctx);
					return [
						`${indent}${ident} = ${v(val)};`,
						...this.syncVarLines(name, target, ident, indent)
					];
				});
				return { bodyLines: lines, resultExpr: null };
			}

			if (t === 'deleteVariable' || t === 'deleteVariables') {
				const names = t === 'deleteVariable' ? [action.name] : (action.variables ?? []);
				const lines = names.filter(n => typeof n === 'string').flatMap(n => {
					const ident = this.assignableIdent(n, target, ctx);
					return [
						`${indent}${ident} = undefined;`,
						...this.syncVarLines(n, target, ident, indent)
					];
				});
				return { bodyLines: lines, resultExpr: null };
			}

			if (t === 'pushVariable') {
				const ident = this.assignableIdent(action.name, target, ctx);
				if (!ident)
					return { bodyLines: null };
				return {
					bodyLines: [
						`${indent}${ident} = ${ident} || [];`,
						`${indent}${ident}.push(${v(action.value)});`
					],
					resultExpr: null
				};
			}

			if (t === 'popVariable') {
				const ident = this.assignableIdent(action.name, target, ctx);
				if (!ident)
					return { bodyLines: null };
				return { bodyLines: [`${indent}if (${ident} && ${ident}.pop) ${ident}.pop();`], resultExpr: null };
			}

			if (t === 'setVariableKey') {
				const ident = this.assignableIdent(action.name, target, ctx);
				if (!ident || action.key === undefined)
					return { bodyLines: null };
				this.helper('__setKey');
				return { bodyLines: [`${indent}__setKey(${ident}, ${v(action.key)}, ${v(action.value)});`], resultExpr: null };
			}
		}

		if (t === 'applyComparison') {
			const expr = this.comparisonExpr(action, ctx);
			if (expr === null)
				return { bodyLines: null };
			return { bodyLines: [], resultExpr: expr };
		}

		if (t === 'stopScript') {
			const stop = ctx.stopStmt ?? 'return;';
			if (!action.condition)
				return { bodyLines: [`${indent}${stop}`], resultExpr: null };
			const cond = this.comparisonExpr(action.condition, ctx);
			if (cond === null)
				return { bodyLines: null };
			return { bodyLines: [`${indent}if (${cond})`, `${indent}\t${stop}`], resultExpr: null };
		}

		if (t === 'wait') {
			this.helper('__sleep');
			return { bodyLines: [`${indent}await __sleep(${v(action.duration)});`], resultExpr: null };
		}

		if (t === 'log')
			return { bodyLines: [`${indent}console.log(${v(action.msg)});`], resultExpr: null };

		if (t === 'clone' || t === 'morphObject') {
			this.helper('__deepClone');
			return { bodyLines: [], resultExpr: `__deepClone(${v(action.value)})` };
		}

		if (t === 'parseJson') {
			const tv = this.temp('__j');
			ctx.pre.push(`let ${tv}; try { ${tv} = JSON.parse(${v(action.value)}); } catch { ${tv} = ${v(action.errorResult)}; }`);
			return { bodyLines: [], resultExpr: tv };
		}

		if (t === 'morphEntries')
			return { bodyLines: [], resultExpr: `Object.entries(${v(action.value)})` };
		if (t === 'morphKeys')
			return { bodyLines: [], resultExpr: `Object.keys(${v(action.value)})` };
		if (t === 'morphValues')
			return { bodyLines: [], resultExpr: `Object.values(${v(action.value)})` };
		if (t === 'morphFromEntries')
			return { bodyLines: [], resultExpr: `Object.fromEntries(${v(action.value)})` };
		if (t === 'morphTypeOf')
			return { bodyLines: [], resultExpr: `(x => Array.isArray(x) ? 'array' : typeof x)(${v(action.value)})` };
		if (t === 'morphKeyPath') {
			this.helper('__deep');
			return { bodyLines: [], resultExpr: `__deep(${v(action.value)}, ${v(action.path)})` };
		}
		if (t === 'joinArray') {
			const tv = this.temp('__j');
			ctx.pre.push(`const ${tv} = ${v(action.value)};`);
			return { bodyLines: [], resultExpr: `(${tv} && ${tv}.length ? ${tv}.join(${v(action.separator)}) : '')` };
		}
		if (t === 'generateGuid')
			return { bodyLines: [], resultExpr: 'crypto.randomUUID()' };

		if (t === 'morphIterateArray' || t === 'findInArray' || t === 'mapArray' ||
			t === 'findIndexInArray' || t === 'filterArray')
			return this.genLoop(action, ctx, indent);

		//---- notifications (opus-ui-components/src/scriptActions/showNotification.js)
		if (t === 'showNotification') {
			this.use('setExternalState');
			const target = action.target !== undefined ? v(action.target) : '\'NOTIFICATIONS\'';
			if (action.value !== undefined) {
				this.helper('__buildMsg');
				return { bodyLines: [`${indent}setExternalState(${target}, { newMsg: (${v(action.value)}).map(__buildMsg) });`], resultExpr: null };
			}
			const msg = [
				`msg: ${action.msg !== undefined ? v(action.msg) : 'undefined'}`,
				`type: ${action.msgType !== undefined ? v(action.msgType) : '\'info\''}`,
				`autoClose: ${action.autoClose !== undefined ? v(action.autoClose) : 'true'}`,
				`isGlobal: ${action.isGlobal !== undefined ? v(action.isGlobal) : 'false'}`
			];
			if (action.duration !== undefined)
				msg.push(`duration: ${v(action.duration)}`);
			return { bodyLines: [`${indent}setExternalState(${target}, { newMsg: { ${msg.join(', ')} } });`], resultExpr: null };
		}

		//---- tag state (setTagState.js)
		if (t === 'setTagState') {
			this.use('getIdsWithTag');
			this.use('setExternalState');
			const key = action.key !== undefined ? v(action.key) : '\'value\'';
			return {
				bodyLines: [`${indent}getIdsWithTag(${v(action.target)}).forEach(__id => setExternalState(__id, { [${key}]: ${v(action.value)} }));`],
				resultExpr: null
			};
		}

		//---- flows (interface addition)
		if (t === 'createFlow') {
			this.use('createFlow');
			return { bodyLines: [`${indent}createFlow(${this.actionCfgExpr(action, ctx)});`], resultExpr: null };
		}

		//---- waitForCondition.js: poll the comparison every intervalInMs
		if (t === 'waitForCondition') {
			this.helper('__sleep');
			const interval = action.intervalInMs !== undefined ? v(action.intervalInMs) : '300';
			const inner = { ...ctx, pre: [] };
			const cmp = this.comparisonExpr(action.condition, inner);
			if (cmp === null)
				return { bodyLines: null };
			return {
				bodyLines: [
					`${indent}while (true) {`,
					...inner.pre.map(p => `${indent}\t${p}`),
					`${indent}\tif (${cmp})`,
					`${indent}\t\tbreak;`,
					`${indent}\tawait __sleep(${interval});`,
					`${indent}}`
				],
				resultExpr: null
			};
		}

		//---- network (l2_util/scriptHelpers/net.js — ports of the legoz actions)
		if (t === 'queryUrl' || t === 'queryGateway' || t === 'performRequest') {
			this.imports.add(NET_IMPORT);
			this.use('getExternalState');
			this.use('setExternalState');
			this.use('resolveId');

			let cfgExpr = this.actionCfgExpr(action, ctx, ['extractAny', 'extractResults', 'extractErrors']);
			//The helper checks extract presence to decide saveResultInState.
			const flags = [];
			if (action.extractAny)
				flags.push('extractAny: true');
			if (action.extractResults)
				flags.push('extractResults: true');
			if (flags.length)
				cfgExpr = cfgExpr === '{  }' ? `{ ${flags.join(', ')} }` : cfgExpr.replace(/^\{ /, `{ ${flags.join(', ')}, `);

			const q = this.temp('__q');
			const fn = t === 'performRequest' ? 'queryUrl' : t;
			const lines = [`${indent}const ${q} = await __net.${fn}(${cfgExpr}, { getExternalState, setExternalState, resolveId });`];

			this.helper('__deep');
			const extract = (extractors, guard) => {
				for (const ex of Array.isArray(extractors) ? extractors : []) {
					if (typeof ex.variable !== 'string' || typeof ex.path !== 'string')
						throw new SkipScript('dynamic extract config');
					const target = this.variableTarget({ scope: undefined }, ctx);
					const ident = this.assignableIdent(ex.variable, target, ctx);
					const guardCode = guard ? `${guard} && ` : '';
					const sync = this.syncVarLines(ex.variable, target, ident, '').join('');
					lines.push(`${indent}{ const __v = __deep(${q}.res, ${JSON.stringify(ex.path)}); if (${guardCode}__v !== undefined) { ${ident} = __v; ${sync}} }`);
				}
			};
			extract(action.extractAny, null);
			extract(action.extractResults, `!${q}.isError`);
			extract(action.extractErrors, `${q}.isError`);

			return { bodyLines: lines, resultExpr: `(${q}.isError ? null : undefined)` };
		}

		//---- timers (timeouts.js: queue returns the timeout id; cancel clears it)
		if (t === 'queueDelayedActions') {
			if (!Array.isArray(action.actions))
				return { bodyLines: null };
			const scopeIds = [...(ctx.scopeIds ?? [])];
			if (action.id && !scopeIds.includes(action.id))
				scopeIds.push(action.id);
			const body = this.genActions(action.actions, { ...ctx, scopeIds, stopStmt: 'return;' }, indent + '\t');
			const d = this.temp('__delay');
			return {
				bodyLines: [
					`${indent}const ${d} = setTimeout(async () => {`,
					...body,
					`${indent}}, ${v(action.delay)});`
				],
				resultExpr: d
			};
		}

		if (t === 'cancelDelayedActions' || t === 'cancelIntervalActions') {
			const clear = t === 'cancelDelayedActions' ? 'clearTimeout' : 'clearInterval';
			const idExpr = v(action.delayId ?? action.intervalId);
			const tv = this.temp('__tid');
			ctx.pre.push(`const ${tv} = ${idExpr};`);
			return { bodyLines: [`${indent}if (${tv} && ${tv} !== 'undefined') ${clear}(${tv});`], resultExpr: null };
		}

		if (t === 'queueIntervalActions') {
			if (!Array.isArray(action.actions))
				return { bodyLines: null };
			const scopeIds = [...(ctx.scopeIds ?? [])];
			if (action.id && !scopeIds.includes(action.id))
				scopeIds.push(action.id);
			const body = this.genActions(action.actions, { ...ctx, scopeIds, stopStmt: 'return;' }, indent + '\t');
			const d = this.temp('__interval');
			return {
				bodyLines: [
					`${indent}const ${d} = setInterval(async () => {`,
					...body,
					`${indent}}, ${v(action.interval ?? action.delay)});`
				],
				resultExpr: d
			};
		}

		//---- DOM measurements (getComponentHeight/Width/Position.js)
		if (t === 'getComponentHeight' || t === 'getComponentWidth') {
			this.use('resolveId');
			const target = action.target !== undefined ? v(action.target) : (this.use('ownerId'), 'ownerId');
			const scroll = t === 'getComponentHeight'
				? (action.getScrollHeight ? 'scrollHeight' : 'clientHeight')
				: (action.getScrollWidth ? 'scrollWidth' : 'clientWidth');
			const el = this.temp('__el');
			ctx.pre.push(`const ${el} = document.getElementById(resolveId(${target}));`);
			return { bodyLines: [], resultExpr: `(${el} ? ${el}.${scroll} : undefined)` };
		}

		if (t === 'getComponentPosition') {
			this.use('resolveId');
			this.helper('__absPos');
			const target = action.target !== undefined ? v(action.target) : (this.use('ownerId'), 'ownerId');
			const el = this.temp('__el');
			ctx.pre.push(`const ${el} = document.getElementById(resolveId(${target}));`);
			return { bodyLines: [], resultExpr: `(${el} ? __absPos(${el}) : undefined)` };
		}

		//---- scrolling (scrollComponent.js / scrollToComponent.js)
		if (t === 'scrollComponent') {
			this.use('resolveId');
			const smooth = action.smooth ? '\'smooth\'' : '\'auto\'';
			const x = action.scrollPositionX !== undefined ? v(action.scrollPositionX) : 'null';
			const y = action.scrollPositionY !== undefined ? v(action.scrollPositionY) : 'null';
			if (action.targetSelectorAll !== undefined) {
				return { bodyLines: [`${indent}document.querySelectorAll(${v(action.targetSelectorAll)}).forEach(__n => __n.scrollTo({ behavior: ${smooth}, top: ${y}, left: ${x} }));`], resultExpr: null };
			}
			const sel = action.targetSelector !== undefined
				? `document.querySelector(${v(action.targetSelector)})`
				: `document.getElementById(resolveId(${v(action.target)}))`;
			const el = this.temp('__el');
			return {
				bodyLines: [
					`${indent}const ${el} = ${sel};`,
					`${indent}if (${el}) ${el}.scrollTo({ behavior: ${smooth}, top: ${y}, left: ${x} });`
				],
				resultExpr: null
			};
		}

		if (t === 'scrollToComponent') {
			this.use('resolveId');
			const el = this.temp('__el');
			return {
				bodyLines: [
					`${indent}const ${el} = document.getElementById(resolveId(${v(action.target)}));`,
					`${indent}if (${el}) ${el}.scrollIntoView({ behavior: ${action.smooth ? '\'smooth\'' : '\'auto\''}, block: ${action.alignVertical !== undefined ? v(action.alignVertical) : '\'nearest\''}, inline: ${action.alignHorizontal !== undefined ? v(action.alignHorizontal) : '\'nearest\''} });`
				],
				resultExpr: null
			};
		}

		//---- window.open (openUrl.js incl. #TOKEN#; openLinkInTab from actions.js)
		if (t === 'openUrl') {
			this.use('getExternalState');
			this.use('setExternalState');
			const u = this.temp('__url');
			return {
				bodyLines: [
					`${indent}let ${u} = ${v(action.url)};`,
					`${indent}if (${u}.includes('#TOKEN#')) {`,
					`${indent}\tconst __token = (getExternalState('app') ?? {}).token;`,
					`${indent}\tif (!__token) {`,
					`${indent}\t\tsetExternalState('NOTIFICATIONS', { newMsg: { msg: 'User isn\\'t logged in so token doesn\\'t exist', type: 'danger' } });`,
					`${indent}\t\treturn;`,
					`${indent}\t}`,
					`${indent}\t${u} = ${u}.replace('#TOKEN#', __token);`,
					`${indent}}`,
					`${indent}window.open(${u});`
				],
				resultExpr: null
			};
		}

		if (t === 'openLinkInTab') {
			const val = this.temp('__v');
			ctx.pre.push(`const ${val} = ${v(action.value)};`);
			if (action.lookupOptions === undefined)
				return { bodyLines: [`${indent}window.open(${val});`], resultExpr: null };
			return { bodyLines: [`${indent}window.open((${v(action.lookupOptions)}).find(__o => __o.id === ${val})?.url);`], resultExpr: null };
		}

		//---- misc transforms
		if (t === 'stringify') {
			const spacer = action.spacer !== undefined ? v(action.spacer) : 'undefined';
			const replacer = action.convertUndefinedToNull ? '(__k, __v) => __v === undefined ? null : __v' : 'null';
			return { bodyLines: [], resultExpr: `JSON.stringify(${v(action.value)}, ${replacer}, ${spacer})` };
		}

		if (t === 'splitString') {
			const tv = this.temp('__s');
			ctx.pre.push(`let ${tv} = (${v(action.value)}).split(${v(action.separator)});`);
			if (action.removeWhitespace)
				ctx.pre.push(`${tv} = ${tv}.join(' ').split(/(\\s+)/).filter(__x => __x.trim().length > 0);`);
			return { bodyLines: [], resultExpr: tv };
		}

		if (t === 'resolveScopedId') {
			//Engine semantics (actions/resolveScopedId.js): config is
			// { scopedId, anchorId = ownerId } and the result is
			// getAllScopedIds(`||<scopedId>||`, anchorId) — an ARRAY of every
			// matching id (consumers drill .0). value/target are never read.
			if (typeof action.scopedId !== 'string')
				throw new SkipScript('resolveScopedId without a scopedId string');
			if (/\{\{|\(\(/.test(action.scopedId))
				throw new SkipScript('resolveScopedId with a dynamic scopedId');
			this.use('resolveIds');
			const anchor = action.anchorId !== undefined ? `, ${v(action.anchorId)}` : '';
			return { bodyLines: [], resultExpr: `resolveIds(${JSON.stringify(`||${action.scopedId}||`)}${anchor})` };
		}

		if (t === 'deleteVariableKey') {
			const target = this.variableTarget(action, ctx);
			if (!target)
				return { bodyLines: null };
			const ident = this.assignableIdent(action.name, target, ctx);
			if (!ident || action.key === undefined)
				return { bodyLines: null };
			this.helper('__delKey');
			return {
				bodyLines: [
					`${indent}__delKey(${ident}, ${v(action.key)});`,
					...this.syncVarLines(action.name, target, ident, indent)
				],
				resultExpr: null
			};
		}

		return { bodyLines: null };
	}

	genLoop (action, ctx, indent) {
		const { type } = action;
		const recordVar = action.recordVarName ?? 'record';
		const rowVar = action.rowNumVarName ?? 'rowNum';
		const chainId = action.id ?? this.scriptId;

		const rec = this.temp('__rec');
		const row = this.temp('__row');

		const chainLocals = new Map(ctx.chainLocals ?? []);
		chainLocals.set(recordVar, rec);
		chainLocals.set(rowVar, row);
		const scopeIds = [...(ctx.scopeIds ?? [])];
		if (!scopeIds.includes(chainId))
			scopeIds.push(chainId);

		const loopCtx = { ...ctx, chainLocals, chainScopeId: chainId, scopeIds };

		const arr = this.temp('__arr');
		const valueExpr = this.valueExpr(action.value, { ...ctx, drilled: true });
		const pre = [Array.isArray(action.value)
			? `const ${arr} = ${valueExpr};`
			: `const ${arr} = ${valueExpr} ?? [];`];

		if (type === 'morphIterateArray') {
			if (!Array.isArray(action.chain))
				return { bodyLines: null };

			const hasStop = JSON.stringify(action.chain).includes('"stopScript"');
			const label = hasStop ? this.temp('__iter') : null;

			const body = this.genActions(action.chain, {
				...loopCtx,
				stopStmt: label ? `break ${label};` : loopCtx.stopStmt
			}, indent + (label ? '\t\t' : '\t'));

			const loop = [
				...pre.map(p => indent + p),
				`${indent}for (let ${row} = 0; ${row} < ${arr}.length; ${row}++) {`,
				`${indent}\tlet ${rec} = ${arr}[${row}];`
			];
			if (label) {
				loop.push(`${indent}\t${label}: {`);
				loop.push(...body);
				loop.push(`${indent}\t}`);
			} else
				loop.push(...body);
			loop.push(`${indent}}`);

			return { bodyLines: loop, resultExpr: null };
		}

		if (type === 'findInArray' || type === 'findIndexInArray' || type === 'filterArray') {
			const inner = { ...loopCtx, pre: [] };
			const cmp = this.comparisonExpr(action.comparison ?? action.condition, inner);
			if (cmp === null)
				return { bodyLines: null };
			const res = this.temp(type === 'filterArray' ? '__filtered' : '__found');

			const init = type === 'findIndexInArray'
				? `${indent}let ${res} = -1;`
				: (type === 'filterArray' ? `${indent}const ${res} = [];` : `${indent}let ${res};`);
			const hit = type === 'findIndexInArray'
				? `{ ${res} = ${row}; break; }`
				: (type === 'filterArray' ? `${res}.push(${rec});` : `{ ${res} = ${rec}; break; }`);

			return {
				bodyLines: [
					...pre.map(p => indent + p),
					init,
					`${indent}for (let ${row} = 0; ${row} < ${arr}.length; ${row}++) {`,
					`${indent}\tlet ${rec} = ${arr}[${row}];`,
					...inner.pre.map(p => `${indent}\t${p}`),
					`${indent}\tif (${cmp}) ${hit}`,
					`${indent}}`
				],
				resultExpr: res
			};
		}

		//mapArray
		//Runtime mapArray morphs mapTo via morphConfig with its isDrilling=true
		// default: the mapTo object's STRING values always resolve (no caret
		// needed); only nested un-careted OBJECT children drop drilling — which
		// valueExpr's own recursion already models.
		const inner = { ...loopCtx, pre: [] };
		const mapped = this.valueExpr(action.mapTo, { ...inner, drilled: true });
		const res = this.temp('__mapped');
		return {
			bodyLines: [
				...pre.map(p => indent + p),
				`${indent}const ${res} = [];`,
				`${indent}for (let ${row} = 0; ${row} < ${arr}.length; ${row}++) {`,
				`${indent}\tlet ${rec} = ${arr}[${row}];`,
				...inner.pre.map(p => `${indent}\t${p}`),
				`${indent}\t${res}.push(${mapped});`,
				`${indent}}`
			],
			resultExpr: res
		};
	}

	/*
		Pre-pass: names whose FIRST appearance in the action stream is a TOP-LEVEL
		setVariable get an inline `let name = …;` declaration; every other natively
		set name is hoisted (`let x = getVariable('x');` — engine init covers
		trigger-set values read before assignment).
	*/
	planVariables (actions) {
		const seen = new Set();

		for (const action of actions) {
			if (!action || typeof action !== 'object')
				continue;

			if (
				action.type === 'setVariable' &&
				typeof action.name === 'string' &&
				(action.scope === undefined || action.scope === this.scriptId) &&
				!action.actionCondition &&
				!seen.has(action.name)
			)
				this.inlinePlan.add(action.name);

			//Everything this action mentions counts as seen from here on.
			//"variable" covers network extract entries ({variable, path}) — their
			// assignment precedes any later setVariable, which must then NOT be
			// inline-declared (TDZ: assignment before `let`).
			const raw = JSON.stringify(action);
			for (const m of raw.matchAll(/variable\.([\w$-]+)/g))
				seen.add(m[1]);
			for (const m of raw.matchAll(/"(?:name|storeAsVariable|pushToVariable|variable)":\s*"([\w$-]+)"/g))
				seen.add(m[1]);
		}
	}
}

//Drop dead local bookkeeping the naive per-action emit leaves behind: (a) a
// "X = undefined;" reset (a deleteVariable) that nothing reads afterwards — pointless
// for a function-scoped local about to be GC'd; and (b) a bare "let X;" declaration
// for a local that is then never referenced at all (e.g. a reserved-name-collision
// var whose only use was that reset). Reference-counted with identifier boundaries so
// side-effecting assignments and real reads are never touched.
const pruneDeadLocals = (hoisted, body) => {
	const ref = ident => new RegExp('(?<![\\w$])' + ident.replace(/\$/g, '\\$') + '(?![\\w$])');
	const refG = ident => new RegExp('(?<![\\w$])' + ident.replace(/\$/g, '\\$') + '(?![\\w$])', 'g');
	const count = (ident, lines) => lines.reduce((a, l) => a + (l.match(refG(ident))?.length ?? 0), 0);

	//(a) remove "X = undefined;" lines with no later reference to X.
	const prunedBody = [];
	for (let i = 0; i < body.length; i++) {
		const m = /^\s*([A-Za-z_$][\w$]*)\s*=\s*undefined;\s*$/.exec(body[i]);
		if (m && !body.slice(i + 1).some(l => ref(m[1]).test(l)))
			continue;
		prunedBody.push(body[i]);
	}

	//(b) remove "let X;" (no initialiser) for X unused everywhere else.
	const prunedHoisted = hoisted.filter(h => {
		const m = /^\s*let\s+([A-Za-z_$][\w$]*)\s*;\s*$/.exec(h);
		if (!m)
			return true;
		return count(m[1], hoisted.filter(x => x !== h)) + count(m[1], prunedBody) > 0;
	});

	return { hoisted: prunedHoisted, body: prunedBody };
};

//Pretty-print generated code: re-indent by brace depth and break statement blocks
// onto their own lines. Whitespace-only and string/template/regex/comment-aware, so
// it can never change behaviour. A '{' whose body has top-level statements (a real
// block) goes multi-line; short object/destructuring/import braces stay inline.
const formatCode = src => {
	let n = src.length;

	//End (exclusive) of an opaque span at i, or -1 if src[i] doesn't start one.
	const opaqueEnd = i => {
		const c = src[i];
		if (c === '\'' || c === '"') {
			for (let j = i + 1; j < n; j++) {
				if (src[j] === '\\') { j++; continue; }
				if (src[j] === c) return j + 1;
			}
			return n;
		}
		if (c === '`') {
			let j = i + 1;
			while (j < n) {
				if (src[j] === '\\') { j += 2; continue; }
				if (src[j] === '`') return j + 1;
				if (src[j] === '$' && src[j + 1] === '{') {
					let depth = 1;
					j += 2;
					while (j < n && depth > 0) {
						const o = opaqueEnd(j);
						if (o !== -1) { j = o; continue; }
						if (src[j] === '{') depth++;
						else if (src[j] === '}') depth--;
						j++;
					}
					continue;
				}
				j++;
			}
			return n;
		}
		if (c === '/') {
			if (src[i + 1] === '/') { let j = i + 2; while (j < n && src[j] !== '\n') j++; return j; }
			if (src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); return e === -1 ? n : e + 2; }
			let k = i - 1;
			while (k >= 0 && /\s/.test(src[k])) k--;
			if (k >= 0 && /[\w$)\].]/.test(src[k])) return -1;
			let j = i + 1;
			let inClass = false;
			let closed = false;
			while (j < n) {
				if (src[j] === '\\') { j += 2; continue; }
				if (src[j] === '\n') break;
				if (src[j] === '[') inClass = true;
				else if (src[j] === ']') inClass = false;
				else if (src[j] === '/' && !inClass) { j++; closed = true; break; }
				j++;
			}
			if (!closed) return -1;
			while (j < n && /[a-z]/i.test(src[j])) j++;
			return j;
		}
		return -1;
	};
	const matchBrace = open => {
		let depth = 0;
		for (let j = open; j < n;) {
			const o = opaqueEnd(j);
			if (o !== -1) { j = o; continue; }
			if (src[j] === '{') depth++;
			else if (src[j] === '}' && --depth === 0) return j;
			j++;
		}
		return n - 1;
	};
	//A brace goes multi-line if its body contains a ';' or a newline ANYWHERE (outside
	// opaque spans) — i.e. it holds statements/logic (a block, an object/arg carrying an
	// IIFE or callback, or an ASI body whose newlines separate statements). Pure single-
	// line data braces (no ';', no newline) stay inline.
	const isBlockBody = (open, close) => {
		for (let j = open + 1; j < close;) {
			const o = opaqueEnd(j);
			if (o !== -1) { j = o; continue; }
			if (src[j] === ';' || src[j] === '\n') return true;
			j++;
		}
		return false;
	};

	//Collapse every run of inter-token whitespace (outside opaque spans) to a single
	// space, so the structural pass below owns ALL layout — otherwise the source's
	// stray tabs / JSON-era indentation leak through (e.g. `if (c)\t\treturn;` or
	// `{       field: … }`). Whitespace inside strings/templates/regex/comments is
	// preserved because opaqueEnd skips those.
	{
		let norm = '';
		let p = 0;
		while (p < n) {
			const o = opaqueEnd(p);
			if (o !== -1) { norm += src.slice(p, o); p = o; continue; }
			if (/\s/.test(src[p])) {
				//Collapse the run, but KEEP a newline if the run had one — a newline can
				// be an ASI statement separator (e.g. `if (c) f()\nelse g()`); dropping it
				// to a space would change semantics.
				let nl = false;
				while (p < n && /\s/.test(src[p])) { if (src[p] === '\n') nl = true; p++; }
				norm += nl ? '\n' : ' ';
				continue;
			}
			norm += src[p];
			p++;
		}
		src = norm.trim();
		n = src.length;
	}

	let out = '';
	let indent = 0;
	let round = 0;
	const roundStack = [];
	let atLineStart = true;
	const newline = () => {
		out = out.replace(/[ \t]+$/, '');
		if (!out.endsWith('\n'))
			out += '\n';
		out += '\t'.repeat(Math.max(0, indent));
		atLineStart = true;
	};
	const emit = s => { out += s; if (/\S/.test(s)) atLineStart = false; };

	let i = 0;
	while (i < n) {
		const oe = opaqueEnd(i);
		if (oe !== -1) { emit(src.slice(i, oe)); i = oe; continue; }
		const c = src[i];
		if (c === '\n' || c === '\r') { if (!atLineStart) newline(); i++; continue; }
		if (atLineStart && (c === ' ' || c === '\t')) { i++; continue; }
		if (c === '{') {
			const close = matchBrace(i);
			if (isBlockBody(i, close)) {
				emit('{');
				roundStack.push(round);
				round = 0;
				indent++;
				newline();
				i++;
				continue;
			}
			emit(src.slice(i, close + 1));
			i = close + 1;
			continue;
		}
		if (c === '}') {
			indent--;
			round = roundStack.length ? roundStack.pop() : 0;
			newline();
			emit('}');
			//What follows the block close: `else`/`catch`/`finally`/`while` stay on the
			// same line (` } else {`), a new statement starts a new line, and closing
			// punctuation ( ) ] , ; . } ) is emitted adjacent.
			let j = i + 1;
			while (j < n && /\s/.test(src[j])) j++;
			const rest = src.slice(j);
			if (/^(else|catch|finally|while)\b/.test(rest))
				emit(' ');
			else if (j < n && !/^[)\]},;.]/.test(src[j]))
				newline();
			i = j;
			continue;
		}
		if (c === '(' || c === '[') { round++; emit(c); i++; continue; }
		if (c === ')' || c === ']') { round--; emit(c); i++; continue; }
		if (c === ';') {
			emit(';');
			if (round === 0) {
				let j = i + 1;
				while (j < n && /\s/.test(src[j])) j++;
				if (src[j] !== '}')
					newline();
			}
			i++;
			continue;
		}
		emit(c);
		i++;
	}
	return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
};

const generateScript = ({ scriptId, actions, traitResolver, ensembles, syncVars }) => {
	if (!Array.isArray(actions))
		actions = [actions];

	const gen = new Codegen({ scriptId: scriptId ?? 'script', traitResolver, ensembles, syncVars });
	gen.planVariables(actions);

	const ctx = { drilled: true, scopeIds: [gen.scriptId], chainLocals: null, pre: [], stopStmt: 'return;' };

	let body;
	try {
		body = gen.genActions(actions, ctx, '\t');
	} catch (e) {
		return { skip: e instanceof SkipScript ? e.message : `codegen error: ${e.message}` };
	}

	const argNames = [...gen.usesArgs].filter(a => a !== 'ownerId');
	if (gen.usesArgs.has('ownerId'))
		argNames.push('ownerId');

	const imports = [...gen.imports];
	if (gen.helpers.size) {
		const names = [...gen.helpers]
			.sort((a, b) => Object.keys(HELPERS).indexOf(a) - Object.keys(HELPERS).indexOf(b));
		imports.push(`import { ${names.join(', ')} } from '${HELPER_MODULE}';`);
	}

	const { hoisted, body: prunedBody } = pruneDeadLocals(gen.hoisted, body);

	const code = formatCode([
		...(imports.length ? [...imports, ''] : []),
		`const script = async ({ ${argNames.join(', ')} }) => {`,
		...hoisted.map(l => '\t' + l),
		...prunedBody,
		'};',
		'',
		'export default script;',
		''
	].join('\n'));

	//Repeater placeholders: verbatim spans keyed by param name — the converter
	// emits these under the action's __rowParams so the repeater keeps
	// substituting them per row.
	const rowParams = gen.rowParams.size
		? Object.fromEntries([...gen.rowParams].map(([span, name]) => [name, span]))
		: null;

	//Trait-prp wildcards: same idea via __traitParams — the trait engine
	// substitutes the verbatim spans per application.
	const traitParams = gen.traitParams.size
		? Object.fromEntries([...gen.traitParams].map(([span, name]) => [name, span]))
		: null;

	return { code, stats: gen.stats, rowParams, traitParams };
};

module.exports = { generateScript, buildHelperModule, HELPER_MODULE, NATIVE_TYPES };
