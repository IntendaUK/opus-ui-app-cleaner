/*
	json-doc — tiny shared helpers for tools that rewrite workspace JSON files.
	Files are written tab-indented with no trailing newline (the same canonical
	format the validate-json hook and the other tools in this folder produce).
*/

const fs = require('fs');

const loadDoc = absPath => {
	try {
		return JSON.parse(fs.readFileSync(absPath, 'utf-8').replace(/^﻿/, ''));
	} catch {
		return undefined;
	}
};

const saveDoc = (absPath, doc) => {
	fs.writeFileSync(absPath, JSON.stringify(doc, null, '\t'));
};

//Replace every string value (and array element) that exactly equals a key of
// `replacements` with its mapped value. Returns the number of replacements made.
const replaceStringsInDoc = (doc, replacements) => {
	let count = 0;

	const visit = v => {
		if (Array.isArray(v)) {
			for (let i = 0; i < v.length; i++) {
				if (typeof v[i] === 'string' && replacements.has(v[i])) {
					v[i] = replacements.get(v[i]);
					count++;
				} else
					visit(v[i]);
			}
		} else if (v !== null && typeof v === 'object') {
			for (const k of Object.keys(v)) {
				if (typeof v[k] === 'string' && replacements.has(v[k])) {
					v[k] = replacements.get(v[k]);
					count++;
				} else
					visit(v[k]);
			}
		}
	};

	visit(doc);
	return count;
};

//Standard --flag / --key=value CLI parsing used by every tool in this folder.
const parseArgs = () => {
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
	return args;
};

module.exports = { loadDoc, saveDoc, replaceStringsInDoc, parseArgs };
