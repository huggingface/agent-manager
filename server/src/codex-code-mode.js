// Codex "code mode": one `exec` call whose input is a JavaScript snippet that
// calls the real tools, instead of one `function_call` per tool.
//
//   custom_tool_call  name: "exec"
//     input: text(await tools.exec_command({cmd:"rg --files looks/frames",max_output_tokens:2000}));
//   custom_tool_call_output
//     output: [{type:"input_text", text:"Script completed\nWall time 1.0 seconds\nOutput:\n"},
//              {type:"input_text", text:"{\"exit_code\":0,\"output\":\"…\"}"},
//              {type:"input_image", image_url:"data:image/png;base64,…"}]
//
// The snippet is never run. The `tools.<name>(<args>)` calls are read out of it
// with a small parser for JS literals, so each becomes the same tool call the
// classic format writes: `exec_command` with JSON arguments, `apply_patch` with
// the patch text.
//
// Everything here reads model-written text on the server thread, so the rules
// are: no regular expression runs over that text (scans are written out by
// hand and are linear), all snippet scanning draws on one work budget, no
// value is turned into a string unless it is known to be a primitive, and the
// two entry points the trace parsers use — `codeModeUses` for a call and
// `codeModeResults` for its output — never throw. When they cannot read a
// step they say so, and the caller shows it as "Ran a script".

// ---------- characters ----------
const isDigit = (c) => c >= '0' && c <= '9';
const isHex = (c) => isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
const isIdStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
const isIdChar = (c) => isIdStart(c) || isDigit(c);
const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f'
  || c === ' ' || c === '﻿' || c === ' ' || c === ' ';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------- limits ----------
// Past any of these the snippet is shown as a script instead of being unpacked.
const MAX_INPUT = 2 * 1024 * 1024;  // chars
const MAX_DEPTH = 64;               // nested literals, templates, `${}`
const WORK_PER_CHAR = 12;           // steps budgeted per input char
const LIMIT = Symbol('code-mode parse limit');
let budget = 0;
let depth = 0;
const spend = (n = 1) => { budget -= n; if (budget < 0) throw LIMIT; };
const enter = () => { if (++depth > MAX_DEPTH) throw LIMIT; };

// ---------- JS literals ----------
function skipSpace(src, i) {
  for (;;) {
    while (i < src.length && isSpace(src[i])) { spend(); i++; }
    if (src[i] === '/' && src[i + 1] === '/') {
      const n = src.indexOf('\n', i);
      const end = n === -1 ? src.length : n + 1;
      spend(end - i); i = end; continue;
    }
    if (src[i] === '/' && src[i + 1] === '*') {
      const n = src.indexOf('*/', i + 2);
      const end = n === -1 ? src.length : n + 2;
      spend(end - i); i = end; continue;
    }
    return i;
  }
}

function hexRun(src, i, max) {
  let k = i;
  while (k < src.length && k - i < max && isHex(src[k])) k++;
  return k;
}

// One escape sequence at `i` (just past the backslash) → [text, next index].
// An escape that names no character (`\u{110000}`) stays as written.
function escape(src, i) {
  const c = src[i];
  const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v' };
  if (c === undefined) return ['', i];
  if (Object.hasOwn(simple, c)) return [simple[c], i + 1];
  if (c === '0' && !isDigit(src[i + 1] || '')) return ['\0', i + 1];
  if (c === 'x' && hexRun(src, i + 1, 2) === i + 3) return [String.fromCharCode(parseInt(src.slice(i + 1, i + 3), 16)), i + 3];
  if (c === 'u') {
    if (src[i + 1] === '{') {
      const end = hexRun(src, i + 2, 6);
      if (end > i + 2 && src[end] === '}') {
        const cp = parseInt(src.slice(i + 2, end), 16);
        return [cp <= 0x10FFFF ? String.fromCodePoint(cp) : `\\${src.slice(i, end + 1)}`, end + 1];
      }
    } else if (hexRun(src, i + 1, 4) === i + 5) {
      return [String.fromCharCode(parseInt(src.slice(i + 1, i + 5), 16)), i + 5];
    }
  }
  if (c === '\r' && src[i + 1] === '\n') return ['', i + 2]; // line continuation
  if (c === '\n' || c === '\r' || c === ' ' || c === ' ') return ['', i + 1];
  return [c, i + 1];
}

function parseString(src, i) {
  const q = src[i];
  let out = '';
  for (let k = i + 1; k < src.length; k++) {
    spend();
    const c = src[k];
    if (c === q) return { value: out, end: k + 1 };
    if (c === '\n') return undefined;
    if (c === '\\') { const [t, n] = escape(src, k + 1); out += t; k = n - 1; continue; }
    out += c;
  }
  return undefined;
}

// A template literal. Substitutions cannot be known without running the code,
// so `${…}` is kept as written: `/frames/${p}.png` still says what was read.
function parseTemplate(src, i) {
  enter();
  try {
    let out = '';
    for (let k = i + 1; k < src.length; k++) {
      spend();
      const c = src[k];
      if (c === '`') return { value: out, end: k + 1 };
      if (c === '\\') { const [t, n] = escape(src, k + 1); out += t; k = n - 1; continue; }
      if (c === '$' && src[k + 1] === '{') {
        const close = skipCode(src, k + 2, '}');
        if (close === -1) return undefined;
        out += src.slice(k, close + 1);
        k = close;
        continue;
      }
      out += c;
    }
    return undefined;
  } finally { depth--; }
}

function parseNumber(src, i) {
  let k = i;
  if (src[k] === '-') k++;
  if (src[k] === '0' && (src[k + 1] === 'x' || src[k + 1] === 'X')) {
    const end = hexRun(src, k + 2, 16);
    if (end === k + 2) return undefined;
    spend(end - i);
    const n = parseInt(src.slice(k + 2, end), 16);
    return { value: src[i] === '-' ? -n : n, end };
  }
  const start = k;
  while (k < src.length && k - i < 40 && (isDigit(src[k]) || src[k] === '_')) k++;
  if (src[k] === '.') { k++; while (k < src.length && k - i < 40 && isDigit(src[k])) k++; }
  if (k === start || (k === start + 1 && src[start] === '.')) return undefined;
  if (src[k] === 'e' || src[k] === 'E') {
    let e = k + 1;
    if (src[e] === '+' || src[e] === '-') e++;
    const d = e;
    while (e < src.length && e - i < 40 && isDigit(src[e])) e++;
    if (e > d) k = e;
  }
  spend(k - i);
  const value = Number(src.slice(i, k).split('_').join(''));
  return Number.isNaN(value) ? undefined : { value, end: k };
}

// A JS value made of literals, or `undefined` when it is anything else (a
// variable, a call, a spread). `end` is the index just past it. Objects have
// no prototype, so a key like `__proto__` or `toString` is only a key.
function parseValue(src, i) {
  enter();
  try {
    i = skipSpace(src, i);
    const c = src[i];
    if (c === '"' || c === "'") return parseString(src, i);
    if (c === '`') return parseTemplate(src, i);
    if (c === '{') return parseObject(src, i);
    if (c === '[') return parseArray(src, i);
    if (c === '-' || c === '.' || isDigit(c || '')) return parseNumber(src, i);
    for (const [word, value] of [['true', true], ['false', false], ['null', null]]) {
      if (src.startsWith(word, i) && !isIdChar(src[i + word.length] || '')) return { value, end: i + word.length };
    }
    return undefined;
  } finally { depth--; }
}

function parseObject(src, i) {
  const value = Object.create(null);
  let k = skipSpace(src, i + 1);
  while (src[k] !== '}') {
    spend();
    let key;
    if (src[k] === '"' || src[k] === "'") {
      const s = parseString(src, k); if (!s) return undefined;
      key = s.value; k = s.end;
    } else if (isIdChar(src[k] || '')) {
      const s = k;
      while (k < src.length && isIdChar(src[k])) { spend(); k++; }
      key = src.slice(s, k);
    } else {
      return undefined; // spread, computed key, …
    }
    k = skipSpace(src, k);
    if (src[k] !== ':') return undefined; // shorthand `{path}` names a variable
    const v = parseValue(src, k + 1);
    if (!v) return undefined;
    value[key] = v.value;
    k = skipSpace(src, v.end);
    if (src[k] === ',') k = skipSpace(src, k + 1);
    else if (src[k] !== '}') return undefined;
  }
  return { value, end: k + 1 };
}

function parseArray(src, i) {
  const value = [];
  let k = skipSpace(src, i + 1);
  while (src[k] !== ']') {
    spend();
    const v = parseValue(src, k);
    if (!v) return undefined;
    value.push(v.value);
    k = skipSpace(src, v.end);
    if (src[k] === ',') k = skipSpace(src, k + 1);
    else if (src[k] !== ']') return undefined;
  }
  return { value, end: k + 1 };
}

// Index of the `close` that ends the code starting at `i`, stepping over
// strings, templates, comments and nested brackets; -1 if it never does.
function skipCode(src, i, close) {
  const stack = [close];
  for (let k = i; k < src.length; k++) {
    spend();
    const c = src[k];
    if (c === '"' || c === "'") { const s = parseString(src, k); if (!s) return -1; k = s.end - 1; continue; }
    if (c === '`') { const s = parseTemplate(src, k); if (!s) return -1; k = s.end - 1; continue; }
    if (c === '/' && (src[k + 1] === '/' || src[k + 1] === '*')) { k = skipSpace(src, k) - 1; continue; }
    if (c === '(') stack.push(')');
    else if (c === '[') stack.push(']');
    else if (c === '{') stack.push('}');
    else if (c === stack[stack.length - 1]) { stack.pop(); if (!stack.length) return k; }
  }
  return -1;
}

// `tools.name(` or `tools["name"](` at `k` → { name, open } (open = just past
// the parenthesis), or null.
function toolAt(src, k) {
  if (!src.startsWith('tools', k)) return null;
  const prev = k > 0 ? src[k - 1] : '';
  if (prev && (isIdChar(prev) || prev === '.')) return null;
  let j = skipSpace(src, k + 5);
  let name;
  if (src[j] === '.') {
    j = skipSpace(src, j + 1);
    if (!isIdStart(src[j] || '')) return null;
    const s = j;
    while (j < src.length && isIdChar(src[j])) { spend(); j++; }
    name = src.slice(s, j);
  } else if (src[j] === '[') {
    j = skipSpace(src, j + 1);
    if (src[j] !== '"' && src[j] !== "'") return null;
    const s = parseString(src, j);
    if (!s || !s.value || s.value.length > 100) return null;
    name = s.value;
    j = skipSpace(src, s.end);
    if (src[j] !== ']') return null;
    j++;
  } else return null;
  j = skipSpace(src, j);
  return src[j] === '(' ? { name, open: j + 1 } : null;
}

/**
 * The tool calls in a code-mode snippet, in source order: `{ name, args }`
 * with the parsed first argument, or `{ name, raw }` with the argument source
 * when it is not a literal. `parsed` is false when the snippet names no tool,
 * when a call never closes, or when the snippet is too big, deep or costly to
 * read.
 */
export function codeModeCalls(code) {
  const src = typeof code === 'string' ? code : '';
  if (src.length > MAX_INPUT) return { calls: [], parsed: false };
  budget = WORK_PER_CHAR * src.length + 1000;
  depth = 0;
  try {
    const calls = [];
    for (let k = 0; k < src.length; k++) {
      spend();
      const c = src[k];
      if (c === '"' || c === "'") { const s = parseString(src, k); if (s) k = s.end - 1; continue; }
      if (c === '`') { const s = parseTemplate(src, k); if (s) k = s.end - 1; continue; }
      if (c === '/' && (src[k + 1] === '/' || src[k + 1] === '*')) { k = skipSpace(src, k) - 1; continue; }
      if (c !== 't') continue;
      const at = toolAt(src, k);
      if (!at) continue;
      const close = skipCode(src, at.open, ')');
      // A call that never closes is not a call we can report; and everything
      // after it is inside it, so there is nothing further to find.
      if (close === -1) return { calls: [], parsed: false };
      const first = skipSpace(src, at.open);
      let v = first === close ? { value: Object.create(null), end: close } : parseValue(src, first);
      if (v) {
        // The literal must be the whole argument list (one trailing comma allowed).
        let j = skipSpace(src, v.end);
        if (src[j] === ',') j = skipSpace(src, j + 1);
        if (j !== close) v = undefined;
      }
      calls.push(v ? { name: at.name, args: v.value } : { name: at.name, raw: src.slice(at.open, close).trim() });
      // Calls nested inside the arguments are not a thing tools take; carry on
      // after them rather than inside.
      k = close;
    }
    return { calls, parsed: calls.length > 0 };
  } catch (e) {
    if (e === LIMIT || e instanceof RangeError) return { calls: [], parsed: false };
    throw e;
  }
}

// ---------- data URLs ----------
const isMimeChar = (c) => isIdChar(c) || c === '.' || c === '+' || c === '-';
const isParamChar = (c) => isMimeChar(c) || c === '=';
const isB64Char = (c) => isIdChar(c) || c === '+' || c === '/' || c === '=' || c === '-';

// End of the base64 data URL starting at `k` (at "data:"), or -1. JSON's
// escaped slash (`image\/png`, `ab\/cd`) counts as a slash: this runs on text
// before it is decoded as well as after.
function dataUrlEnd(t, k) {
  let i = k + 5;
  const run = (ok) => { const s = i; while (i < t.length && ok(t[i])) i++; return i > s; };
  const slash = () => {
    if (t[i] === '/') { i++; return true; }
    if (t[i] === '\\' && t[i + 1] === '/') { i += 2; return true; }
    return false;
  };
  if (!run(isMimeChar) || !slash() || !run(isMimeChar)) return -1;
  for (;;) {
    if (t[i] !== ';') return -1;
    i++;
    if (t.startsWith('base64,', i)) { i += 7; break; }
    if (!run(isParamChar)) return -1;
  }
  for (;;) {
    if (i < t.length && isB64Char(t[i])) i++;
    else if (t[i] === '\\' && t[i + 1] === '/') i += 2;
    else break;
  }
  return i;
}

/** `text` with every base64 data URL replaced by a short marker; '' for a non-string. */
export function stripDataUrls(text) {
  if (typeof text !== 'string') return '';
  let k = text.indexOf('data:');
  if (k === -1) return text;
  let out = '';
  let from = 0;
  while (k !== -1) {
    const end = dataUrlEnd(text, k);
    if (end === -1) { k = text.indexOf('data:', k + 5); continue; }
    const kind = text.startsWith('data:image', k) ? 'image' : 'data';
    out += `${text.slice(from, k)}[${kind}, ${Math.round(((end - k) * 3) / 4 / 1024)} KB]`;
    from = end;
    k = text.indexOf('data:', end);
  }
  return out + text.slice(from);
}

// ---------- call side ----------
/** Files a patch touches, from its `*** Add/Update/Delete File:` headers (raw or JSON-escaped). */
export function patchFiles(patch) {
  if (typeof patch !== 'string') return [];
  const files = [];
  for (let k = patch.indexOf('*** '); k !== -1; k = patch.indexOf('*** ', k + 4)) {
    let i = -1;
    for (const head of ['*** Add File: ', '*** Update File: ', '*** Delete File: ']) {
      if (patch.startsWith(head, k)) { i = k + head.length; break; }
    }
    if (i === -1) continue;
    let e = i;
    while (e < patch.length && patch[e] !== '\n' && patch[e] !== '\\' && patch[e] !== '"') e++;
    const file = patch.slice(i, e).trim();
    if (file) files.push(file);
    k = Math.max(k, e - 4);
  }
  return files;
}

/** The text a classic call carries for these arguments, with data URLs stripped. */
function callText(call) {
  if (typeof call.raw === 'string') return stripDataUrls(call.raw);
  if (typeof call.args === 'string') return stripDataUrls(call.args); // apply_patch's patch text
  const json = JSON.stringify(call.args ?? {});
  return stripDataUrls(typeof json === 'string' ? json : '{}');
}

/**
 * A code-mode call as the calls it made: `[{ name, text, file }]`, where `text`
 * is what the classic format would carry and `file` the patched file for an
 * apply_patch. `null` when the snippet is to be shown as a script. Never throws.
 */
export function codeModeUses(code) {
  try {
    const { calls, parsed } = codeModeCalls(code);
    if (!parsed) return null;
    return calls.map((c) => ({
      name: c.name,
      text: callText(c),
      file: c.name === 'apply_patch' && typeof c.args === 'string' ? patchFiles(c.args)[0] || null : null,
    }));
  } catch {
    return null;
  }
}

// ---------- output side ----------
// "Script completed\nWall time 1.0 seconds\nOutput:\n…" → [rest, wallMs, failed],
// or null when the text does not start with that header.
function unwrap(text) {
  const nl = text.indexOf('\n');
  const head = nl === -1 ? text : text.slice(0, nl);
  const status = ['completed', 'failed', 'errored', 'timed out'].find((s) => head.startsWith(`Script ${s}`));
  if (!status) return null;
  let i = nl === -1 ? text.length : nl + 1;
  let wallMs = null;
  if (text.startsWith('Wall time ', i)) {
    let e = i + 10;
    while (e < text.length && e - i < 30 && (isDigit(text[e]) || text[e] === '.')) e++;
    const secs = Number(text.slice(i + 10, e));
    if (e > i + 10 && Number.isFinite(secs)) wallMs = Math.round(secs * 1000);
    const end = text.indexOf('\n', e);
    i = end === -1 ? text.length : end + 1;
  }
  if (text.startsWith('Output:', i)) i += text[i + 7] === '\n' ? 8 : 7;
  return [text.slice(i), wallMs, status !== 'completed'];
}

/** A value as text, without calling anything on it. */
function describe(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return `${v}`;
  if (isObj(v) && typeof v.message === 'string') return v.message;
  try { const s = JSON.stringify(v); return typeof s === 'string' ? s : ''; } catch { return ''; }
}

// A tool's own JSON result, as the script printed it, read for what a person
// wants: the output text, and the exit code when it is not 0. Data URLs are
// stripped again after decoding: an escape can hide one from the first pass.
function readable(text) {
  const t = text.trim();
  if (t[0] !== '{') return { text };
  let o;
  try { o = JSON.parse(t); } catch { return { text }; }
  if (!isObj(o)) return { text };
  // Promise.allSettled entries: {i, status, value} or {status, reason}.
  if (o.status === 'rejected') return { text: stripDataUrls(describe(o.reason)), failed: true };
  if (o.status === 'fulfilled' && isObj(o.value)) o = o.value;
  if (typeof o.output !== 'string') return { text: stripDataUrls(describe(o)) };
  const out = stripDataUrls(o.output);
  const code = typeof o.exit_code === 'number' && Number.isFinite(o.exit_code) ? o.exit_code : 0;
  return { text: code ? `${out}${out.endsWith('\n') || !out ? '' : '\n'}(exit ${code})` : out, failed: code !== 0 };
}

// A code-mode output, in order: `{ text }` parts without the wrapper and with
// data URLs stripped, and `{ image }` parts; plus the wall time and whether
// the script itself failed.
function partsOf(output) {
  const raw = Array.isArray(output) ? output : [typeof output === 'string' ? { type: 'input_text', text: output } : output];
  const parts = [];
  let wallMs = null;
  let failed = false;
  let first = true;
  for (const p of raw) {
    if (!isObj(p)) continue;
    if (p.type === 'input_image' || p.type === 'image') {
      const src = typeof p.image_url === 'string' ? p.image_url : isObj(p.image_url) ? p.image_url.url : null;
      if (typeof src === 'string' && src) parts.push({ image: src });
      continue;
    }
    let text = typeof p.text === 'string' ? p.text : '';
    if (first) {
      first = false;
      const w = unwrap(text);
      if (w) [text, wallMs, failed] = w;
    }
    parts.push({ text: stripDataUrls(text) });
  }
  return { parts, wallMs, failed };
}

// Parts as one result: the text a person reads, the images, and whether any
// part failed.
function render(parts) {
  const texts = [];
  const images = [];
  let failed = false;
  for (const p of parts) {
    if (typeof p.image === 'string') { images.push({ src: p.image }); continue; }
    const r = readable(p.text);
    failed = failed || !!r.failed;
    const t = r.text.trim();
    if (t && t !== '{}') texts.push(stripDataUrls(r.text.trimEnd()));
  }
  return { text: texts.join('\n'), images, failed };
}

/** The whole output as one result, plus the wall time. */
export function codeModeOutput(output) {
  const { parts, wallMs, failed } = partsOf(output);
  const r = render(parts);
  return { ...r, wallMs, failed: failed || r.failed };
}

// The snippet without whitespace, for spotting the labelled forms below.
function compact(code) {
  let out = '';
  for (let k = 0; k < code.length; k++) if (!isSpace(code[k])) out += code[k];
  return out;
}

// Which labelled form the snippet prints its results in, read from the code:
//   'json'    results.forEach((r,i)=>text({i,...r}))     → {"i":0,"status":…} each
//   'marker'  for(let i=0;i<rs.length;i++){text(i); …}    → "0", result, "1", result, …
// Anything else is unlabelled, and its output cannot be split per call.
function labelForm(code) {
  if (typeof code !== 'string' || code.length > MAX_INPUT) return null;
  const c = compact(code);
  if (c.includes('text({i,...') || c.includes('text({i:i,...')) return 'json';
  let seen = 0;
  for (let k = c.indexOf('for('); k !== -1 && seen < 50; k = c.indexOf('for(', k + 4), seen++) {
    let i = k + 4;
    for (const kw of ['let', 'var', 'const']) {
      if (c.startsWith(kw, i) && isIdStart(c[i + kw.length] || '')) { i += kw.length; break; }
    }
    const s = i;
    while (i < c.length && isIdChar(c[i])) i++;
    const v = c.slice(s, i);
    if (!v || !isIdStart(v[0])) continue;
    if (c.startsWith(`=0;${v}<`, i) && c.includes(`{text(${v});`)) return 'marker';
  }
  return null;
}

const asIndex = (t) => {
  const s = t.trim();
  if (!s || s.length > 6) return null;
  for (const ch of s) if (!isDigit(ch)) return null;
  return Number(s);
};
const asLabelled = (t) => {
  const s = t.trim();
  if (s[0] !== '{') return null;
  try {
    const o = JSON.parse(s);
    return isObj(o) && Number.isInteger(o.i) && (o.status === 'fulfilled' || o.status === 'rejected') ? o.i : null;
  } catch { return null; }
};

// The output split per call, or null when the snippet did not label it in a
// form we know, or the output does not follow that form exactly.
function split(parts, code, n) {
  if (n === 1) return [parts];
  const form = labelForm(code);
  if (!form) return null;
  const segs = Array.from({ length: n }, () => []);
  let cur = -1;
  for (const p of parts) {
    const text = typeof p.text === 'string' ? p.text : null;
    if (text !== null && !text.trim()) continue;
    if (form === 'marker') {
      // Every index once, in order: 0, 1, … n-1. A number anywhere else — a
      // result that happens to print one — makes the labels unreadable.
      const at = text !== null ? asIndex(text) : null;
      if (at !== null) {
        if (at !== cur + 1 || at >= n) return null;
        cur = at;
        continue;
      }
    } else if (text !== null) {
      const at = asLabelled(text);
      if (at === null || at <= cur || at >= n) return null;
      cur = at;
    }
    if (cur === -1) return null;
    segs[cur].push(p);
  }
  if (form === 'marker' && cur !== n - 1) return null;
  return cur === -1 ? null : segs;
}

/**
 * A code-mode output for the `n` calls `code` made:
 *   { perCall: [{ text, images, failed }], wallMs }   one result per call, or
 *   { script: { text, images, failed }, wallMs }      the output as a whole,
 * the second when the script did not say which output was whose. Never throws:
 * an output it cannot read comes back as an empty script result.
 */
export function codeModeResults(output, code, n) {
  try {
    const { parts, wallMs, failed } = partsOf(output);
    const segs = split(parts, code, n);
    if (segs) {
      const perCall = segs.map((seg) => {
        const r = render(seg);
        const empty = !r.text && !r.images.length;
        return { ...r, failed: r.failed || (failed && (n === 1 || empty)) };
      });
      return { perCall, wallMs };
    }
    const r = render(parts);
    return { script: { ...r, failed: r.failed || failed }, wallMs };
  } catch {
    return { script: { text: '', images: [], failed: false }, wallMs: null };
  }
}
