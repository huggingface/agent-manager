# API audit log: retained content and credential filtering

Agent Manager appends accepted mutating API calls, plus resolved agent waits, to
`operations.jsonl` under the private data directory. The log is meant to answer
who asked whom to do what and what happened, so it retains full non-secret
request, prompt, file-write, result and error content. It has no route allowlist,
payload cap, hashes-only mode or retention setting.

This is a **sensitive private audit log**, not an export-safe artifact. Deleting
a source session or file does not delete the copy already recorded here. Keep
the Space and its bucket private.

## New-record filtering policy

Version 2 records carry:

```json
{"version":2,"audit":{"credentialFilter":{"policy":"credentials-v1","status":"applied"}}}
```

The filter operates on a detached audit representation immediately before JSON
serialization and append. The handler, agent input, file content, response and
session objects keep the original values.

| Rule | What `credentials-v1` replaces |
|---|---|
| Sensitive structured fields | Values under normalized credential names such as `authorization`, `password`, `token`, `api_key`, `clientSecret`, `private_key`, `subscription` and `endpoint`. A short value is still removed when its field is explicitly sensitive. Similar ordinary names such as `tokenizer` and `secretary` are retained. |
| Provider/standard shapes | Hugging Face `hf_…`; Anthropic `sk-ant-…`; OpenAI `sk-…` including `sk-proj-…`/`sk-svcacct-…`; OpenRouter `sk-or-v1-…`; GitHub `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` and `github_pat_`; AWS `AKIA…` access-key ids; Google `AIza…`, `AQ.…` and `ya29.…`; three-part JWT-shaped strings. Boundaries and minimum lengths prevent short examples and ordinary identifiers from matching. |
| Explicit text | Values in authorization text (`Authorization: Bearer …`, Basic or Token) and credential assignments such as `OPENAI_API_KEY="…"`, `password: …`, query-string `token=…`, and the same shapes in an escaped embedded JSON string. The label and surrounding ordinary text remain. |
| Private keys | A complete matching `BEGIN … PRIVATE KEY` through `END … PRIVATE KEY` block, including PKCS, RSA, EC, OpenSSH and PGP-style labels. The whole block becomes one placeholder. An incomplete marker is retained because there is no safe block boundary to remove. |
| Configured values | Exact values, at least eight non-whitespace characters long, from the Space's existing injected-secret catalog. Duplicates are removed, overlaps run longest-first, and one URL-encoded form is matched. The catalog is read for each new record, so rotation does not retain an obsolete matcher. Values are never sent to the browser. |
| Buffers | UTF-8 Buffers use the text policy. Other Buffers use a one-byte mapping so recognizable ASCII credentials cannot evade filtering merely because the stored representation is base64. The retained byte length, checksum and base64 are all derived from the filtered bytes. |

The provider prefixes follow provider-owned references: [Hugging Face user
tokens](https://huggingface.co/docs/hub/security-tokens), [OpenAI API
keys](https://help.openai.com/en/articles/6882433-incorrect-api-key-provided),
[Anthropic SDK credential examples](https://github.com/anthropics/anthropic-sdk-python/blob/main/examples/workload_identity.py),
[OpenRouter keys](https://openrouter.ai/docs/api/reference/authentication),
[GitHub token formats](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github),
and [Google's Gemini tooling recognizers](https://github.com/google-gemini/gemini-skills).

Every replacement is the fixed string `[redacted]`. No rule name, secret hash,
preview or per-secret fingerprint is retained.

## What the filter cannot promise

An arbitrary unlabeled password has no reliable shape. If it is not a supported
token, explicit assignment/private-key block, sensitive structured field or one
of the currently injected values, it remains. Ordinary base64/hex strings,
archives, compressed data and nested encodings are not recursively decoded.
Opaque binary receives only the direct ASCII checks described above. The filter
does not scan workspaces, CLI credential files, the home directory, historical
logs or backups, and it makes no network calls.

These deliberate limits avoid erasing long IDs, URLs, code samples and ordinary
words while keeping work bounded by the retained input, the fixed rule set and
the small injected-value set. There is no scan cutoff or raw unscanned tail.
The focused test prints baseline/filter/event-loop timings for a representative
multi-megabyte value; filtering remains synchronous with the existing append,
so that measured duration is also the event-loop delay for that write.

Filtering is best effort, not a confidentiality guarantee. Do not publish an
audit record merely because its metadata says the filter ran.

## Checksums, failures and compatibility

Text `chars` and `sha256`, and Buffer `bytes`/`sha256`, describe the **stored
filtered value**. Unchanged text keeps its ordinary checksum. Different original
credentials can both become `[redacted]`, so an equal v2 checksum proves only
that the retained payloads match; the API-log UI says this explicitly.

If sanitizing a new record throws, Agent Manager writes one minimal v2 audit
failure entry containing generated identifiers and fixed diagnostic text—never
the raw path, labels, payload or exception. If append itself fails, it logs one
fixed server diagnostic and does not retry an append that may have partially
landed. Neither failure changes or replays the completed API operation, and the
next healthy event can still be recorded.

Records without `audit.credentialFilter` are legacy records. This change is
prospective: existing JSONL bytes and backups are not inspected, rewritten,
migrated or deleted, and older entries must not be assumed filtered.
