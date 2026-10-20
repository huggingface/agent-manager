# Agent inventory activity

`GET /api/agents` and `GET /api/agents/:id` expose `lastPromptAt`,
`lastAnswerAt`, `lastActivityAt` as ISO UTC timestamps or `null`.
`activityKind` is `prompt`, `answer`, or `null`. Assistant progress text is an
exchange; terminal refreshes, tools, completion markers and imports are not.
The last answer date survives the next prompt even though the Overview's
current-turn answer summary clears. Creation time remains a separate field.

Shared Codex entries use the bound thread's verified transcript, including
imported entries without an old `codexRollout` field. Reads never resume a
thread, launch a TUI or use a neighboring workspace's transcript. When the
shared source cannot be verified, dates and trace are null and `activityError`
is set. The list's `activityErrors` preserves those warnings even if the row
is excluded by the activity filter. An empty filtered result with errors is
not evidence that no work happened.

Codex and Claude exchange dates are scanned independently of the 12 MiB display
digest. The bounded-memory JSONL scan retains an append cursor, so long tool
output cannot hide earlier exchanges. Individual records above 16 MiB, malformed
records and incomplete final records produce `activity-incomplete`; unreadable
activity evidence produces `activity-unavailable`. Known dates can still be
returned alongside that warning. The scanner detects file replacement,
truncation and same-size rewrites; normal transcript growth is append-only.

Other harnesses use their conversation digests; a truncated digest explicitly
reports `activity-incomplete`. Missing evidence, including shell/passive entries,
stays null. Existing parsing caches apply: these are observed exchange times,
not a claim of instantaneous delivery. Unknown dates never become the time a
file was modified, imported or read.

List options:

| Option | Contract |
| --- | --- |
| `group` | Case-insensitive, Unicode-normalized group name |
| `state` | Comma-separated `working,waiting,idle,stopped,unknown` |
| `cli` | Comma-separated registered CLI IDs |
| `active_within_minutes` | Integer 0–52560000; includes known activity at or after the cutoff |
| `include_archived` | `true` or `false`; default false excludes explicit `archivedAt` entries, not UI age-based hiding |
| `sort` | `recent_conversation`, `recent_answer`, `recent_prompt`, `created` descending, or `name` ascending; absent preserves stored order |
| `limit` | Integer 1–1000, applied after filters and sorting; absent returns all matches |
| `from`, `self` | Existing caller attribution / self-row marker |

Invalid, repeated, structured or unknown list options return HTTP 400 instead
of silently broadening the result. Ties in explicit sorts use the AM ID;
unknown dates sort last. The activity window excludes unknown activity.

Validation: `server/test/agent-activity.test.mjs` checks timestamp semantics
and filter combinations; `server/test/agent-activity-http.test.mjs` exercises
an isolated AM with imported shared entries and a read-only fake native daemon.
No real conversation is changed to reproduce the issue.
