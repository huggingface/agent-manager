// Redaction ruleset for session shares (docs/session-sharing.md §7).
//
// Kept apart from share-session.mjs so the rules can be tested on their own
// (server/test/share-redact.test.mjs) without building a whole bundle.
//
// Every rule except `email` is a SECRET rule: one hit blocks the share
// (server/src/share.js isSecretRule), for public and gated shares alike. So a
// pattern here must be specific enough not to fire on ordinary prose, hashes or
// ids — each one has a false-positive check in the tests.
//
// The text these run over is a JSON-serialized line, so quotes arrive as `\"`
// and newlines as the two characters `\n`. Rules that look at context allow for
// that.

// Order matters where prefixes overlap: the more specific rule must run first,
// or the generic one claims the hit under the wrong name.
export const PATTERNS = [
  // Whole PEM private-key blocks, header to footer, so the base64 body goes too.
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g],
  // A header without its footer (truncated output, `head` of a key file): take
  // the header and the base64 run that follows it.
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[A-Za-z0-9+/=\s]|\\[nr])*/g],
  // An OpenSSH key body on its own: base64 of "openssh-key-v1".
  ['private-key', /b3BlbnNzaC1rZXktdjE[A-Za-z0-9+/=]*/g],

  ['hf-jwt', /\bhf_jwt_[A-Za-z0-9_.-]{20,}/g],
  ['hf-token', /\bhf_[A-Za-z0-9]{20,}\b/g],
  // Signed Hub/CDN URLs carry a bearer credential in the query string.
  ['signed-url', /[?&]__sign=[A-Za-z0-9_.%-]+/g],

  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai-key', /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g],
  ['openai-key', /\bsk-[A-Za-z0-9]{32,}\b/g],

  ['github-token', /\bgithub_pat_[A-Za-z0-9_]{22,}/g],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],

  // Access key ids only: AKIA (long-term) and ASIA (temporary). The other
  // four-letter prefixes (AIDA user, AGPA group, AROA role, AIPA instance
  // profile, ANPA/ANVA policy, …) are plain identifiers that fill ordinary AWS
  // output, and every hit here blocks a share.
  ['aws-key-id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  // Secret keys are 40 chars of base64 with no prefix, so only take one that is
  // labelled as such (`aws_secret_access_key = …`, `"SecretAccessKey": "…"`).
  // The label is kept; only the value is replaced.
  ['aws-secret-key', /((?:aws_?)?secret_?access_?key)([\s'"\\:=]{1,8})([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gi],

  ['slack-token', /\bxox[abposre]-\d+-[0-9A-Za-z-]{8,}/g],
  // App-level tokens: xapp-<n>-<app id>-<n>-<hex>.
  ['slack-token', /\bxapp-\d+-[A-Za-z0-9]+-\d+-[A-Za-z0-9]{16,}/g],
  ['stripe-key', /\b[sr]k_live_[0-9A-Za-z]{16,}/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['google-key', /\bAIza[0-9A-Za-z_-]{35}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],

  // PII: a shared trace should not carry personal addresses. Deliberately broad;
  // every hit is counted so the operator can see what tripped. Not a secret rule.
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
];

export const RULE_NAMES = [...new Set(PATTERNS.map(([r]) => r))];

// Value rules: the ACTUAL secret values from the environment, so secrets that
// don't look like secrets are still caught.
export function envRules(env) {
  const out = [];
  for (const [k, v] of Object.entries(env)) {
    if (!/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(k)) continue;
    if (!v || v.length < 8) continue;
    out.push([`env:${k}`, v]);
  }
  return out;
}

/** A redact(text) bound to a hit counter. `hits` is filled in place. */
export function makeRedactor({ env = {}, hits = {} } = {}) {
  const values = envRules(env);
  const bump = (rule, n = 1) => { hits[rule] = (hits[rule] || 0) + n; };
  const redact = (text) => {
    let out = text;
    // Value rules first — an env secret may itself look like a pattern.
    for (const [rule, value] of values) {
      if (!out.includes(value)) continue;
      bump(rule, out.split(value).length - 1);
      out = out.split(value).join(`«redacted:${rule}»`);
    }
    for (const [rule, re] of PATTERNS) {
      out = out.replace(re, (...m) => {
        bump(rule, 1);
        // aws-secret-key keeps its label and separator.
        return rule === 'aws-secret-key' ? `${m[1]}${m[2]}«redacted:${rule}»` : `«redacted:${rule}»`;
      });
    }
    return out;
  };
  return { redact, bump, hits, rules: RULE_NAMES.concat(values.map(([r]) => r)) };
}
