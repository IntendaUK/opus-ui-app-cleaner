/*
	Vanilla network helpers for converted source actions — fetch-based ports of the
	legoz queryUrl/queryGateway script actions (legoz/src/scriptActions/queryUrl.js,
	queryGateway.js) and opus performRequest (rxjs ajax semantics: JSON in/out,
	non-2xx REJECTS with { response, status }).

	Helpers RETURN { res, isError } — res is the response envelope on success or the
	error envelope on failure (mirroring the declarative catch-path where extractAny
	extracts from the error). The caller (generated code) does its own extraction
	natively. saveToState and licence checking need state access, so callers pass
	{ getExternalState, setExternalState, resolveId } as ctx.

	The gateway URL comes from the system theme ("{theme.system.gatewayLocation}" is
	resolved to the real URL by applyThemesToMdaPackage at app boot). The gateway
	token mirrors the constant in legoz/src/main.jsx.

	NOTE: this file must be COMMITTED to l2_util — generated actions import it, and
	an untracked copy gets wiped by `git clean`.
*/

const requestCache = new Map();

export const performRequest = async ({ url, method = 'GET', headers = { 'Content-Type': 'application/json' }, body, crossDomain }) => {
	const startTime = Date.now();

	const init = {
		method,
		headers
	};

	if (body !== undefined) {
		if (body instanceof FormData) {
			init.body = body;
			//fetch sets the multipart boundary itself
			init.headers = { ...headers };
			delete init.headers['Content-Type'];
		} else if (headers['Content-Type'] === 'application/json')
			init.body = JSON.stringify(body);
		else
			init.body = body;
	}

	if (crossDomain !== undefined)
		init.mode = crossDomain ? 'cors' : 'same-origin';

	const res = await fetch(url, init);

	let parsed = null;
	const text = await res.text();
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = text;
	}

	const envelope = {
		response: parsed,
		status: res.status,
		duration: Date.now() - startTime
	};

	//rxjs ajax rejects on non-2xx — replicate so catch-path extraction matches.
	if (!res.ok)
		throw envelope;

	return envelope;
};

const buildBody = ({ body, bodyIsFormData }) => {
	if (!bodyIsFormData)
		return body;

	const result = new FormData();
	Object.entries(body).forEach(([k, v]) => {
		if (v && v[0] && v[0] instanceof Blob) {
			for (const vv of v)
				result.append(k, vv);
			return;
		}
		result.append(k, v);
	});
	return result;
};

const deep = (v, p) => {
	for (const s of String(p).split('.')) {
		if (v === null || v === undefined)
			return v;
		v = v[s];
	}
	return v;
};

const checkAndSetLicenceStatus = (ctx, err) => {
	const { response, status } = err ?? {};

	if (
		status === 423 && response &&
		(Object.hasOwn(response, 'license_error') || Object.hasOwn(response, 'not_installed'))
	) {
		ctx.setExternalState('systemDashboard', {
			userLicenceData: {
				licence_status: 'inactive',
				...response
			}
		});
	}
};

const saveResultInState = (action, ctx, envelope) => {
	const { saveToStateKey, saveToStateSubKey, target } = action;
	if (!saveToStateKey || !target)
		return;

	const data = deep(envelope, 'response.result.0.serviceresult.response');
	if (data && data[0] && data[0].error)
		return;

	if (!saveToStateSubKey)
		ctx.setExternalState(target, { [saveToStateKey]: data });
	else {
		const currentPropData = (ctx.getExternalState(target) ?? {})[saveToStateKey];
		ctx.setExternalState(target, { [saveToStateKey]: { ...currentPropData, [saveToStateSubKey]: data } });
	}
};

export const queryUrl = async (action, ctx) => {
	const { url, method, headers, cache, crossDomain, checkExpiredLicence = false } = action;

	const request = { url, method, headers, body: buildBody(action) };
	if (crossDomain !== undefined)
		request.crossDomain = crossDomain;

	try {
		let envelope = null;
		const cacheKey = cache ? JSON.stringify({ url, method, body: action.body }) : null;

		if (cache && requestCache.has(cacheKey))
			envelope = requestCache.get(cacheKey);

		if (!envelope) {
			envelope = await performRequest(request);
			if (cache)
				requestCache.set(cacheKey, envelope);
		}

		if (!action.extractAny && !action.extractResults)
			saveResultInState(action, ctx, envelope);

		return { res: envelope, isError: false };
	} catch (e) {
		if (checkExpiredLicence)
			checkAndSetLicenceStatus(ctx, e);

		return { res: e, isError: true };
	}
};

//Mirrors legoz/src/main.jsx
//Injected at boot via main.jsx -> theme splice (applyThemesToMdaPackage) —
//the credential lives in the app, never in this tool.
const GATEWAY_TOKEN = '{theme.system.gatewayToken}';

export const queryGateway = async (action, ctx) => {
	const {
		queryUrl: url,
		queryData,
		queryHeaders,
		serializeAttrs,
		defaultEmptyStrings,
		cache,
		...actionData
	} = action;

	const requestData = {
		url: url ?? '{theme.system.gatewayLocation}',
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...queryHeaders },
		body: {
			token: GATEWAY_TOKEN,
			...queryData
		}
	};

	const attrs = requestData.body.parameters?.attrs;
	if (attrs && defaultEmptyStrings !== undefined) {
		attrs.forEach(a => {
			if (a.val === '')
				a.val = defaultEmptyStrings;
		});
	}

	if (attrs && serializeAttrs)
		requestData.body.parameters.attrs = JSON.stringify(attrs);

	return queryUrl({
		...actionData,
		...requestData,
		cache,
		checkExpiredLicence: true
	}, ctx);
};
