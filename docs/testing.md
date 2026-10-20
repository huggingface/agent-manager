# Testing

Every test is a plain `*.test.mjs` file in `server/test/`, `web/test/`, or the
root of `server/`. There is no list to edit: `scripts/run-suites.mjs` finds the
files. Some suites use `node:test`; others are scripts that print their checks
and exit non-zero on a failure. Either kind runs the same way.

One-time setup: `npm ci` in both `server/` and `web/`. The browser suites drive
Playwright's Chromium (`npx playwright install chromium` from `web/`, or a
browser already under `PLAYWRIGHT_BROWSERS_PATH`).

## Run everything

From the repository root:

```bash
npm test
```

This runs every server and web suite plus the web typecheck (`tsc --noEmit`) in
one pool, one job per free core (cores minus the load average, at least 3). It
takes about two minutes on an idle 8-core machine, longer on a busy one.
Each finished suite prints one line. A failing suite prints its whole output.
The run doesn't stop at a failure: it finishes everything, then lists every
failed suite and exits non-zero.

`cd server && npm test` and `cd web && npm test` run one package the same way.

Options (after `--`, e.g. `npm test -- --jobs 4`):

| Option | Effect |
|---|---|
| `<substring> …` | only suites whose path (`server/test/pin.test.mjs`) contains one of them |
| `--jobs N` / `-j N` | N suites at a time (default: one per free core, at least 3; also `AM_TEST_JOBS`) |
| `--serial` | one at a time, output streamed live (same as `--jobs 1`) |
| `--verbose` | print every suite's output, not only failures |
| `--manual` | with a substring, also run matching suites marked manual |

`AM_SUITE_TIMEOUT` (seconds, default 600) kills a hung suite and its children
and counts it as failed.

## Run one suite

```bash
cd server && node test/pin.test.mjs          # directly
cd web && node test/lazyPanels.test.mjs
node --test --test-reporter=tap test/pin.test.mjs   # the same, TAP output
npm test -- pin                              # through the runner
```

A suite that serves the production build (`lazyPanels`, `framing.browser`, the
UI suites) builds the web app itself when run directly. Set `AM_TEST_DIST` to
an existing build to skip that step (`npx vite build --outDir /tmp/dist` from
`web/`). The runner builds once per run and passes the folder to every suite
that needs it.

## Writing a suite that runs in parallel

Suites run side by side, so a suite must not take anything another suite could
also take:

- **Ports:** never a fixed number. Use `freePort()` from
  `server/test/free-port.mjs`, or `listen(0)` and read the port back.
  `startFixtureServer()` in `web/test/helpers/` picks a free port when it isn't
  given one.
- **Files:** scratch state goes in `fs.mkdtempSync(path.join(os.tmpdir(), …))`,
  never a fixed path. Under `web/node_modules/.test-build/`, use a file name no
  other suite uses.
- **The web build:** use `buildWeb()` from `web/test/helpers/fixture-server.mjs`,
  which returns `AM_TEST_DIST` when it's set. A suite that writes into the
  build must copy it first.
- **Waiting:** wait for a condition, not a fixed time. A 20 ms wait that always
  passes on an idle machine fails when 8 suites share the CPU.

If a suite really needs the machine to itself, put `am-test: serial` and the
reason in its header. It then runs alone after the parallel ones. Three do
today: `server/test/loop-offload` (it measures event-loop lag in milliseconds),
`web/test/dispatchPreviewScroll` (real wheel and touch gestures) and
`web/test/readerSearch` (an unexplained misplacement seen only under a
saturated parallel run; its failure message carries the reads).

The runner records how long each suite took in
`web/node_modules/.cache/am-suite-times.json` and starts the longest ones first.
Deleting that file only changes the order.

## Manual and live suites

A suite with `am-test: manual — <reason>` in its first 4 KB is left out of the
default run. Every run lists what it skipped and why. To run one, name it and
add `--manual`:

```bash
npm test -- codex-creation-live --manual
```

| Suite | Why it's manual | Run with |
|---|---|---|
| `server/terminal-ui`, `screenshot-input`, `reader-info` | Chromium against a full web build; long | `cd server && npm run test:ui` |
| `server/mobile` | the same, at phone sizes | `cd server && npm run test:mobile` |
| `server/visibility-ui` | the same, with a fake Hub | `npm test -- visibility-ui --manual` |
| `web/test/*.render` (5 of them) | Chromium render checks | `cd web && npm run test:render` |
| `web/test/codexShared.render` | Chromium and a local HTTP listener | `npm test -- codexShared --manual` |
| `server/test/codex-*-live`, `codex-shared-pilot` | need an installed Codex CLI and local sockets; isolated homes, no model calls | `npm test -- codex- --manual` |
| `server/test/delegation-live` | **real model calls**: needs the operator's explicit authorization | by hand only |

Live suites start real CLIs. Run them under `env -i` with an explicit allowlist
and scratch `HOME`/`TMPDIR`, never with a shell that exports a live
`CODEX_HOME`, `CLAUDE_CONFIG_DIR` or `*_DURABLE`:

```bash
H=$(mktemp -d)
env -i PATH="$PATH" HOME="$H" TMPDIR="$H" LANG=C.UTF-8 \
  PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" npm test
```

The same applies to the default run on a machine that hosts live agents.
