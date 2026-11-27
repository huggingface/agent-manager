# pi session traces

pi writes version 3 JSONL under `$PI_CODING_AGENT_DIR/sessions/<workspace>/`, with a UUID in the filename. Agent Manager pins each pane to that UUID and reads the corresponding file for its Overview and Reader. Assistant usage reports input and cache-write tokens as fresh input, with cache reads reported separately. Tool calls and results are joined by `toolCallId`.

The reader processes records linearly; branches created with `/tree` may interleave. Commands such as `/new`, `/resume` and `/fork` can change pi’s active session without updating Agent Manager’s pin, so a restart returns to the original session. Trace sharing and automatic input detection are not yet supported for pi.
