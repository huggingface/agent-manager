# Shared Codex rollout — current plan

Updated 2026-10-10. Preserve AM's established Reader, Composer, terminal and
interaction components; adapt execution behind their existing contracts.
See [the adapter contract](../conversation-adapter.md) and
[binding/import behavior](../codex-shared-bindings.md).

## Implemented in the opt-in pilot

- Separate close-view, exact-turn interrupt and AM-only archive/restore actions.
  Active archive preserves native work and bindings; stale interruption IDs fail.
- Durable unique native-thread ↔ AM-session bindings, exact import/resume,
  verified workspace and endpoint identity; no standalone or CWD fallback.
- Existing Reader and Composer: paged history, live text/reasoning/tool blocks,
  attachments, questions and one-time approvals; exact-turn reconciliation.
- Authoritative runtime activity independent of terminal presence and history
  catch-up. Browser disconnects do not stop server work.
- Durable input receipts prevent replay after uncertain delivery or AM restart.
  Input while another client is working is refused rather than queued/steered.
- The native context helper resolves AM identity at call time without `AM_ID`.
- Mobile predictive input and IME safeguards from main are retained. The operator
  confirmed the terminal keyboard scrolling correction on the iPhone on
  2026-10-10. This confirms that reported symptom, not every iOS workflow.

## Evidence and boundaries

Disposable Codex 0.162.1 with a local deterministic Responses provider exercises
real model-tool execution and server protocol behavior, without paid inference
or access to live tasks. It verifies Reader text/images, a model question
answered in Reader, an approval answered by an independent client while Reader
is open, stale-answer rejection, and refusal to send into another client's
active turn. A native model command resolves the exact AM session/thread/CWD.
Lifecycle tests archive active work, restore its unchanged mapping, reject stale
interruptions both in AM and the daemon, and interrupt one task while a second
remains active. A real TUI submits work, its browser transport closes, and Reader follows work
through completion. Explicit model/provider/approval/sandbox/CWD settings remain
unchanged across these client transitions.

The separate restart fixture verifies that restarting only AM preserves ongoing
server work and the durable binding. It does not prove recovery from a Codex
server crash. Independent local RPC clients exercise the shared protocol, not
Apple's app or the Remote relay: those approval/question paths still need an
actual phone check. Earlier phone handoff and the scrolling fix were confirmed
by the operator; do not extend those confirmations to untested cases.

## Next changes, in order

1. **Consolidate the current PR.** Integrate current main without dropping mobile
   writing assistance, retain the shared conversation components, run affected
   regression suites and document the tested boundaries. Keep the opt-in pilot
   separate from production; merging does not authorize restarting legacy TUIs.
2. **Complete shared lifecycle actions.** Closing a view detaches it. Interrupt
   targets a verified current turn and rejects a stale turn ID. Archive changes
   AM visibility without implicitly killing shared work; provide unarchive.
   Implemented and tested in the pilot. Generic process stop/delete and managed
   agent/cron delivery remain guarded rather than silently changing semantics.
3. **Recover after daemon failure.** Verify identity and settings on reconnect;
   distinguish interrupted work from completed work; do not replay uncertain
   input. Test a disposable daemon crash and an AM restart independently. Do
   not promise survival of an in-flight turn through a daemon crash.
4. **Create shared sessions by default.** First in the pilot, after lifecycle
   and recovery gates pass. Persist the new exact native ID before delivery or
   TUI attachment. Define recovery from an ambiguous creation acknowledgement.
   Preserve explicit settings; never infer a replacement thread by recency.
5. **Migrate legacy tasks individually.** Integrate verified-owner graceful
   release, same-ID resume, full paginated history comparison and settings
   checks. Leave busy/ambiguous tasks untouched. Keep tmux/mosh shells and
   unrelated owners intact. Plan production deployment around live legacy
   writers; do not restart the old AM underneath them.

## Gates before default rollout

| Area | Still required |
| --- | --- |
| Phone interoperability | Approval and question round trips in the actual iPhone client, including resolution while AM is open. |
| Managed delivery | Define agent/cron delivery semantics; currently refused for shared tasks. Close/interrupt/archive/restore are implemented. |
| Daemon recovery | Settings preservation, clear failed/interrupted state, durable no-replay behavior after a real disposable crash. |
| New thread identity | Empty creation and persistence failure; `/new` and fork must not overwrite the original mapping. Unmapped threads stay Codex-only. |
| Migration | Integrated owner checks and graceful release, nondisruptive production rollout. |

Automatic adoption of every phone-created task, arbitrary remote-machine
endpoints, all child-thread workflows and a sidebar redesign are deferred.
No architectural blocker has been established; the items above are concrete
implementation or validation gaps, not reasons to replace AM's UI.

Protocol reference: [official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).
The installed binary's generated schemas and disposable runtime tests determine
what this pilot actually supports; documentation alone is not a version test.
