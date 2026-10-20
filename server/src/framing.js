// Who may put this app in a frame. The app runs shell commands for whoever can
// click and type in it, so a page that frames it can steer those clicks and keys
// (clickjacking). Every response carries `Content-Security-Policy:
// frame-ancestors`, naming the app itself and — in a Space — the Hub page that
// embeds it. `X-Frame-Options` is deliberately absent: it cannot say "only
// huggingface.co", and SAMEORIGIN would break the Hub's own embed.
// See docs/browser-request-protection.md#framing.
import { normalizeOrigin } from './request-admission.js';

export const HUB_ORIGIN = 'https://huggingface.co';

// AM_FRAME_ANCESTORS: extra origins allowed to embed the app, comma-separated
// exact http(s) origins (no paths, wildcards, quotes or keywords). Same grammar
// as AM_ALLOWED_ORIGINS; anything else fails startup rather than widening, or
// injecting into, the policy.
function extraAncestors(value) {
  if (value === undefined || value.trim() === '') return [];
  const values = value.split(',').map((item) => normalizeOrigin(item.trim()));
  if (values.some((item) => !item)) throw new Error('AM_FRAME_ANCESTORS must contain exact http(s) origins without paths');
  return values;
}

// The origins (besides the app's own) allowed to frame it, in policy order.
export function frameAncestorOrigins(env = process.env) {
  const origins = new Set(env.SPACE_ID ? [HUB_ORIGIN] : []);
  for (const origin of extraAncestors(env.AM_FRAME_ANCESTORS)) origins.add(origin);
  return [...origins];
}

export const frameAncestorsDirective = (origins) => ['frame-ancestors', "'self'", ...origins].join(' ');

// Add the directive to an existing policy, or return it alone. A policy that
// already names its own frame-ancestors keeps it: that route chose deliberately.
export function mergeFrameAncestors(policy, directive) {
  if (policy === undefined || policy === null || policy === '') return directive;
  if (Array.isArray(policy)) {
    if (policy.some((p) => hasFrameAncestors(p))) return policy;
    return policy.length ? [mergeFrameAncestors(policy[0], directive), ...policy.slice(1)] : directive;
  }
  const text = String(policy);
  if (hasFrameAncestors(text)) return text;
  return `${text.replace(/[\s;]+$/, '')}; ${directive}`;
}

const hasFrameAncestors = (policy) => String(policy).split(';').some((d) => /^\s*frame-ancestors(?:\s|$)/i.test(d));

// Install first, before admission, so refusals, 404s, static files, the SPA
// page and error responses all carry it. The merge runs as headers are written,
// so a route that sets its own CSP later (sandboxed previews, Express's default
// 404 page) keeps its policy and gains the directive instead of losing it.
export function frameAncestors(origins) {
  const directive = frameAncestorsDirective(origins);
  return (_req, res, next) => {
    res.setHeader('Content-Security-Policy', directive);
    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
      // Headers handed straight to writeHead bypass setHeader; merge those too.
      const headers = args.find((arg, i) => i > 0 && arg && typeof arg === 'object');
      const key = headers && !Array.isArray(headers) && Object.keys(headers).find((k) => k.toLowerCase() === 'content-security-policy');
      if (key) headers[key] = mergeFrameAncestors(headers[key], directive);
      else if (!res.headersSent) res.setHeader('Content-Security-Policy', mergeFrameAncestors(res.getHeader('Content-Security-Policy'), directive));
      return writeHead.apply(this, args);
    };
    next();
  };
}
