# One conversation, three depths — unifying the Overview card and the trace viewer

Status: **draft implementation** · Branch `design/trace-unify` · Written 2026-08-05

The Overview reads well and shows too little. The trace viewer shows everything and reads
badly. They render the same thing — one agent's conversation — through two components, two
data paths and two visual languages. This document proposes collapsing that into **one
renderer used at four depths**, says exactly which affordance moves where, and records how each
choice was arrived at (§9). §10 tracks what of it is built.

Companion docs: `docs/trace-panel-spec.md` (how the reader and the viewer were built, and why
the digest is not enough), `docs/session-sharing.md` (share/receive).

---

## 1. What is actually wrong

**Two renderers.** The Overview card (`web/src/components/Overview.tsx:29`) draws
prompt → answer from a *digest*. The viewer (`web/src/components/TracePane.tsx:166`, `Row`)
draws role-badged turns from *trace pages*. Nothing is shared but `renderMarkdown`.

**The card cannot show the middle.** Its history control (`Overview.tsx:45,57,122-140`)
*replaces* the answer with an earlier one — a stepper, not an unfold. And the data it steps
through, `digest.turnsLog` (`server/src/traces.js:57-81`), holds only assistant **text** turns
from the **current** request. Tool calls, thinking, and everything before the last prompt are
not in the payload at all. So "unfold the messages in between" is not a UI tweak: the card
has to read the trace (§5).

**The sidebar carries four trace affordances** that all belong to a session it already lists:
read-trace and share on every agent row (`Sidebar.tsx:245-247`), share and handover on every
`trace` row (`Sidebar.tsx:237-238`). Worse, reading a trace *creates a session record*
(`App.tsx:openTrace`) — a second sidebar row for a session that already has one. On mobile,
where row actions are always visible (`styles.css:831`), each row is a cluster of five glyphs.

**The viewer is dressed as a terminal.** `.trace-body { background: var(--term-bg) }`
(`styles.css:895`), uppercase role pills, a mono chip per model and per-row token counts. The
card uses panel background, hairlines, one accent `❯`, 13px text. Same content, two registers —
and the terminal register is the one nobody likes.

**The card is boxed in on a phone.** `.ovw-backdrop { padding: 7vh 20px 20px }` +
`.ovw-win { max-width: 640px; max-height: 85vh }` (`styles.css`) is a desktop dialog. On a
390pt screen it wastes ~15 % of the height and 40pt of width, and being `position: fixed` it
ignores `--vvh`, so an open keyboard can sit over the reply line.

---

## 2. The idea

> An agent's conversation is a list of **exchanges**. An exchange is *your prompt*, *the work*,
> and *the answer*. Every surface in this app shows exchanges — one or many, shallow or deep.

```
Exchange = { prompt, steps[], answer }
```

Four depths of one component:

| Depth | Surface | Shows |
|---|---|---|
| **D0** brief | Overview tile | prompt (1 line) + state |
| **D1** card | Overview card, collapsed | prompt, one meta line, answer, reply box |
| **D2** open | Overview card, unfolded | + the steps between prompt and answer; `↑ show previous turn` walks back one exchange at a time |
| **D3** full | Session pane, reader mode | every exchange, windowed, each expandable to D2 |

The viewer stops being a different thing and becomes **a vertical stack of the card**. That is
the whole design; the rest is consequences.

---

## 3. Surface by surface

### 3.1 Overview tile — unchanged

Still digest-fed, still one line of prompt and a state word. It is the only thing on screen in
numbers, and it is already right.

### 3.2 Overview card

Collapsed, it looks exactly like today: `❯ prompt`, one meta line, the answer as markdown, the
reply line. **Everything about the turn is on that one line, under the prompt** — nothing above
it. The line is also the fold control, so it names what it is hiding:

```
        ↑ show previous turn

▒▒ ❯ rebuild the fixture generator so it merges index.json ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒

  ▸ 14 steps · 9 tools · 42s · 18.4k tok

  Done — `scripts/lab-fixtures.mjs` now merges by name …

  ❯ reply…                                                                    ⬆
```

The composer is the same everywhere: `❯`, a growing textarea, and a square send key. No
"↵ send · ⇧↵ newline" caption — it appeared the moment you typed, which is the moment you
already knew.

In the viewer the same line carries the turn's identity on its right — one row, two halves:

```
▒▒ ❯ rebuild the fixture generator so it merges index.json ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒
  ▸ 14 steps · 9 tools · 42s · 18.4k tok            turn 6/13  01:32 PM
```

The prompt is a **band**: a faint accent tint between two hairlines, with the `❯` hanging in
a 16px gutter to its left. Nothing else in the exchange sits outside that column — the answer
has no rail, the work has no rail — so scrolling a long conversation, the arrow and the band
are the only things your eye has to track, and they mean exactly one thing: *you said this*.

Unfolded (D2), the steps appear **between** prompt and answer, one line each, chronological:

```
▒▒ ❯ rebuild the fixture generator so it merges index.json ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒
  ▾ 14 steps · 9 tools · 42s · 18.4k tok
  ▸ thinking  weighing a merge against a rewrite…
  ✓ Read   scripts/lab-fixtures.mjs
  ✓ Edit   scripts/lab-fixtures.mjs · +6 −1
  ▸ I'll also cap the candidate list before statting…
  ✓ Bash   node scripts/lab-fixtures.mjs …
  ✗ Bash   git -c core.hooksPath=… commit
  Done — `scripts/lab-fixtures.mjs` now merges by name …
```

Rules that keep this from becoming the ugly viewer in a small box:

- **One line per step**, always. Nothing expands by default.
- **One left column, two meanings.** A tool reports its outcome there (`✓` / `✗`); everything
  else offers a disclosure triangle, greyed when there is nothing more to see. The fold control
  above uses the same column and the same triangle, so it reads as the head of the list.
- **Expanding never repeats itself.** Text steps (thinking, an aside, a compaction) simply stop
  being truncated — same font, same colour, more of it. Only a tool has genuinely *different*
  material below: its input and what came back.
- Consecutive calls to the same tool collapse (`✓ Read ×4  App.tsx, api.ts, +2`). The grouping
  logic exists — `ToolGroup` in `TracePane.tsx:86` — and gets reused, not rewritten.
- **Thinking is one line** with a preview; system/harness turns are not shown at all in the card
  (they are the harness talking to itself).
- No badges, no per-step timestamps, no per-step tokens.
- **A failed result is a box with a red border**, not a red bar down one side. The bar reads as
  decoration bolted onto the left edge; the border says *this block is the failure*.
- **Something is always at the bottom while the agent works.** With no answer yet — or a partial
  one — a `working` line sits below the last thing said and above the reply box.
- **The card opens on the latest turn**, its prompt at the top of the body and the answer
  reading downward; while the agent is working it pins to the tail instead. Asking for the
  previous turn scrolls to the **top** — you asked for that turn, so the body lands on it rather
  than leaving you where you were. The body is
  the scroll region, sized by the window (`flex: 1; min-height: 0; overflow-y: auto`) — **never**
  by a `vh` number, which is measured against the viewport and leaves a full-screen phone card
  two-thirds empty.
- **Only the card you opened reads the trace.** Inline in the Overview list a card is a
  summary — one prompt, one clamped answer — and the digest already has that. Reading the trace
  per visible agent, and polling it every three seconds for the working ones, would turn the
  Overview from one `/api/meta` poll into one transcript read per row. The window (and reader mode)
  is where the middle gets fetched.
- **A card says nothing the surface around it already says.** No turn number (there is one turn),
  no clock (its header carries `·6m`), no model, no harness. In the viewer the same line's right
  half adds `turn 6/13` and the time, and names the model *only* when that turn's model differs
  from the session's.

**Going back in history** — the part you were least sure about. The card grows by **one
exchange per click**, never by "load everything":

- A centred `↑ show previous turn` at the top of the body prepends the previous exchange,
  collapsed to prompt + answer (its steps fold behind the same `▸ n steps`). Centred, because it
  belongs to the whole card rather than to the column of text under it.
- After the second one, `full history ↗` joins it, opening the pane in reader mode at that
  exchange. The card is for "what just happened"; archaeology has a bigger room, and the handoff
  is one click.
- Cap the card at, say, 5 exchanges regardless — past that the card is the wrong tool and says so.

This replaces the `↑ ↓` turn stepper entirely. Stepping through turns *in place of* the answer
was a workaround for not having the middle; with the middle visible it has nothing left to do.

**Mobile.** The card window becomes the screen, with a small margin:

```css
@media (max-width: 720px) {
  .ovw-backdrop { padding: 6px; height: var(--vvh, 100dvh); align-items: stretch; }
  .ovw-win { max-width: none; width: 100%; max-height: none; height: 100%; border-radius: 12px; }
}
```

`--vvh` is already maintained from `window.visualViewport` (`App.tsx:106-114`); the backdrop
must use it, or an open keyboard covers the reply line it is there to serve.

### 3.3 The session pane: terminal ⇄ reader

The bottom bar gets a two-state control, next to the zoom:

```
                                        [ terminal | reader ]   − 100% +
```

**It is one setting for the whole app, like zoom** — not a per-pane toggle. Reading a fleet means
reading it the same way, and a per-session switch was a preference nobody wanted to manage. A
pane with nothing to render (a shell) simply stays a terminal.

- **Only an agent has a conversation.** A shell stays a terminal whatever the switch says, and
  the files/trace panels are not sessions at all — same rule the Overview uses to decide what is
  an agent (`cli !== 'shell' && !isPassive(cli)`).
- **terminal** — today's terminal, untouched.
- **reader** — the same session, laid out: the exchange renderer over `/api/trace/:id`, at D3.
  The two modes show the *same content*; what differs is the form, which is why the labels name
  the form. "Conversation" would have described the terminal just as well.
- The mode is a **view preference**, kept in `localStorage` for the app, not in the store.
- **Nothing of the terminal's may paint over the reader.** Its covers — `restoring last view…`,
  `starting claude…`, `stopped · output preserved` — sit at `z-index: 4` and were drawn straight
  over the conversation, so a reconnect turned the reader into a terminal screen with a reader
  toolbar on top. They are gated off while reading (they belong to the terminal, and the reader
  is reading a file that does not care whether the PTY is up), and the overlay now outranks
  anything the terminal can raise.
- The terminal element stays mounted and connected underneath; the reader draws over it. Toggling
  must not detach tmux — a reattach costs a repaint and can trip the handoff path
  (`HANDOFF_CODE`, `TerminalPane.tsx`). **Verify** this before shipping: xterm needs layout to
  fit, so "cover, don't unmount" is the low-risk option, and a refit on return is required.
- The reader's toolbar is a second header row, not a squeeze into the first — on a phone the
  first row has no spare width. It carries only what is true of the whole session and said
  nowhere else: the model, `13 turns`, the token totals abbreviated (`2.2M↓ 654k↑`), `▲▼`, and
  the search box. The harness is the logo in the row above; the raw message count and the cached
  tokens are details, so they live in `title` attributes. There is no "expand everything" — each
  turn folds itself, and search opens what it needs to.
- **Search has to be followable.** Filtering to matching turns is not finding: the term is
  highlighted wherever it lands, a turn whose only match is inside its folded work *unfolds it*
  (and opens the step holding it, body included), the box reports `3/17`, and `▲▼` switch from
  walking turns to walking hits. With no query, `▲▼` put the next turn's prompt at the top of
  the reading area — measured against the scroller's rect, not `offsetTop`, which is relative to
  the nearest positioned ancestor and lands a few rows off.
- Vocabulary: a **turn** is one exchange, a **message** is a raw transcript row. Each turn's meta
  line says `turn 6/13`, so the bar counts the same things the reader does.
- **The terminal must not keep the keyboard** while reader mode covers it. A mounted xterm with focus
  swallows keystrokes into the agent's TTY, invisibly — and several paths grab focus back (the
  pane becoming active, the header, the key bar), some of them *after* the mode changes, so the
  guard belongs at each call rather than at the switch.
- **A failed refresh must not blank the conversation.** The poll's error is a strip above the
  turns, not a replacement for them: this mount answers `EIO` now and then, and going stale for
  three seconds beats losing your place mid-read.
- **A search survives a refresh.** Only a new query jumps to the first hit; a poll landing keeps
  your position among the matches.
- **While the agent is working the viewer follows the tail**, and stops the moment you scroll up
  (`< 48px from the bottom` is "still following"). A viewer that yanks you back down on every
  tool call is unusable while a task runs; one that never moves makes you chase it.
- **The prompt band sticks to the top** while you read a long turn. What you want overhead deep
  in someone's 67-step answer is the question it is answering — not a row of numbers.
- **The reader answers to the zoom bar.** It covers a terminal whose font the zoom keys scale,
  so a reader that ignored them made zoom look broken. The conversation and the reply line
  scale (`zoom: var(--cx-zoom)`); the toolbar and the path footer are chrome and stay put.
- **It opens on the newest turn** — in the card, in the reader, and in the trace viewer, which
  used to open on page 0, i.e. last month. In the viewer that means landing on `total - 1` by
  the same two-step the prompt nav uses, because row heights start as estimates.
- **The prompt band spans the pane.** Reaching into the left gutter but stopping at the text
  column on the right made it read as a card floating over the answer rather than as the head of
  it. Full bleed both sides; the meta row sits tight under the band it belongs to, and one
  exchange ends well before the next begins.
- **The reader fills the pane.** A fixed reading column left a gutter of nothing on each
  side while the prompt band still spanned the full width, so the two disagreed about where the
  conversation began. The pane is the measure: narrow the pane and the conversation narrows.
- **Reader mode can be replied to.** Reading a conversation and answering it are the same act — the
  card has always known that, and a rendered session that could only be read would send you back
  to the terminal to type. It is the card's own composer (`.ov-live`), the same `sendInput`, and the
  same optimistic echo: your prompt appears at the bottom with a `working` line until the
  transcript catches up. Optimistic means *before* the POST returns — it used to wait for the
  round trip, which left a beat where the box was still full and nothing had happened. A failed
  send withdraws the echo and puts the text back in the box.

  Both surfaces use one `Composer` component. A composer accretes features — paste-to-attach
  (PR #39), history recall, a slash-command menu — and duplicated markup is how one surface
  quietly gets them and the other does not. `onPasteFiles` and `above` are the seam #39 plugs
  into; until it lands, neither surface accepts a pasted screenshot. Only a trace with **no agent behind it** — a shared file, an import — is
  read-only, which is what `readOnly` is for.
- **Share** moves here from the sidebar. One session, one place.
- **Handover** ("continue from this trace in a new agent") lives in the conversation footer, beside
  the provenance line — the only place where its meaning is obvious.

### 3.4 What leaves the sidebar

| Today | Tomorrow |
|---|---|
| `Read this session's trace` on every agent row (`Sidebar.tsx:245`) | bottom bar → **reader** |
| `Share this session` on every agent row (`Sidebar.tsx:246`) | pane header → **share** |
| A `trace` **session row per read** (`App.tsx:openTrace`) | **gone** — no duplicate rows |
| Trace row's `Share` (`Sidebar.tsx:237`) | trace pane header (imported traces keep a pane) |
| Trace row's `Handover` (`Sidebar.tsx:238`) | reader / trace-pane footer |
| Quick-add **Trace** = open a shared dataset (`Sidebar.tsx:482`) | **stays** |

The last row is deliberate: an **imported** trace has no session behind it, so it is a genuine
object that needs a row of its own. Same for a transcript opened from the Files pane
(`getFileTracePage`). What disappears is the *local* trace pane — a session's own history is
now a mode of its own pane, not a second entity.

Agent rows keep stop/play and delete. Three glyphs less per row, which is most visible exactly
where the sidebar is worst: on a phone.

---

## 4. The renderer

### 4.1 Turns → exchanges

Pure client-side, no new server concept:

```ts
// split at each operator prompt; the answer is the turn the server already marked
splitExchanges(turns: TraceTurn[]): Exchange[]
  new exchange at every turn where role === 'user' && !isHarnessNoise(turn)
  answer  = last turn in the exchange with kind === 'final'      // markFinalTurns, traces.js:1371
  steps   = everything else, in order, minus role === 'system'
```

`kind: 'final'` is already derived for every harness (`markFinalTurns`), which is why this works
uniformly and why codex's `task_complete` needs no special case.

### 4.2 Block vocabulary — one line each

| Block | Collapsed line | Expanded |
|---|---|---|
| `thinking` | `⋯ thought for 12s` + preview | plain text, no markdown |
| `tool_use` (+`tool_result`) | `⌗ <Tool>  <arg summary>` + `✓`/`✗` | args and result, `.tv-pre` style |
| run of same tool | `⌗ Read ×4  App.tsx, api.ts, +2` | each call in turn |
| `text` (non-final) | `· <one line>` muted | full markdown |
| `shell` | `$ <command>` + `✓`/`✗ exit n` | stdout/stderr |
| `compaction` | `↺ context compacted` | the summary |
| `image` | thumbnail chip | full image |
| `system` | *not rendered* in card; behind a toggle in D3 | — |
| `more` (truncation) | `+412 KB not retained` — **never** silently dropped | — |

### 4.3 Visual grammar — the overview's, everywhere

Role is expressed by typography and position, not by a badge.

- Background `--panel`, never `--term-bg`. Hairlines at **exchange** boundaries only, not per turn.
- Prompt: `❯` in accent, 13px/550, `pre-wrap` (`.ov-prompt`).
- Answer: markdown at 13px, no rail — the tinted prompt band above it is what separates turns
  (`styles.css:966`) — the one thing the viewer does better than the card today. Keep it in both.
- Steps: 11px mono label + 12px muted detail, single line, ellipsised.
- Model chip, token counts and timestamp move to the **exchange header**, right-aligned, muted,
  `tabular-nums`. Per-turn usage survives as a `title` on hover.
- Uppercase role pills (`.tv-badge`), per-row model chips and per-row token counts are removed.
- D3 gets a **max reading width** (~720px, centered) when the pane is wide. Line length is most
  of why the card reads better than the viewer.

Kept as-is: fold behaviour, height-measured windowing, search-says-what-it-searched, prompt
navigation, image blocks, the "not retained" and "reasoning was encrypted" honesty notes.

---

## 5. Data: which depth reads what

| Depth | Source | Cadence |
|---|---|---|
| D0 tile, D1 collapsed card | `/api/meta` digest — already polled for the whole Space | 1.5 s while the Overview is open (`App.tsx:200`) |
| D2 open card | `/api/trace/:id?offset=-40` — the tail | on unfold; every 3 s **only while that agent is running**; stops on collapse |
| card `↑ earlier` | `/api/trace/:id` around the previous prompt index | on click |
| D3 pane | `/api/trace/:id` paged, unchanged | on scroll |

The digest stays exactly what it is: the cheap, always-on summary. The moment you ask for the
middle, we read the real trace. No third data path, and no growth in what the 1 Hz Space-wide
pass retains (`docs/trace-panel-spec.md` §2 forbids that, for good reason).

**Two small server changes**, both in `pageOf()` (`server/src/traces.js:1404`):

1. **`prompts: [{ i, ts, text }]`** beside today's `userTurns: number[]`. Clipped to ~200 chars.
   It lets any surface draw the exchange skeleton — including the label on `↑ earlier` — without
   fetching pages it will not render. Same single pass that already builds `userTurns`.
2. **Negative offset** = from the end (`offset=-40` → last 40 turns), so a tail read is one
   request instead of "fetch page 0 to learn `total`, then fetch the tail".

**The live-parse cost is the one number to watch.** `viewMemo` keys on mtime+size
(`traces.js:1437`), so every fetch against a *running* session re-parses the whole file — 634 ms
for a 9.46 MB transcript per the spec's measurements. At 3 s for one unfolded card that is
~20 % of a core, bounded to one session (the memo holds exactly one), and it stops when the card
closes. Acceptable for a foreground action. If it bites, the fix is a **tail parser** that reads
only the last N lines: results whose call is off-window simply render as standalone rows, which
the block model already supports.

---

## 6. What this buys

- One component to style, so "the overview is more pleasant" becomes true everywhere at once.
- The card answers "what did it actually do?" without leaving the Overview.
- A session's history is reachable from the session, not from a second sidebar row.
- Three glyphs less per sidebar row, and a full-screen card on a phone.
- Removed code: the `turnsLog` stepper in the card, `openTrace`'s pane-creation path, two
  sidebar buttons, `.tv-badge` and the terminal-styled viewer chrome.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Re-parsing a live transcript every 3 s | one session at a time; running-only; tail parser in reserve |
| Covering the terminal breaks xterm fit / trips tmux handoff | keep mounted + refit on return; verify against a live session before shipping |
| The unfolded card becomes the ugly viewer in a small box | one line per step, nothing expanded by default, system turns hidden, hard cap of 5 exchanges |
| Losing an affordance someone used (share from the sidebar) | every removal has a named new home (§3.4); no capability drops |
| `trace` sessions already in the store | the pane type stays for imported bundles and Files-pane transcripts; existing local trace panes keep working, we just stop creating new ones |

---

## 8. Open questions (operator)

1. **How far back in the card?** Proposal: one exchange per click, hard cap 5, then hand off to
   the conversation. Alternative: one, then straight to the full conversation.
2. **Does the app open in reader mode**, or always start on the terminal?
3. **Kill the `↑ ↓` turn stepper?** Proposal: yes — unfolding replaces it.
4. **Unfolded card of a running agent**: live-refresh every 3 s, or freeze until it finishes
   (cheaper, less alive)?
5. **Harness/system turns in D3**: hidden behind a toggle (proposal), or collapsed rows as today?
6. **Does the Overview's list view survive?** With a full-screen card on mobile and tiles on
   desktop, the list view may be redundant.

---

## 9. How this was designed

Every choice above was made by looking at it, not by reasoning about it: a local
harness (not committed — it carries real transcripts, and this repo is public) renders these
components against **captured conversations** in phone, tablet and desktop frames, in both
themes, with six scenarios — done, running, just-sent, failed tool, truncated, never-prompted.
Fixtures are captured by running the app's own reader (`readTraceByPath`), so the harness cannot
drift from the payload shape.

A second local harness (`web/app-shots.mjs`, with `web/fixtures.mjs` for its fleet — both
excluded for the same reason) drives a *running* instance rather than rendered components: it
asserts what the UI actually does on click. Sixteen checks today — the list view reads no traces
and opening a card reads exactly one, `full history ↗` flips an already-open pane, focus stays
out of the covered terminal, the reader opens on the newest turn and answers to the zoom bar,
the bottom bar is one height, a sent prompt echoes before the POST returns, a shell keeps its
terminal, a failed refresh keeps the conversation, merging two agents switches to their group
layout, and the trace viewer opens at the end. `fixtures.mjs` writes a Claude transcript and the
sessions to read it from, so the counts it asserts are the same on every machine.

It also **replays a turn block by block** — a tool call lands, its result comes back, thinking
between them, the answer only at the end — which is how the live rules in §3.2 and §3.3 were
found. Three of them exist only because the replay made them obvious:

- The viewer has to follow the tail while the agent works, and stop the moment you scroll up.
- Mid-task there is *no answer*: an agent's aside is not a reply, so promoting the last message
  to the answer slot moved it below the tool calls that came after it.
- The card's `working` line and reply box have to survive the middle of a turn, not just its end.

**One lesson worth keeping:** a frame is a container, not a viewport, so `@media (max-width:
720px)` never fires inside one — and neither does it fire for a 390px-wide *pane* on a desktop.
Pane chrome therefore wraps by default rather than at a breakpoint, and the card body is sized by
its window (`flex: 1; min-height: 0`) rather than by any `vh` number.

## 10. Sequencing

Built (this branch):

1. `web/src/components/conversation/` — `exchanges.ts` (turns → exchanges → step lines),
   `Exchange.tsx` (one exchange at any depth), `ToolCall.tsx` (an expanded call as a command, an
   edit, a file — not as JSON), `ConversationView.tsx` (D3), `web/src/conversation.css`.
2. The Overview card reads the trace tail and renders exchanges: the work unfolds, history grows
   one turn per click, the `turnsLog` stepper is gone. The digest still drives the card when
   there is no transcript to read.
3. `pageOf()` takes a negative offset — "the last N turns" without a round trip to learn `total`
   (`server/test/trace-tail.test.mjs`).
4. The session pane gets terminal ⇄ reader, from the bottom bar, app-wide. It draws over the terminal, which stays mounted and
   connected but loses the keyboard; the mode is a per-session view preference in `localStorage`
   (`web/src/lib/paneMode.ts`), and its event reaches a pane that is already open — which is what
   the card's "full history ↗" needs.
5. Tests for the one piece of judgement in the renderer — what counts as the answer, and what
   stays in the work (`web/test/exchanges.test.mjs`, `npm test` in `web/`).

Not yet, in the order I would do it:

6. `head.prompts[]` (§5) — index, first line and timestamp per prompt, so a surface can draw the
   skeleton and label "show previous turn" before fetching the page that holds it.
7. The sidebar loses its trace buttons and `openTrace`; share moves into the pane header (§3.4).
8. Windowing by exchange in reader mode: a collapsed turn is 2–3 rows, so the DOM stays small,
   `head.prompts[]` gives the skeleton up front, and only an opened turn needs its page. The
   measured-height machinery in `TraceView` is reused as-is — what changes is what a "row" means.
   Until then it reads the last 400 turns in one request.
9. The mobile card sizing block (§3.2) — the lab's `.lab-mfix` mirror of it is not the real
   `@media` rule, and the real one has not landed.
