import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { STATE_DIR } from './config.js';

// Web Push plumbing: one VAPID keypair per install (persisted on the bucket so
// subscriptions survive rebuilds), plus the list of subscribed devices.
// Notifications are AGENT-initiated only — sent when the operator explicitly
// asked an agent to notify them (documented in the generated environment skill).

const VAPID_FILE = path.join(STATE_DIR, 'vapid.json');
const SUBS_FILE = path.join(STATE_DIR, 'push-subscriptions.json');

let keys = null;
let subs = []; // [{ subscription, ua, createdAt }]

function persistSubs() {
  const tmp = `${SUBS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(subs, null, 2));
  fs.renameSync(tmp, SUBS_FILE);
}

export function initPush() {
  try { keys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')); } catch {}
  if (!keys || !keys.publicKey || !keys.privateKey) {
    keys = webpush.generateVAPIDKeys();
    try { fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2)); } catch {}
  }
  // VAPID subject: a contact URL for push services. The Space page is apt.
  const subject = process.env.SPACE_ID ? `https://huggingface.co/spaces/${process.env.SPACE_ID}` : 'mailto:agent-manager@localhost.invalid';
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  try {
    subs = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
    if (!Array.isArray(subs)) subs = [];
  } catch { subs = []; }
}

export function publicKey() { return keys.publicKey; }
export function deviceCount() { return subs.length; }

export function addSubscription(subscription, ua) {
  if (!subscription || typeof subscription.endpoint !== 'string') return false;
  subs = subs.filter((s) => s.subscription.endpoint !== subscription.endpoint);
  subs.push({ subscription, ua: String(ua || '').slice(0, 160), createdAt: new Date().toISOString() });
  persistSubs();
  return true;
}

export function removeSubscription(endpoint) {
  const before = subs.length;
  subs = subs.filter((s) => s.subscription.endpoint !== endpoint);
  if (subs.length !== before) persistSubs();
  return before !== subs.length;
}

/** Push {title, body, url} to every subscribed device; prunes dead endpoints. */
export async function sendToAll({ title, body, url }) {
  const payload = JSON.stringify({ title, body, url });
  let sent = 0;
  let failed = 0;
  const dead = new Set();
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(s.subscription, payload, { TTL: 3600 });
      sent++;
    } catch (e) {
      failed++;
      // 404/410 = the subscription is gone (app uninstalled, permission revoked)
      if (e && (e.statusCode === 404 || e.statusCode === 410)) dead.add(s.subscription.endpoint);
    }
  }));
  if (dead.size) {
    subs = subs.filter((s) => !dead.has(s.subscription.endpoint));
    persistSubs();
  }
  return { sent, failed, devices: subs.length };
}
