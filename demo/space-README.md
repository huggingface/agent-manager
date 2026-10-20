---
title: Agent Manager reader demo
emoji: 📖
colorFrom: gray
colorTo: blue
sdk: static
app_file: index.html
pinned: false
---

# Agent Manager · reader demo

The real session reader from Agent Manager, on a synthetic conversation. No
sidebar, no settings, no setup.

It runs the production `ConversationView`, `ReaderStore`, `readerModel`
(reconciliation, `isOperatorPrompt`, `countExchanges`) and `splitExchanges`
unchanged. Only the transport is local: `fixtureApi` serves the session file in
byte windows aligned to whole records, honouring the same `bytes`/`min`
contract the server does.

## What it is for

- **Default history.** A cold reader asks for a small first window, then fills
  backward on its own until it holds a useful amount. *reset · load again* gives
  the reader a fresh identity and repeats that from cold.
- **The spinner.** Loading is deliberately slowed so the braille mark is
  visible. *remove delay* turns that off.
- **The top control.** Actionable (arrow, link colour) → loading (spinner) →
  `Full history loaded` (muted, not clickable).
- **Injected context.** The conversation contains an `<environment_context>`
  block, the `# AGENTS.md instructions` envelope Codex injects, a
  `<system-reminder>` and a developer skills block. None is drawn as a prompt or
  counted as an exchange — including inside expanded work — while prompts that
  *mention* skills, AGENTS.md or `<INSTRUCTIONS>` are kept. There are exactly 90
  exchanges.

## The two session files

`session.raw.jsonl` is a synthetic **Codex rollout** — the format the harness
writes, injected envelopes and all. `session.jsonl` is what this page serves:
the output of Agent Manager's own normalizer over that file, one reader turn per
line (`{ id, role, ts, kind?, blocks: [...] }`), which is exactly what a trace
window returns.

So the envelope filtering you see here is the production normalizer's, not
something the fixture pre-applied. The build refuses to publish if an injected
envelope survives as a user turn.

`session.jsonl` is fetched at runtime: drop a different one in and reload, no
rebuild needed.

Nothing here is copied from a real conversation.
