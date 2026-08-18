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
- **Expanding never repeats itself.** A text step's one-line preview is the head row's whole
  content while it is shut; opened, that row hands the text over and the step's body carries it
  **rendered as markdown**. An agent writes an aside the way it writes an answer — headings, lists,
  code spans, links — and for a long time only the answer was rendered, so the middle of a turn
  showed its syntax raw (`## Plan`, `[the docs](https://…)`). The prose kinds — `note`, `think`,
  `compact`, named by `proseOf()` — take the same path the answer does,
  `highlightHtml(renderMarkdown(text), q)`, so a search term is still marked inside the rendered
  blocks. Three consequences worth stating:
    - **It renders in the body, not in the head row.** That row is a `<button>`; markdown carries
      links and block elements, and neither is valid — or clickable — inside one.
    - **An open `note` is two columns**, the disclosure gutter and the prose beside it. A note has
      no label, so once its text moved to the body its head row held nothing but a triangle — and a
      row whose only content is a triangle still takes a line, which read as *"it adds an empty line
      at the beginning when expanded"*. Nothing was wrong with the rendering: no empty node, no
      uncollapsed margin, and a leading newline in the source is dropped by markdown anyway (all
      three are pinned in `stepMarkdown.test.mjs`). The blank line **was** the row. `think` and
      `compact` keep the stacked layout, because their row says `thinking` or `context compacted`
      and is therefore not an empty line.
    - **The collapsed preview keeps its syntax.** `## Plan` says the message opens with a heading
      and ` ``` ` says a code block is coming, which is more than `Plan` tells you, and stripping
      it would mean a second markdown pass over a string that may be cut mid-token.
    - **A cut message cannot take the panel with it.** These steps carry a `more` tail, so the text
      can end mid-fence or mid-table; `marked` closes both itself and DOMPurify reparses what it
      emits, so no unclosed block escapes to swallow what follows. Pinned in
      `web/test/stepMarkdown.test.mjs`.
  What must stay literal, stays literal: a tool's input is JSON, a shell's output and a tool result
  are terminal bytes where two spaces mean two spaces, and an image is an image.
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
- **The zoom beside the switch works in both modes.** It is one number for how big everything is,
  not a terminal setting that happens to sit in the same bar: the terminal spends it on its font
  size, the reader on `--cx-base`, the single size every type size in the conversation grammar is
  an `em` of (`conversation.css`; `TerminalPane` sets it on `.pane-reader`). 13px at 100% either
  way, so switching modes does not change how big the session reads. The reader scales as one
  surface — toolbar, turns, reply line, footer — because a 10.5px toolbar left behind at 150% is
  the part you could not read in the first place. Two consequences worth keeping: the Overview
  card shares the grammar and must not move, which is why the base defaults to 13px rather than
  being inherited; and the answer's markdown needs its own heading sizes here, since the shared
  `.markdown` rules are absolute px and would otherwise stay put while the prose grew.
  Spacing does not scale, but anything that lines a column up with a glyph — the prompt's `❯`
  gutter, the step rail, the tool-field labels — is in `em`, or it stops lining up when zoomed.
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
- **An exchange reads in the order it happened.** Usually the answer is the last thing the agent
  said, so it goes under the work. But an agent that answers and then keeps going — a resumed
  task, a reply followed by more tool calls — leaves its answer in the *middle* of the turn, and
  the reader used to lift it out and print it under work it predates. With the steps expanded that
  reads as nonsense: "I will add the index and re-run" sitting below the edit and the re-run.
  `answerAt` (exchanges.ts) remembers the index the answer was lifted from, and the work renders as
  two runs of steps with the answer between them. Grouping runs over each side separately, so two
  `Read`s either side of the reply stay two rows rather than collapsing into `Read ×2` and erasing
  the sequence.
- **One column, and only marks outside it.** The prompt's `❯`, a fold's `▸` and the working line's
  spinner all hang in the gutter; the summary, the answer, the step rows and the word `working` all
  start on the same text column. A mark that sits *inside* the column pushes its own row's text
  sideways, which is what made a turn with no tool calls indent its `13s · 188 tok` by 19px — the
  row reserved the gutter for a triangle that cannot exist in that state (`.cx-fold.flat` used to
  pay `padding-left: 1.75em`). The cell is one number, `--cx-mark` on `.cx-meta`, read by both the
  hang and the glyph's width so they cannot drift apart.
- **A turn with nothing yet has no meta row.** No steps, no duration, no tokens means no left half,
  and rendering the row anyway left an empty line above the working line — which read as the widget
  sitting low, dropped rather than placed. In that state the turn's facts ride on the working line
  itself, so there is one row instead of one and a half. The working line does not move for this:
  it is the last row at the text column either way, before and after the first step arrives
  (checked live, not inferred — the facts move up into the new meta row, the line stays put).
- **One working line, and it is the last thing in the reader.** It carries what the agent is doing
  *now* (`working · Bash …`), so it belongs at the end of the rail it continues — putting it above
  the steps would report the present before the past, which is the same disorder as the bullet
  above. Only the last exchange shows it, and while an optimistic echo is pending the echo owns
  the spot: the agent is one process working on one thing, and two `working` lines stacked (the
  live turn's and the echo's) is what read as the indicator being "sometimes below and above".
  The card has had this guard since it grew an echo; the reader had not. The cost of choosing the
  echo's line is that it is the bare one — the live turn's carries `· what it is doing now`, and
  that detail is gone for the second or two until the transcript catches up and the echo clears.
- **The turn column holds still.** `turn 9/10` and `turn 10/10` are different widths, so the whole
  right-hand cluster stepped sideways the moment a session passed nine turns. The number is padded
  to the width of the total with figure spaces (U+2007) — the row is mono and tabular, so a figure
  space is exactly a digit — and the clock beside it was already stable.
- **The prompt band spans the pane.** Reaching into the left gutter but stopping at the text
  column on the right made it read as a card floating over the answer rather than as the head of
  it. Full bleed both sides; the meta row sits tight under the band it belongs to, and one
  exchange ends well before the next begins. The bleed is `var(--cx-gutter)`, the same variable
  `.cxv-body` pays out as padding, because the phone breakpoint narrows that padding: a bleed
  that restated the desktop number stayed 14px against 8px of gutter and made the conversation
  column scroll sideways on a phone.
- **Nothing in the conversation scrolls sideways except the things meant to.** A code block and a
  wide table each scroll inside their own box (`overflow-x: auto` on `pre` and `table`); the page,
  the reading column and the answer do not. Prose therefore has to *wrap*, including a long URL
  or an unbroken identifier — one long word is enough to push a paragraph wider than a phone, and
  `.markdown` turns that into a sideways drag because a scroller in one axis makes the other axis
  a scroller too. `overflow-x: hidden` on a parent is not the fix: it hides the symptom and clips
  content people need to read.
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

  The echo is a `PendingExchange` — a `.cx` section, the same shape as the turn it becomes a
  second later — and not a loose `.cx-prompt`. Written out by hand it was neither: the band's
  `margin-left` exists to cancel `.cx`'s matching padding, so with no `.cx` around it the newest
  prompt in a conversation hung a gutter's width left of every prompt above it, its `❯` half off
  the pane on a phone. One component, both surfaces, so it cannot drift apart again.

  Only a trace with **no agent behind it** — a shared file, an import — is read-only, which is
  what `readOnly` is for.

- **The composer's controls sit on the draft's first line.** A composer grows downward as you
  type; controls centred in it drift down with the text, so at six lines on a phone the `❯` and
  the paperclip ended up 56px below the line they belong to, level with the middle of a sentence.
  Alignment is `start`, and each control is then offset by half the difference between its own
  height and the first line's — `--ov-first-line`, restated wherever the textarea's size is
  decided (13px in the card, `--cx-base` in the reader, 16px on a touch phone, where iOS demands
  it). A one-line composer looks exactly as it did.

- **Below the composer, only an action earns the space.** The reader used to end in a strip of
  grey: the workspace's absolute path and the date the conversation started, printed under a reply
  box. The path goes for good — on a desktop it is in the pane header and the Files pane, and on a
  phone `.ph-path` is hidden by `@container (max-width: 520px)`, so there it is simply nowhere in
  the reader, which is the right amount of nowhere for a path under a reply box. The date stays,
  because turn times are clock-only and nothing else says which *day*; it is text in `.cxv-bar`
  beside the other conversation-level facts. **Not a `title`** — a tooltip cannot be opened by
  touch at all (iOS long-press opens the callout menu instead), so parking it there amounts to
  deleting the fact on the device these items were filed from while claiming to keep it. The bar
  wraps at any width, so the date costs no height: the reader body measures the same at 320 and
  390 with it as without. What is left below the composer is `continue in a new agent`, and with
  no handover to offer the footer does not render at all rather than leaving an empty bordered
  strip.

  Both surfaces use one `Composer` component. A composer accretes features — paste-to-attach,
  history recall, a slash-command menu — and duplicated markup is how one surface quietly gets
  them and the other does not. `onPasteFiles` and `above` are the seam an attachment strip plugs
  into, so it arrives in both places at once or in neither.
- **A half-typed reply is kept** (`drafts.ts`, `useDraft.ts`). Reported from a phone: start typing
  an answer, switch apps, come back, and the text is gone. The pane is not what loses it — App.tsx
  keeps a dozen panes warm, so an in-app trip to the session list already survived — the
  **document** is. A phone evicts a backgrounded tab, and the Hub rebuilds the Space's iframe on
  every visit, so coming back is a cold mount. That rules out both in-memory state and the URL
  (the Hub owns the iframe's `src`): it has to be storage, written through on every change, because
  a tab being killed does not reliably run unload handlers.

  One draft per **agent**, shared by the card and the reader, because they are the same act on the
  same session. Restoring only fills the box — never focus, never send. Sending clears it, via the
  `setDraft('')` the send already did. It is bounded on three axes, because a composer that throws
  on a keystroke is far worse than one that forgets: 32 KB per draft (past that it stays in memory
  only), 128 KB in total with the oldest evicted first, and **24 hours**, after which it is deleted
  rather than merely hidden — an unsent draft is text you typed on a device that may not be only
  yours. Quota failures and storage being denied outright both degrade in silence.

  Writes pause between `compositionstart` and `compositionend`: a phone keyboard composes, and the
  pre-composition snapshot is a string the user meant, where a mid-composition one is half a
  syllable.
- **It comes back to where you were reading** (`readingPosition.ts`). Opening on the end is right
  for a conversation you have not read; it is not right for one you were half-way up. In-app
  navigation already survived — the pane stays mounted and the browser preserves the scroll box
  across the `display: none` that hides a warm tile — so this is about the **cold mount**: a
  reload, an evicted tab, the Hub rebuilding the iframe. Same layer as the draft in §3.3.

  The anchor is a **turn timestamp**, and the windowed reader forces that choice. Exchanges
  *regroup* as older windows arrive — the one at the top of the list is a fragment whose prompt was
  in the window not yet read, and the two become one when it lands — so no React key, list index or
  pixel offset identifies a place for longer than one fetch. A turn's `ts` comes from the
  transcript and never moves.

  If the remembered turn is not in the window the reader opened with, it **pages backwards to find
  it**, through the same public `loadOlder()` a scroll would use, bounded to six windows. Past that
  it stays on the end — a remembered position is not worth walking a 19 MB transcript for.

  Three rules decide whether it feels right rather than merely works. **Nothing is remembered until
  you have moved the view**, and the evidence is a *gesture* — wheel, touch, pointer, keys, the turn
  nav, the load-earlier button — never a `scroll` event, which fires when the reader re-anchors
  under a prepend and would otherwise file a position you never chose. **If you were at the end you
  return to the new end**, not to the row that used to be last. And a **turn that cannot be reached**
  degrades to the end rather than the top. Bounded to 100 sessions; never expires, because unlike a
  draft it is not text you typed.
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
asserts what the UI actually does on click. Checks today — the list view reads no traces
and opening a card reads exactly one, `full history ↗` flips an already-open pane, focus stays
out of the covered terminal, nothing of the terminal's paints over the reader, the bottom bar is
one height, a sent prompt echoes before the POST returns, a shell keeps its terminal, a failed
refresh keeps the conversation, and merging two agents switches to their group layout. `fixtures.mjs` writes a Claude transcript and the
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
