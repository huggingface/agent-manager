// Which Chromium the browser-level tests should drive.
//
// `chromium.launch()` with no executablePath demands the EXACT build the
// installed Playwright expects, and fails with "Looks like Playwright was just
// installed or updated / npx playwright install" if the machine has any other
// revision. That is a real failure mode here rather than a hypothetical: this
// workspace ships a shared browser under PLAYWRIGHT_BROWSERS_PATH (rev 1208 at
// the time of writing) while `playwright@^1.62` asks for 1234, so every browser
// suite died before running a line of app code — and the message blames a missing
// install rather than a mismatch, which sends you off to download 115MB you
// already have.
//
// Order of preference:
//   1. PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH — an explicit answer always wins.
//   2. the newest chromium under PLAYWRIGHT_BROWSERS_PATH, whatever its revision.
//   3. undefined — let Playwright resolve its own download, which is what CI and
//      an ordinary dev machine want. The error, if any, stays Playwright's.
//
// Driving a revision Playwright wasn't built against is a deliberate trade: these
// suites use long-stable APIs (newPage, setContent, addScriptTag, keyboard,
// screenshots), and a browser that is one build off is worth far more than a
// suite nobody can run.
import fs from 'node:fs';
import path from 'node:path';

// Full chromium first: it can run headed as well as headless, where
// chrome-headless-shell cannot. Both are accepted — the shell alone is enough for
// the headless suites, and on some images it is all that was fetched.
const FAMILIES = [
  { dir: /^chromium-(\d+)$/, exe: ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'] },
  { dir: /^chromium_headless_shell-(\d+)$/, exe: ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-headless-shell-linux/chrome-headless-shell'] },
];

export function chromiumExecutablePath() {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (explicit) return fs.existsSync(explicit) ? explicit : undefined;

  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !fs.existsSync(root)) return undefined;

  let entries;
  try { entries = fs.readdirSync(root); } catch { return undefined; }
  for (const family of FAMILIES) {
    const found = entries
      .map((name) => ({ name, rev: Number((family.dir.exec(name) || [])[1]) }))
      .filter((e) => Number.isFinite(e.rev))
      .sort((a, b) => b.rev - a.rev);                 // newest revision present
    for (const { name } of found) {
      for (const rel of family.exe) {
        const p = path.join(root, name, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return undefined;
}

/**
 * Launch options for a headless run. Spread into `chromium.launch({...})`.
 *
 * `--no-sandbox` because these suites run inside a container as a non-root user
 * with no user namespaces, where Chromium's sandbox cannot initialise and the
 * browser exits immediately. It is scoped to tests driving content this repo
 * generated itself.
 */
export function chromiumLaunchOptions(extra = {}) {
  const executablePath = chromiumExecutablePath();
  return {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', ...(extra.args || [])],
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'args')),
  };
}
