# Federation v1 validation — 2026-10-15

Base: `bddb4d0` on main, after PR #160 was merged. Separate branch; no production
service, tailnet policy or existing session changed.

## Completed

- `node ../scripts/run-suites.mjs federation request-admission codex-input codex-launch-policy agent-activity operations`
  from `server/`: 8 relevant suites passed, including isolated AM HTTP and fake
  Codex-daemon fixtures, activity dates, legacy-launch guards and audit behavior.
- After final federation changes, re-ran `federation` and `codex-input`: **18
  federation cases and 17 Codex input cases passed**. The new native adapter case
  confirms `thread/queue/add`, peer-attributed receipt and absence of terminal,
  turn/start, steer or interrupt delivery.
- `npm run build` from `web/`: TypeScript check and Vite production build passed.
  Existing bundle-size advisory remains. No frontend changes in this PR.
- `node --check` on all added runtime/CLI modules and `server/src/index.js`, plus
  `git diff --check`: passed. The repository has no configured lint script.
- Installed VPS Tailscale 1.102.1: read-only CLI check confirmed this machine's
  `whois --json` includes a usable `Node.StableID`. No peer was contacted and no
  identity/account/secret values were printed.

The federation tests cover bidirectional receipts/rosters, offline/reconnect,
expiry, native ambiguity and restart, nonce replay across restart, tampered MAC,
revocation, exact device identity, forbidden sender/target/capability, strict
private file ownership/mode, a real loopback HTTP exchange with injected Tailscale
identity fixtures, rate limits, bounded UTF-8/JSON/message budgets, a single
journal owner, explicit dead-PID unlock, slow roster isolation, queue fairness,
local attribution, default-disabled/broad-bind refusal, offline pairing/rotation,
and privacy lock protection including cached roster data.

## Explicitly not validated / rollout gates

- No actual two-device Tailscale pairing or laptop/macOS run. The socket fixtures
  model tailnet addresses; they do not prove the operator's ACL/proxy policy.
- No production install, session creation, model inference, migration, reboot,
  daemon bootstrap, notification or external peer message.
- Full browser/UI suite not run; no UI behavior is added or changed here. The
  entire repository test fleet is not claimed green, only the suites above.
- Before rollout: administrator must prove the peer cannot reach the normal AM
  API through any route/proxy; pair disposable loaded Codex tasks; test actual
  sleep/wake, attribution, denial from another tailnet device and revocation.
- Other CLIs are roster-only. No attachments, files, remote shell or auto-spawn.
  A future delivery adapter needs equivalent active-turn and duplicate protection.
- Failure after the persisted dispatch boundary is conservatively uncertain,
  even if native preflight eventually rejected before inference. Inspect the
  target transcript before considering any new task; there is no automatic retry.
- A crash leaves an exclusive process lock. Use the documented dead-PID unlock;
  do not delete the journal or bypass an ambiguous/live owner.
