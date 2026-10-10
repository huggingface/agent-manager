# Preserve AM's conversation UI across execution backends

The shared Codex pilot now adapts execution behind AM's existing conversation
contracts. It no longer presents a separate Codex Reader, connection button or
live response panel. Durable bindings and idempotent input receipts are retained.

| Existing contract | Shared server adaptation |
| --- | --- |
| `/api/sessions/:id/input` | Verify binding and operator intent, resolve AM attachments, send an exact native turn. No terminal keystrokes or settings overrides. |
| `/api/trace/:id` | Existing verified, paged rollout plus a bounded live snapshot using the same text/thinking/tool/result blocks. |
| Session state and input-required indicator | Server activity independent of the AM TUI. Sidebar and agent roster consume ordinary AM fields. |
| Existing Composer and attachment controls | Same draft, paste, upload and retry path for both backends. Images become native local-image inputs; documents retain AM's existing attachment context. |
| Existing InputRequiredNotice | Optional neutral choices/questions, answered through `/api/sessions/:id/answer`. Unsupported requests retain the terminal fallback. |
| Reader store, exchange renderer, search and scroll | Shared by both modes. No Codex-specific branch in ConversationView. |

The execution selector is `server/src/session-runtime.js`; protocol translation
is in `codex-view.js`. Protocol method names, raw request IDs, settings and socket
selection never belong to presentation components. Reader opening subscribes to
an already-loaded bound root task without starting a turn or changing policy.
Settings discovery remains read-only. A disconnected browser neither approves
requests nor interrupts work. Read-only file and bundle views do not subscribe.

Live records carry the exact native turn identity. The common Reader store
replaces only records for those turns, leaving historical rows, cursors, search
and manual reading position intact. Once the persisted final marker is read,
the live snapshot retires and the canonical transcript takes over. It never
reconstructs encrypted reasoning. Live retention is bounded; an overlarge turn
falls back to persisted history rather than replacing it with a partial cache.

Mobile Composer permits predictive input/autocorrection and reveals its input
only when it is outside the visible viewport, instead of centering the whole
page on every focus. These are common component changes, not backend branches.
The operator confirmed the terminal keyboard scrolling fix on the iPhone on
2026-10-10. Browser focus reveal cannot scroll the outer terminal shell
(`overflow: clip`); only xterm's own viewport scrolls. Chromium regressions cover
the 369px jump reproduced before the fix, including the full AM layout. This
confirmation does not establish every iOS workflow. The terminal renderer and
resize pipeline are retained; main's predictive-input and IME guards are kept.
Terminal resizes now retain the visible history row (or the live bottom) across
both browser viewport changes and the server's reset/snapshot pair. The anchor
is restored after snapshot parsing; native DOM scroll is accounted for rather
than relying solely on xterm's public scroll event.

Reader activity from the runtime adapter is authoritative even while byte-window
history is catching up. A null runtime activity clears stale working state.
Hydration also tolerates status-only notifications arriving during its history
read. On a cold attachment, the installed Codex version does not replay text
deltas emitted before subscription: new deltas appear live and completed items
supply the full text. This is distinct from the current working/idle state.

## Validation

- Real disposable Codex server + deterministic local Responses provider: standard
  input route, text and reasoning visible before completion, tools while waiting
  for approval, explicit approval and attachment image delivery. No external
  inference or live user task is used. A native model command resolves the exact
  AM identity without AM_ID. A question from another client is answered in Reader;
  an approval answered externally disappears before turn completion, and stale
  Reader responses are rejected. Input into that active external turn is refused.
  These are independent local protocol clients, not an automated iPhone app test.
  Also exercises an external client, a cold
  mid-turn attachment and a real TUI submission followed by Reader polling while
  work continues; closing the terminal socket leaves the TUI/task intact.
- Event adapter tests: exact task identity, thinking/tool/result normalization,
  neutral request choices, final-marker retirement and existing rollout identity.
- Common Reader store tests: live/persisted replacement without duplicate user
  prompts, no loss of preceding history, common delivery retry identity, current
  runtime activity during history catch-up, and unknown-state invalidation.
- Mobile terminal fixture: keyboard open/hide, live-bottom and manual-history
  anchors, native DOM scrolling, canonical reset/snapshot and control-key bar.
- Existing Reader history, small-scroll, exchange, mode-switch, terminal resize,
  HTTP admission/privacy and Codex binding/transport/input safety tests.

## Deliberate lifecycle boundaries

Closing a Reader or terminal view explicitly evicts its browser terminal cache
and disconnects its socket. Navigation still retains warm views. Neither action
stops the TUI or shared task. The shared pane offers **Interrupt current turn**
with the exact displayed native turn ID; AM verifies it again, and Codex rejects
a stale ID atomically. An accepted request disables that turn's button while its
completion arrives; uncertain failures are never retried automatically.

**Archive** / **Restore** change only AM visibility, durably. Mapping and history
are retained, ongoing work continues, and archived tasks remain observable but
cannot accept Reader input. Generic process stop/delete and agent/cron delivery
still refuse shared tasks. New shared creation, automatic legacy migration,
and `/new`/fork adoption remain outside this change. The pilot is
still opt-in, separate from main AM.


## Recovery after a shared daemon crash

A lost connection discards live deltas and pending approval/question keys. AM
reconnects its observations to the configured endpoint and verifies home,
thread ID, binding incarnation and workspace again. It never launches the
daemon or silently resumes an unloaded thread. Native last-turn status supplies
an explicit interrupted/failed notice, independent of any partial answer.

When the saved settings are supported, the existing pane header offers
**Reconnect task**. This operator-only action restores the last persisted turn's
model/provider, approval policy/reviewer, sandbox, CWD, effort and service tier.
It uses a key derived from that exact context and binding; stale keys fail.
It verifies the resume response and starts no model turn. Ordinary input still
requires a fresh explicit prompt. Delivery receipts survive both daemon and AM
restarts, including an acknowledgement lost after Codex accepted a message.

This is deliberately narrower than arbitrary configuration recovery: standard
read-only and workspace-write restricted profiles, default collaboration mode,
and no disabled plugins are supported. Custom permission profiles, broader
access, absent/oversized context and unknown settings require review in native
Codex. Settings changed after the last persisted turn are not reconstructed.
A process crash cannot promise to preserve an in-flight tool or model turn.
