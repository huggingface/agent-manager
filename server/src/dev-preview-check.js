// May this previewed build start? entrypoint.sh's supervisor runs this from the
// IMAGE's copy (/app/.image/server/src/dev-preview-check.js) before every
// launch of a previewed build, including a relaunch after exit 75, so the
// decision never rests on the previewed build's own copy of the switcher.
//
//   node /app/.image/server/src/dev-preview-check.js <release dir>
//
// Exit 0: every PR in the release is still open, on the repository itself,
// at the SHA it was built from, and its author still has write, maintain or
// admin permission. Otherwise exit 1 with the reason on stdout. A check that
// cannot be completed (no token, GitHub down, rate limited, unreadable
// release) is a refusal. The GitHub token is the server's (githubTokenSource()
// in dev-preview.js): GH_TOKEN, GITHUB_TOKEN, or the `gh auth login` under the
// HOME that entrypoint.sh exports and this process inherits.
import fs from 'node:fs';
import path from 'node:path';
import { checkRelease } from './dev-preview.js';

const dir = process.argv[2];
let release = null;
try { release = JSON.parse(fs.readFileSync(path.join(String(dir || ''), 'release.json'), 'utf8')); } catch {}
const result = release ? await checkRelease(release) : { ok: false, reason: `no readable release.json in ${String(dir || '(none)').slice(0, 200)}` };
if (!result.ok) {
  console.log(result.reason);
  process.exit(1);
}
process.exit(0);
