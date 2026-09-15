# Reader demo (not part of the app build)

A standalone page that runs the production reader on a bundled synthetic
session, deployed as a static Space. Nothing here is imported by `web/` or
`server/`, and nothing here ships in the app: it only imports *from* `web/src`.

```sh
ln -sfn ../web/node_modules node_modules   # once, for esbuild
node make-fixture.mjs                      # regenerate session.jsonl
node build.mjs                             # -> dist/
node check.mjs                             # drive dist/ in a browser
node live.mjs                              # drive the deployed Space
hf upload lvwerra/am-reader-demo ./dist . --repo-type space
```

`src/fixtureApi.ts` is the only substitution: it serves `session.jsonl` in byte
windows aligned to whole records, honouring the same `bytes`/`min` contract as
`server/src/traces.js`. `ConversationView`, `ReaderStore`, `readerModel` and
`splitExchanges` are the production modules, unmodified.

`session.jsonl` is fetched at runtime, so replacing it in the Space changes the
conversation without a rebuild.
