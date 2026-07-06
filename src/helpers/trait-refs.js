/* eslint-disable no-console */

/*
	trait-refs

	Shared between single-use-traits.js and merge-single-use-traits.js: finds every
	trait file (JSON with top-level acceptPrps) and counts every reference to each
	one from anywhere in the workspace (all ensemble JSON/JS/JSX, the app folder,
	legoz/src, and optionally the menu dataset).
*/

const fs = require('fs');
const path = require('path');

/*
	computeTraitRefs(scanner, { entrypointsPath, field }) ->
	  {
	    traitFiles: Map(key -> file),
	    refsTo:     Map(key -> [{ referrer, referrerPath, via }])
	  }

	The scanner must come from createScanner(); registerSrcFiles() is called here.
	entrypointsPath is optional — when given, menu dataset values count as references
	(referrer '(menu dataset)').
*/
const computeTraitRefs = (scanner, { entrypointsPath, field } = {}) => {
	const { files, key, scanFile, processRef, readJson, registerSrcFiles, parseEntrypointsFile } = scanner;

	registerSrcFiles();

	//---- find trait files
	const traitFiles = new Map();

	for (const [k, f] of files) {
		if (f.kind !== 'json' || f.ensemble === '(src)')
			continue;

		const json = readJson(k);
		if (json && typeof json === 'object' && !Array.isArray(json) && json.acceptPrps !== undefined)
			traitFiles.set(k, f);
	}

	//---- count references
	const refsTo = new Map();

	const countingSinkFor = referrerFile => (p, via) => {
		const k = key(p);

		if (!traitFiles.has(k))
			return;

		//A file mentioning itself is not an import.
		if (referrerFile.path !== '(menu dataset)' && key(referrerFile.path) === k)
			return;

		if (!refsTo.has(k))
			refsTo.set(k, []);

		refsTo.get(k).push({
			referrer: referrerFile.relPath,
			referrerPath: referrerFile.path,
			via
		});
	};

	for (const [k, f] of files)
		scanFile(k, countingSinkFor(f), null);

	if (entrypointsPath && fs.existsSync(entrypointsPath)) {
		const rootFile = { path: '(menu dataset)', relPath: '(menu dataset)', ensemble: null, kind: 'json' };
		const sink = countingSinkFor(rootFile);
		for (const v of parseEntrypointsFile(path.resolve(entrypointsPath), field))
			processRef(v, rootFile, sink, null);
	}

	return { traitFiles, refsTo };
};

//Resolve the default entrypoints file next to the tools (entrypoints.txt > .json > sample).
const defaultEntrypointsPath = toolDir => {
	for (const cand of ['entrypoints.txt', 'entrypoints.json', 'entrypoints.sample.txt']) {
		const p = path.join(toolDir, cand);
		if (fs.existsSync(p))
			return p;
	}

	return null;
};

module.exports = { computeTraitRefs, defaultEntrypointsPath };
