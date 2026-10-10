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
Actual iOS keyboard behavior still needs an on-device check; Chromium's mobile
viewport cannot establish it. The terminal renderer/resize pipeline is retained.
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
  inference or live user task is used. Also exercises an external client, a cold
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

Closing a Reader or terminal view detaches that view. It does not stop shared
work. Existing generic stop/archive actions continue to refuse shared tasks;
turn interruption requires a separate exact-turn action. New shared creation,
automatic legacy migration, crash recovery and `/new`/fork adoption remain
outside this parity change. The pilot is still opt-in, separate from main AM.
