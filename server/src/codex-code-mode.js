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
// the patch text. Anything the parser cannot read is kept as source, and a
// snippet with no readable call at all is reported as unparsed so the caller
// can show it as a script rather than a one-line label.

const IDENT = /[A-Za-z0-9_$]/;

// Limits. The snippet is model-written text arriving on the server thread, so
// reading it must stay linear and shallow whatever it contains: past any of
// these the snippet is shown as a script instead of being unpacked.
const MAX_INPUT = 2 * 1024 * 1024;  // chars
const MAX_DEPTH = 64;               // nested literals, templates, `${}`
const WORK_PER_CHAR = 12;           // steps budgeted per input char
const LIMIT = Symbol('code-mode parse limit');
let budget = 0;
let depth = 0;
const step = () => { if (--budget < 0) throw LIMIT; };
const enter = () => { if (++depth > MAX_DEPTH) throw LIMIT; };

// A JS value made of literals, or `undefined` when it is anything else (a
// variable, a call, a spread). `end` is the index just past it.
function parseValue(src, i) {
  enter();
  try {
    i = skipSpace(src, i);
    const c = src[i];
    if (c === '"' || c === "'") return parseString(src, i);
    if (c === '`') return parseTemplate(src, i);
    if (c === '{') return parseObject(src, i);
    if (c === '[') return parseArray(src, i);
    const num = /^-?(?:0[xX][0-9a-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)/.exec(src.slice(i, i + 40));
    if (num) return { value: Number(num[0].replace(/_/g, '')), end: i + num[0].length };
    for (const [word, value] of [['true', true], ['false', false], ['null', null]]) {
      if (src.startsWith(word, i) && !IDENT.test(src[i + word.length] || '')) return { value, end: i + word.length };
    }
    return undefined;
  } finally { depth--; }
}

function skipSpace(src, i) {
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) { step(); i++; }
    if (src.startsWith('//', i)) { const n = src.indexOf('\n', i); budget -= (n === -1 ? src.length : n) - i; step(); i = n === -1 ? src.length : n + 1; continue; }
    if (src.startsWith('/*', i)) { const n = src.indexOf('*/', i + 2); budget -= (n === -1 ? src.length : n) - i; step(); i = n === -1 ? src.length : n + 2; continue; }
    return i;
  }
}

// One escape sequence at `i` (just past the backslash) → [text, next index].
// An escape that names no character (`\u{110000}`) stays as written.
function escape(src, i) {
  const c = src[i];
  const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
  if (c in simple && !(c === '0' && /\d/.test(src[i + 1] || ''))) return [simple[c], i + 1];
  if (c === 'x' && /^[0-9a-fA-F]{2}$/.test(src.slice(i + 1, i + 3))) return [String.fromCharCode(parseInt(src.slice(i + 1, i + 3), 16)), i + 3];
  if (c === 'u') {
    const braced = /^\{([0-9a-fA-F]{1,6})\}/.exec(src.slice(i + 1, i + 10));
    if (braced) {
      const cp = parseInt(braced[1], 16);
      const end = i + 1 + braced[0].length;
      return [cp <= 0x10FFFF ? String.fromCodePoint(cp) : `\\${src.slice(i, end)}`, end];
    }
    if (/^[0-9a-fA-F]{4}$/.test(src.slice(i + 1, i + 5))) return [String.fromCharCode(parseInt(src.slice(i + 1, i + 5), 16)), i + 5];
  }
  if (c === '\r' && src[i + 1] === '\n') return ['', i + 2]; // line continuation
  if (c === '\n' || c === '\r' || c === ' ' || c === ' ') return ['', i + 1];
  return [c ?? '', i + 1];
}

function parseString(src, i) {
  const q = src[i];
  let out = '';
  for (let k = i + 1; k < src.length; k++) {
    step();
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
      step();
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

function parseObject(src, i) {
  const value = {};
  let k = skipSpace(src, i + 1);
  while (src[k] !== '}') {
    step();
    let key;
    if (src[k] === '"' || src[k] === "'") {
      const s = parseString(src, k); if (!s) return undefined;
      key = s.value; k = s.end;
    } else {
      const m = /^[A-Za-z_$][\w$]*|^\d+/.exec(src.slice(k, k + 200));
      if (!m) return undefined; // spread, computed key, …
      key = m[0]; k += m[0].length;
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
    step();
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
    step();
    const c = src[k];
    if (c === '"' || c === "'") { const s = parseString(src, k); if (!s) return -1; k = s.end - 1; continue; }
    if (c === '`') { const s = parseTemplate(src, k); if (!s) return -1; k = s.end - 1; continue; }
    if (src.startsWith('//', k) || src.startsWith('/*', k)) { k = skipSpace(src, k) - 1; continue; }
    if (c === '(') stack.push(')');
    else if (c === '[') stack.push(']');
    else if (c === '{') stack.push('}');
    else if (c === stack[stack.length - 1]) { stack.pop(); if (!stack.length) return k; }
  }
  return -1;
}

/**
 * The tool calls in a code-mode snippet, in source order.
 *
 * Each is `{ name, args }`: `args` is the parsed first argument (an object, or
 * the patch string for apply_patch), or `{ raw }` with the argument source when
 * it is not a literal. `parsed` is false when the snippet names no tool, when a
 * call never closes, or when the snippet is too big, deep or costly to read —
 * the caller then shows it as a script. Never throws.
 */
export function codeModeCalls(code) {
  const src = String(code ?? '');
  if (src.length > MAX_INPUT) return { calls: [], parsed: false };
  budget = WORK_PER_CHAR * src.length + 1000;
  depth = 0;
  try {
    const calls = [];
    for (let k = 0; k < src.length; k++) {
      step();
      const c = src[k];
      if (c === '"' || c === "'") { const s = parseString(src, k); if (s) k = s.end - 1; continue; }
      if (c === '`') { const s = parseTemplate(src, k); if (s) k = s.end - 1; continue; }
      if (src.startsWith('//', k) || src.startsWith('/*', k)) { k = skipSpace(src, k) - 1; continue; }
      if (!src.startsWith('tools', k) || (k > 0 && /[\w$.]/.test(src[k - 1]))) continue;
      const m = /^tools\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(["'])([^"'\n]+)\2\s*\])\s*\(/.exec(src.slice(k, k + 200));
      if (!m) continue;
      const name = m[1] || m[3];
      const open = k + m[0].length;
      const close = skipCode(src, open, ')');
      // A call that never closes is not a call we can report; and everything
      // after it is inside it, so there is nothing further to find.
      if (close === -1) return { calls: [], parsed: false };
      const argSrc = src.slice(open, close);
      const v = argSrc.trim() ? parseValue(src, open) : { value: {}, end: open };
      const whole = v && /^\s*,?\s*$/.test(src.slice(v.end, close));
      calls.push({ name, args: whole ? v.value : { raw: argSrc.trim() } });
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

// Inline image data: never text a person reads, searches or digests.
const DATA_URL = /data:[\w.+-]+\/[\w.+-]+(?:;[\w.+=-]+)*;base64,[A-Za-z0-9+/=_-]*/g;
/** `text` with every base64 data URL replaced by a short marker. */
export function stripDataUrls(text) {
  return String(text ?? '').replace(DATA_URL, (m) => `[${m.startsWith('data:image/') ? 'image' : 'data'}, ${Math.round(m.length * 3 / 4 / 1024)} KB]`);
}

/** The text a classic tool call carries for these arguments (data URLs stripped). */
export function classicArgs(name, args) {
  if (typeof args === 'string') return stripDataUrls(args);          // apply_patch's patch text
  if (args && typeof args === 'object' && 'raw' in args && Object.keys(args).length === 1) return stripDataUrls(args.raw);
  return stripDataUrls(JSON.stringify(args ?? {}));
}

const WRAPPER = /^Script (?:completed|failed|errored|timed out)[^\n]*\n(?:Wall time ([\d.]+) seconds?\n)?(?:Output:\n?)?/;

// A tool's own JSON result, as the script printed it, read for what a person
// wants: the output text, and the exit code when it is not 0.
function readable(text) {
  const t = text.trim();
  if (!t.startsWith('{')) return { text };
  let o; try { o = JSON.parse(t); } catch { return { text }; }
  // Promise.allSettled entries: {i, status, value} or {status, reason}.
  if (o && o.status === 'rejected') return { text: String(o.reason?.message ?? JSON.stringify(o.reason ?? '')), failed: true };
  if (o && o.status === 'fulfilled' && o.value && typeof o.value === 'object') o = o.value;
  if (!o || typeof o.output !== 'string') return { text };
  const code = typeof o.exit_code === 'number' ? o.exit_code : null;
  return { text: code ? `${o.output}${o.output.endsWith('\n') || !o.output ? '' : '\n'}(exit ${code})` : o.output, failed: !!code };
}

/**
 * A code-mode output, unwrapped: `parts` in order (`{ text }` without the
 * "Script completed / Wall time / Output:" header, or `{ image }`), the wall
 * time, and whether the script itself failed. Data URLs never stay in a text.
 */
export function codeModeParts(output) {
  const raw = Array.isArray(output) ? output : [typeof output === 'string' ? { type: 'input_text', text: output } : output];
  const parts = [];
  let wallMs = null;
  let failed = false;
  let first = true;
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'input_image' || p.type === 'image') {
      const src = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
      if (typeof src === 'string' && src) parts.push({ image: src });
      continue;
    }
    let text = typeof p.text === 'string' ? p.text : '';
    if (first) {
      first = false;
      if (/^Script (?:failed|errored|timed out)/.test(text)) failed = true;
      const m = WRAPPER.exec(text);
      if (m) { if (m[1]) wallMs = Math.round(Number(m[1]) * 1000); text = text.slice(m[0].length); }
    }
    parts.push({ text: stripDataUrls(text) });
  }
  return { parts, wallMs, failed };
}

/** Parts as one result: the text a person reads, the images, and whether any part failed. */
export function renderParts(parts) {
  const texts = [];
  const images = [];
  let failed = false;
  for (const p of parts) {
    if ('image' in p) { images.push({ src: p.image }); continue; }
    const r = readable(p.text);
    failed = failed || !!r.failed;
    if (r.text.trim() && r.text.trim() !== '{}') texts.push(r.text.replace(/\n+$/, ''));
  }
  return { text: texts.join('\n'), images, failed };
}

/** The whole output as one result, plus the wall time. */
export function codeModeOutput(output) {
  const { parts, wallMs, failed } = codeModeParts(output);
  const r = renderParts(parts);
  return { ...r, wallMs, failed: failed || r.failed };
}

const indexOf = (p) => {
  if (!('text' in p)) return null;
  const t = p.text.trim();
  if (/^\d+$/.test(t)) return { i: Number(t), marker: true };          // text(i); text(r[i])
  if (!t.startsWith('{')) return null;
  try {                                                                    // text({i, ...r})
    const o = JSON.parse(t);
    return o && Number.isInteger(o.i) && typeof o.status === 'string' ? { i: o.i, marker: false } : null;
  } catch { return null; }
};

/**
 * The output split per call, when the script said which call each part came
 * from: either `text(i)` before each result or `text({i, ...result})`, with
 * indexes increasing and within range. `null` when it did not — pairing by
 * guesswork puts one call's output, and its failure, on another.
 */
export function pairParts(parts, n) {
  if (n === 1) return [parts];
  const segs = Array.from({ length: n }, () => []);
  let cur = -1;
  for (const p of parts) {
    if ('text' in p && !p.text.trim()) continue;
    const at = indexOf(p);
    if (at && at.i > cur && at.i < n) {
      cur = at.i;
      if (!at.marker) segs[cur].push(p);
      continue;
    }
    if (cur === -1) return null;   // output before any index: whose is it?
    if (at) return null;           // an index out of order or out of range
    segs[cur].push(p);
  }
  return cur === -1 ? null : segs;
}

/** Files a patch touches, from its `*** Add/Update/Delete File:` headers. */
export function patchFiles(patch) {
  return [...String(patch ?? '').matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\\\n"]+)/g)].map((m) => m[1].trim());
}
