// Only this explicit client can send input. The Settings observer stays read-only.
import { randomUUID } from 'node:crypto';
import { ObservationClient } from './codex-shared.js';

export class CodexInteractiveClient extends ObservationClient {
  allows(method, params) {
    return super.allows(method, params)
      || (method === 'thread/resume' && params?.threadId === this.threadId && params.excludeTurns === true && Object.keys(params).length === 2)
      || (method === 'turn/start' && params?.threadId === this.threadId && Object.keys(params).every(k => ['threadId', 'input', 'clientUserMessageId'].includes(k)))
      || (method === 'thread/turns/list' && params?.threadId === this.threadId && params.limit === 20 && params.itemsView === 'full');
  }
  receiveServerMessage(msg) {
    const p = msg.params;
    if (!p || p.threadId !== this.threadId) return; // never act on another task
    this.requests ??= new Map(); this.items ??= new Map();
    if (msg.id !== undefined) {
      if (this.requests.size >= 32) return; // no implicit decision on overflow
      if (![...this.requests.values()].some(r => r.rpcId === msg.id)) {
        const key = randomUUID(); this.requests.set(key, { key, rpcId: msg.id, method: msg.method, params: p });
      }
    } else if (msg.method === 'serverRequest/resolved') {
      for (const [key, r] of this.requests) if (r.rpcId === p.requestId) this.requests.delete(key);
    } else if (msg.method === 'thread/status/changed') this.status = p.status;
    else if (msg.method === 'turn/started') { this.items.clear(); this.turnError = null; this.turnId = p.turn?.id; this.status = { type: 'active', activeFlags: [] }; }
    else if (msg.method === 'turn/completed') {
      this.status = { type: 'idle' }; this.turnError = p.turn?.error ? 'This turn failed. See its transcript for details.' : null;
      for (const [key, r] of this.requests) if (r.params.turnId === p.turn?.id) this.requests.delete(key);
    } else if ((msg.method === 'item/started' || msg.method === 'item/completed') && p.item?.id) {
      if (this.items.size >= 100) this.items.delete(this.items.keys().next().value);
      this.items.set(p.item.id, p.item);
    } else if (msg.method === 'item/agentMessage/delta' && typeof p.delta === 'string') {
      const previous = this.items.get(p.itemId);
      if (!previous && this.items.size >= 100) this.items.delete(this.items.keys().next().value);
      this.items.set(p.itemId, { id: p.itemId, type: 'agentMessage', text: ((previous?.text || '') + p.delta).slice(-100000) });
    }
  }
  requestView() {
    return [...(this.requests?.values() || [])].map(({ key, method, params }) => ({ key, method, params,
      item: this.items?.get(params.itemId) || null }));
  }
  async answer(key, response) {
    const request = this.requests?.get(key);
    if (!request || this.closed) throw new Error('stale-request');
    this.requests.delete(key);
    await new Promise((resolve, reject) => this.ws.send(JSON.stringify({ id: request.rpcId, result: response }), e => e ? reject(e) : resolve()));
    // Other clients can resolve it too. Removing locally also prevents double-clicks.
    this.requests.delete(key);
  }
}
