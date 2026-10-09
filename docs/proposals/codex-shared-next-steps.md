# Revised shared Codex action plan

Reassessment on 2026-10-09: no fundamental incompatibility has been established.
The first experiment incorrectly made preserving the entire AM environment a
prerequisite for shared execution. AM needs a durable association with the
Codex thread and correct attribution for its own API operations. Codex can
otherwise continue the task independently of AM.

## Evidence and its limits

The disposable two-thread probe now checks `CODEX_THREAD_ID` as well as `AM_ID`.
On Codex 0.162.0 the native ID is correct in both threads, including after server
restart and exact-ID resume. The custom `AM_ID` override is lost on that path.
This supports resolving attribution from native identity rather than restoring
an entire terminal environment. It still needs verification in normal model
tools, direct Remote use, and child threads; the observed variable is not a
public interface guaranteed by the current environment-variable documentation.

The previous approval-policy result used user-shell turns, not model turns.
Do not infer from that fixture alone that real model-turn settings cannot
persist. Test the intended Codex defaults and any supported exceptions directly.
The experiment's exit 2 remains an accurate legacy-context diagnostic, not a
verdict that shared launch is impossible.

Current AM code has concrete integration work left: `commandFor` and rollout
capture assume standalone ownership; `runstate` revives PTYs; archive/stop kill
PTYs; trace selection uses a recorded rollout path. These need explicit shared
behavior before enabling new shared sessions.

## Implementation sequence

1. **Persist exact bindings and resolve attribution.** Store endpoint identity,
   Codex thread ID and AM session ID durably, with uniqueness and atomic writes.
   Provide a small local helper/API lookup using the native thread ID. Unknown
   or ambiguous threads cannot claim an AM sender. Never infer identity from
   project directory or title. This labels callers; it is not a new security
   boundary or replacement for the existing private API admission checks.
   Find the AM endpoint through stable host configuration rather than another
   thread's environment. A daemon must not inherit one agent's `AM_ID`.
2. **Launch new sessions through the existing shared server in an isolated AM
   pilot.** Make shared mode the default there, with no per-session checkbox.
   Save the returned thread ID before managed delivery or TUI attachment; test
   creation before the first message and ambiguous creation responses. Resume
   only the exact thread, with no `--last`, rollout-existence or standalone
   fallback. Existing standalone sessions retain their original mode.
3. **Separate view, task and history lifecycle.** Close-view disconnects AM's
   client; interrupt targets a confirmed current turn; archive explicitly
   defines AM list visibility without implicitly killing shared work. Remove
   standalone repinning and automatic writer recreation for shared bindings.
   Read task status and history through server APIs, including paginated
   history, so phone-originated work is visible without an AM terminal.
4. **Validate the complete path.** Send a message and image from a TUI and from
   Remote, verify one history and correct workspace, then return to AM. Exercise
   one approval and concurrent clients. Close AM's view during disposable work;
   restart only the isolated AM instance and verify the server work survives.
   Separately restart the disposable Codex server and verify recovery without
   promising that in-flight work survives a server crash.
5. **Enable the default and migrate gradually.** After these checks pass, enable
   shared creation in the intended installation. Offer migration of selected
   idle standalone threads with verified owner identity. Busy or unknown owners
   remain untouched; there is no bulk release. Existing tmux/mosh workflows keep
   working, using a shared-client launch for new shared tasks.

## Remaining gates

| Point | Current evidence | Gate before enabling |
| --- | --- | --- |
| AM identity | Native ID survives the disposable user-shell test | Verify in normal tools and Remote; implement exact lookup |
| Workspace and permissions | CWD and read-only policy survive the fixture; custom approval override changes | Exercise actual model commands and the chosen server policy; do not broaden it |
| Cross-client input and approvals | Protocol exposes turns, steering and resolution events | Demonstrate no duplicate sends, lost approvals or stale responses in TUI/Remote |
| Closing and restarting AM | Current AM lifecycle still manages PTY execution | Separate task ownership; demonstrate disposable work survives AM-only restart |
| Thread binding and Reader | Exact-ID mapping design; current readers depend on rollouts | Test empty creation, persistence failure, `/new`, forks and paginated history |
| Legacy migration | Local helper previously proved a disposable TUI handoff | Integrate later; not a blocker to new shared sessions |

The first two rows need focused experiments, not an assumed upstream Codex fix.
Lifecycle and Reader changes are implementation work. An inability to preserve
the intended permissions or route an approval across actual clients would be
a real blocker; neither has been established by the existing tests.

## Deferred scope

Do not make first delivery depend on automatic adoption of every task created
on the phone, arbitrary remote-machine endpoints, all child-thread workflows,
or a redesign of the sidebar. Unmapped tasks can remain Codex-only until
explicitly associated. API actions requiring AM identity fail clearly when
unmapped, while ordinary coding remains available.

The current PR remains an observer and compatibility experiment. It does not
yet implement the binding helper, shared creation or lifecycle changes above.
Protocol references: [app-server](https://learn.chatgpt.com/docs/app-server) and
[environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables).
