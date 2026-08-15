# Interactive TUI dialogs in the reader

## Decision

Agent Manager surfaces an interactive-dialog warning only when the CLI itself
emits a lifecycle event for an open permission, question or confirmation UI.
It does **not** infer this state from a quiet process, a static screen or words
such as `Allow` in terminal text. Those heuristics cannot distinguish a dialog
from thinking, a completed turn, documentation, or agent-produced output; a
false "blocked" badge would be worse than a missed prompt.

The pane reader and Overview card replace their reply composer with a **Needs
input** banner and an **open terminal** action. The session tile and sidebar
also identify the condition. The normal composer is hidden because submitting
text while a choice menu owns stdin can select the wrong option. The prompt and
attachment APIs refuse the same operation with HTTP 409 while the signal is
active; direct terminal input remains available.

The reader does not answer the dialog in this version. The CLIs have different
choice identifiers, validation, queueing, "allow once/always" semantics, and
secret-handling rules. Translating a reader form to raw keystrokes would be
unsafe. OpenCode already exposes typed permission/question replies keyed by the
request id tracked here, but Agent Manager has no authenticated client to that
pane's OpenCode server. Other adapters would likewise need a typed, pane-scoped
response path before reader-side answers are safe.

## Detection coverage

Research covered the installed versions on 2026-08-15: Claude Code 2.1.232,
Codex 0.147.0, Gemini CLI 0.55.1, OpenCode 1.18.18, Hermes 0.20.1, and
OpenClaw 2026.7.1-2. The linked source revisions below are the evidence for
which native states emit each signal.

| CLI | Signal used | Confidence | Deliberate misses |
| --- | --- | --- | --- |
| OpenCode | The plugin tracks `permission.asked`/`permission.replied` and `question.asked`/`question.replied`/`question.rejected`. It keeps the full pending queue and mirrors OpenCode's recovery when a Question tool completes without `question.replied`. | High, with paired open/close events. | Dialogs outside those two event families; a request already open before the plugin observes its event. A missing close event expires after 30 minutes, which can hide a genuinely long-lived dialog. |
| Claude Code | Observation-only `Notification` hooks for `permission_prompt`, MCP elicitation dialogs, and `agent_needs_input`. Unlike `PermissionRequest`, these fire after the actual UI has remained unanswered for about six seconds and cannot decide the permission. Native batch/stop/session/elicitation events and operator input clear the marker. | High once reported; intentionally delayed about six seconds. | The first six seconds; main-session choice UIs for which Claude exposes no matching notification (including versions where `AskUserQuestion` has no attention event); unlisted onboarding/configuration dialogs. |
| Codex | Each managed invocation enables only the TUI's `approval-requested` and `plan-mode-prompt` OSC 9 notifications. Codex emits them from the TUI handlers that install exec/edit/MCP approval and request-user-input views. | High for the listed views. | `RequestPermissionsEvent` and generic queued approval paths that do not call Codex's notifier; onboarding/configuration dialogs. Codex exposes no paired close event, so input clears the signal and a 30-minute safety expiry prevents a stale badge. |
| Gemini CLI | An observation-only `Notification` hook reports `ToolPermission`, including `ask_user`. Gemini's native attention notification additionally covers command, auth, filesystem, extension-update and loop-detection confirmations through OSC 9 when enabled. | High: both signals originate from Gemini's actual pending-confirmation state. | Non-tool attention notifications when a higher-precedence user/project setting disables notifications or Gemini suppresses them for terminal focus; other unlisted UI dialogs. Native completion/session events, input, and the safety expiry clear one-shot signals. |
| Hermes | None shipped. Hermes has `_approval_state` and clarify/approval callbacks inside the Python TUI, but no supported external lifecycle hook for the `hermes` process Agent Manager launches. | No reliable external signal found. | All Hermes dialogs. Reading process memory, patching its installed Python package, or matching rendered text was rejected. |
| OpenClaw | None shipped. OpenClaw's gateway has approval request/resolve events and can list open gateway approvals, but Agent Manager launches the local embedded TUI and has no stable, authenticated session-to-gateway approval stream to consume. | No reliable pane-scoped signal integrated. | All OpenClaw local-TUI dialogs. A future gateway adapter could support these without screen scraping. |

Shell, Files, Trace, and Remote panes are not local agent TUIs and do not run
these adapters.

## Evidence

- Claude documents that `permission_prompt` and elicitation notifications start
  from an actual displayed dialog, fire after about six seconds without input,
  and still run when desktop notifications are disabled. It also documents that
  `PermissionRequest` runs in non-interactive sessions that cannot show a
  prompt, which is why this implementation does not use it as proof of a visible
  dialog: [Claude Code hooks reference](https://code.claude.com/docs/en/hooks#notification).
- Codex calls its notifier in the handlers that push the approval and user-input
  views: [tool request handlers](https://github.com/openai/codex/blob/c4941302c73c6322b153bba13ac0a9f4396301d6/codex-rs/tui/src/chatwidget/tool_requests.rs).
  Its notification types distinguish `approval-requested` and
  `plan-mode-prompt`: [notification model](https://github.com/openai/codex/blob/c4941302c73c6322b153bba13ac0a9f4396301d6/codex-rs/tui/src/chatwidget/notifications.rs).
- Gemini fires `ToolPermission` immediately before it places the call in
  `AwaitingApproval`: [confirmation scheduler](https://github.com/google-gemini/gemini-cli/blob/2a87e7be103308b8734246097ba723cc7deb4122/packages/core/src/scheduler/confirmation.ts).
  Its own attention selector enumerates tool/ask-user, command, authentication,
  filesystem, extension and loop confirmations:
  [pending attention state](https://github.com/google-gemini/gemini-cli/blob/2a87e7be103308b8734246097ba723cc7deb4122/packages/cli/src/ui/utils/pendingAttentionNotification.ts).
- OpenCode's own TUI notification plugin tracks the same paired permission and
  question events used here: [OpenCode notifications](https://github.com/anomalyco/opencode/blob/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/tui/src/feature-plugins/system/notifications.ts).
  Its session reducer documents and handles the missing-question-reply edge:
  [session data recovery](https://github.com/anomalyco/opencode/blob/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/opencode/src/cli/cmd/run/session-data.ts).
- Hermes's approval wait is an in-process queue behind `_approval_state`:
  [Hermes callbacks](https://github.com/NousResearch/hermes-agent/blob/56a41715dc3b8bf6f50a740ff9416c4036ef4259/hermes_cli/callbacks.py).
- OpenClaw's gateway-facing MCP adapter can list and resolve open approval
  requests, but that stream is not the pane-scoped local TUI Agent Manager
  launches: [OpenClaw MCP CLI](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/src/cli/mcp-cli.ts).

## False-positive controls

Every file signal carries the Agent Manager pane id, CLI id, and random launch
id. The server accepts it only for the matching live PTY launch. Claude and
Gemini hooks reject nested agent processes; OpenCode's plugin requires the pane
root process. Marker files live on local `/tmp`, not the durable bucket, and are
removed at process exit.

OpenCode's paired event remains authoritative through menu-navigation input and
closes immediately when the final queued request closes. Every marker, including
OpenCode's, also has a 30-minute ceiling so a lost close event cannot disable
reader prompting indefinitely. For unpaired CLIs, an actual operator key or a
native completion event can clear the signal sooner; process exit clears every
kind. Automatic terminal query replies do not count as operator input. The
ceiling can create a false negative for a dialog left open longer than 30
minutes; that is intentional because an indefinitely stale warning is the more
damaging failure mode.

## Verification

Automated coverage includes stale/mismatched launch markers, unrelated terminal
notifications, OSC sequences split across PTY chunks, one-shot expiry and clear
events, OpenCode queues, reject/reply events, OpenCode's missing reply recovery,
nested-process rejection, preservation of existing Claude settings, reader/web
typechecking, and the full terminal migration/resize suite. No assertion relies
on screen text or process idleness.

The installed Codex 0.147.0 TUI was driven to a real command approval with only
`approval-requested` enabled. Its raw PTY output contained
`ESC ] 9 ; Approval requested: ... BEL` immediately before the menu. Repeating
the approval with only `approval-request` reached the same menu without an OSC 9
notification, confirming the configured spelling rather than merely confirming
that Codex accepts arbitrary list values. The installed Gemini binary loaded the
proposed system settings file.

This branch was not deployed and did not drive authenticated live dialogs for
the other adapters; their native event payloads and terminal sequences are
exercised by automated fixtures. A deployment smoke test should deliberately
trigger each covered dialog before release, especially after a CLI version
update.
