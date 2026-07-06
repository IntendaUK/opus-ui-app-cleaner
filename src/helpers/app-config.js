/*
	app-config — resolves WHERE the Opus UI app lives and WHICH ensembles it
	uses. Single source of truth for every tool in this suite.

	Resolution order for the app root:
	  1. --app=<dir>                 (CLI override)
	  2. --workspace=<dir>           (legacy: <workspace>/legoz)
	  3. ../config.json  "appPath"   (relative to this tool's root, or absolute)

	Ensembles then come from the APP itself:
	  <app>/package.json  ->  opusUiConfig.externalOpusUiConfig (e.g.
	  ".opusUiConfig-master") -> that file's opusUiEnsembles list (falling back
	  to package.json's own opusUiEnsembles) — the same precedence the Opus UI
	  packager uses.
*/

const fs = require('fs');
const path = require('path');

const TOOL_ROOT = path.join(__dirname, '..', '..');

const norm = p => path.resolve(p).replace(/\\/g, '/');

const fail = msg => {
	console.error(msg);
	process.exit(1);
};

const resolveAppDir = (args = {}) => {
	let dir;

	if (args.app)
		dir = path.resolve(String(args.app));
	else if (args.workspace)
		dir = path.resolve(String(args.workspace), 'legoz');
	else {
		const cfgPath = path.join(TOOL_ROOT, 'config.json');
		if (!fs.existsSync(cfgPath))
			fail('config.json not found in the tool root — create it with { "appPath": "<path to the app>" } (see README).');

		let cfg;
		try {
			cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
		} catch (e) {
			fail(`config.json is not valid JSON: ${e.message}`);
		}
		if (typeof cfg.appPath !== 'string' || !cfg.appPath)
			fail('config.json must define "appPath" — where the Opus UI app (e.g. legoz) lives.');

		dir = path.isAbsolute(cfg.appPath) ? cfg.appPath : path.resolve(TOOL_ROOT, cfg.appPath);
	}

	if (!fs.existsSync(path.join(dir, 'package.json')))
		fail(`App root has no package.json: ${dir} — check config.json's appPath (or --app).`);
	if (!fs.existsSync(path.join(dir, 'app')))
		fail(`App root has no app/ folder: ${dir} — expected an Opus UI app layout.`);

	return dir;
};

//Ensemble registry: package.json opusUiEnsembles, overridden by the external
// opusUiConfig file when present (packager precedence).
const readEnsembles = appDir => {
	const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf-8'));

	let entries = pkg.opusUiEnsembles ?? [];

	const externalCfgName = pkg.opusUiConfig?.externalOpusUiConfig ?? '.opusUiConfig';
	const externalCfgPath = path.join(appDir, externalCfgName);
	if (fs.existsSync(externalCfgPath)) {
		try {
			const cfg = JSON.parse(fs.readFileSync(externalCfgPath, 'utf-8'));
			if (cfg.opusUiEnsembles)
				entries = cfg.opusUiEnsembles;
		} catch {
			console.warn(`Could not parse ${externalCfgPath}, falling back to package.json`);
		}
	}

	return entries.map(e => {
		const name = e.name ?? e;
		let root;

		if (e.external && e.path)
			root = e.path;
		else if (fs.existsSync(path.join(appDir, '..', name)))
			root = path.join(appDir, '..', name);
		else
			root = path.join(appDir, 'node_modules', e.path ?? name);

		return { name, root: norm(root) };
	}).filter(e => {
		const ok = fs.existsSync(e.root);
		if (!ok)
			console.warn(`Ensemble folder missing, skipped: ${e.name} (${e.root})`);

		return ok;
	});
};

/*
	Rel paths across the suite are "<ensembleName>/inner/path" (or
	"<appBasename>/inner/path" for app files). This builds the inverse:
	rel -> absolute, via the ensemble registry — roots can live anywhere.
*/
const makeRelResolver = (appDir, { withRoots = false } = {}) => {
	const ensembles = readEnsembles(appDir);
	const byName = new Map(ensembles.map(e => [e.name, e]));
	const appBase = path.basename(appDir);

	const rootOf = relPath => {
		const head = String(relPath).replace(/\\/g, '/').split('/')[0];
		if (byName.has(head))
			return byName.get(head).root;
		if (head === appBase)
			return norm(appDir);
		return null;
	};

	const absFromRel = relPath => {
		const clean = String(relPath).replace(/\\/g, '/');
		const idx = clean.indexOf('/');
		const head = idx === -1 ? clean : clean.slice(0, idx);
		const rest = idx === -1 ? '' : clean.slice(idx + 1);
		const root = rootOf(head);
		if (!root)
			return null;
		return rest ? path.join(root, rest) : root;
	};

	if (!withRoots)
		return absFromRel;

	return { absFromRel, rootFor: rootOf, ensembles };
};

module.exports = { resolveAppDir, readEnsembles, makeRelResolver };
