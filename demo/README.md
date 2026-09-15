# Reader demo (not part of the app build)

A standalone page that runs the production reader on a bundled synthetic
session, deployed as a static Space. Nothing here is imported by `web/` or
`server/`, and nothing here ships in the app: it only imports *from* `web/src`.

```sh
ln -sfn ../web/node_modules node_modules   # once, for esbuild
node make-fixture.mjs                      # regenerate session.jsonl
node build.mjs                             # -> dist/
node check.mjs                             # verify dist/ in a browser; exits nonzero on a regression
node live.mjs                              # drive the deployed Space
hf upload lvwerra/am-reader-demo ./dist . --repo-type space
```

`src/fixtureApi.ts` is the only substitution: it serves `session.jsonl` in byte
windows aligned to whole records, honouring the same `bytes`/`min` contract as
`server/src/traces.js`. `ConversationView`, `ReaderStore`, `readerModel` and
`splitExchanges` are the production modules, unmodified.

## The two session files

| file | what it is |
|---|---|
| `session.raw.jsonl` | a synthetic **Codex rollout** — the format the harness writes. One record per line: `{timestamp, type: 'response_item', payload: {...}}`, plus `session_meta` and `turn_context`. This is the demo's *input*, and it still contains the injected envelopes. |
| `session.jsonl` | what the page **serves**: the output of the production normalizer over the file above. One reader turn per line — `{ id, role, ts, kind?, blocks: [...] }`, exactly the objects a trace window's `turns` array holds. |

`build.mjs` runs `normalize.mjs` first, so the served file is always derived by
`server/src/traces.js` and never written by hand. That normalization is the step
that files injected context as `system`; the build fails if any envelope
survives as a user turn, so the demo cannot silently drift away from production
behaviour.

To swap the conversation: replace `session.jsonl` in the Space and reload — it
is fetched at runtime. To change the *input*, edit `make-fixture.mjs`, then
`node build.mjs`.
