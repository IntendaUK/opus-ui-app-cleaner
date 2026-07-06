# opus-ui-app-cleaner

Cleans up an Opus UI application workspace: deletes unused JSON, merges and
dedupes traits, strips dead props, and converts declarative scripts
(`scps` / `fireScript` / `dtaScps`) to vanilla-JS source actions.

## Configuration

The tool locates everything from **`config.json`** in this folder:

```json
{
	"appPath": "../../legoz"
}
```

- `appPath` — where the Opus UI **app** lives (relative to this folder, or
  absolute). It must contain a `package.json` and an `app/` folder.

From there the tool reads the app's own configuration — the same chain the
Opus UI packager uses:

1. `<app>/package.json` → `"opusUiConfig": { "externalOpusUiConfig": ".opusUiConfig-master" }`
   names an external config file inside the app folder.
2. That file's `opusUiEnsembles` list defines every ensemble and **where it
   resides** (external ensembles carry absolute `path`s; the rest resolve to
   siblings of the app or `<app>/node_modules`). When no external file exists,
   `package.json`'s own `opusUiEnsembles` is used.

Everything — scanning, cleanup, conversion, size reports, `revert` — operates
on exactly that set: the registered ensembles plus `<app>/app`.

Per-invocation overrides: `--app=<dir>` (ignore config.json) or the legacy
`--workspace=<dir>` (app assumed at `<workspace>/legoz`).

## Quick start

```bash
cd tools/opus-ui-app-cleaner

# 1. Reset the workspace to committed state (the suite mutates it)
npm run revert

# 2. Run the suite (dry-run preview: node run-suite.js without --apply)
npm start

# 3. Build the package
(cd ../../legoz && node node_modules/@intenda/opus-ui-packager/src/packager.js)
```

`npm run revert` restores every `l2_*` ensemble and `legoz/app` to committed
git state and clears this tool's run artifacts (`revert.js --dry` previews
what it would touch). `npm start` runs `run-suite.js --apply`.

With `--apply` the suite clears its own state from the previous run, then
repeats all steps in passes until a full pass changes nothing (content-hash
convergence). Without `--apply` everything runs in report-only mode.

## What it runs, in order

| Step | Script | Does |
|---|---|---|
| baseline | `check-refs.js` | records pre-existing reference issues |
| unused | `find-unused-files.js` | unused-file analysis (driven by the menu entrypoints) |
| delete | `delete-files.js` | moves unused JSON out of the workspace |
| acceptprps | `delete-accept-prps.js` | strips acceptPrps nothing consumes |
| collapse | `collapse-wrapper-traits.js` | removes pure passthrough traits |
| dedupe | `dedupe-identical-traits.js` | one canonical copy per duplicate trait |
| traitprps | `unused-traitprps.js` | strips dead call-site traitPrps |
| merge | `merge-single-use-traits.js` | inlines single-use traits |
| srcactions | `convert-scripts-to-srcactions.js` | declarative scripts → vanilla JS |
| check | `check-refs.js` | FAILS if the cleanup created new issues |
| redundant / themekeys | `redundant-prps.js`, `unused-theme-keys.js` | report-only, review by hand |

## Options

```
--apply               Mutate the workspace (default: dry-run). Self-cleans
                      internal state, loops passes to convergence.
--maxPasses=<n>       Convergence pass cap (default 6)
--skip=<names>        Skip named steps (see table above)
--entrypoints=<file>  Menu dataset file (see entrypoints.sample.txt)
--workspace=<dir>     Workspace root (default: two levels up from this folder)
```

## Outputs and undo

- Every step writes a `*-report.json` next to the scripts documenting exactly
  what changed; the summary prints total passes and workspace size before/after.
- `deleted-files/` and the `*-backup/` folders are the undo record for the
  latest run. They survive until the **next** `--apply` run clears them —
  commit the ensembles before re-running if you want to keep the escape hatch.
- Full revert: `npm run revert` (git-restores every ensemble + `legoz/app`
  and clears the run artifacts).

## App-specific point fixes

`convert-scripts-to-srcactions.js` contains a `POINT_FIXES` table: path-bound
patches applied to specific scripts of THIS app before conversion (e.g. the
formInput down-sync focus guard). They are inert for any other app — no path
match, no patch. Add new entries there when a script needs app-specific
hardening that shouldn't become a general conversion rule.

## Conversion notes

- Scripts that can't be converted safely stay declarative and are listed in
  `convert-report.json` with a reason (trait-prp wildcards, nested-repeater
  scoped placeholders, scopedVariable reads, dynamic configs …). Fail-closed:
  the tool never emits code it can't prove faithful.
- Repeater `((rowData.x))` placeholders convert via `__rowParams` (the span
  stays in JSON where the repeater substitutes it per row).
- Cross-script `scopedVariable` producers get `setVariable()` engine-store
  syncs emitted automatically.
- The generated JS relies on interface members added to opus-ui's
  `wrapScriptHandlerInActions` (`resolveId`, `resolveIds`, `setVariable`,
  `theme`, `getIdsWithTag`, `createFlow`, …) — the app must run an opus-ui
  build that includes them.
