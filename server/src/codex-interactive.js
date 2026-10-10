// Only this explicit client can send input. The Settings observer stays read-only.
import { randomUUID } from 'node:crypto';
import { ObservationClient } from './codex-shared.js';

export class CodexInteractiveClient extends ObservationClient {
  allows(method, params) {
    return super.allows(method, params)
      || (method === 'thread/resume' && params?.threadId === this.threadId && params.excludeTurns === true && Object.keys(params).length === 2)
      || (method === 'turn/interrupt' && params?.threadId === this.threadId && typeof params.turnId === 'string' && !!params.turnId && Object.keys(params).length === 2)
      || (method === 'turn/start' && params?.threadId === this.threadId && Object.keys(params).every(k => ['threadId', 'input', 'clientUserMessageId'].includes(k)))
      || (method === 'thread/turns/list' && params?.threadId === this.threadId && params.limit === 1 && params.itemsView === 'full');
  }
  async hydrate() {
    const version=this.eventVersion||0;
    const page=await this.call('thread/turns/list',{threadId:this.threadId,limit:1,itemsView:'full',sortDirection:'desc'});
    // A snapshot may race events. Seed only missing items, never overwrite a delta.
    for(const t of (page.data||[]).filter(t=>t.status==='inProgress')) {
      if((this.eventVersion||0)!==version && this.turnId && this.turnId!==t.id)continue;
      const turn=this.turn(t.id);this.turnId=t.id;if(t.startedAt)turn.ts=t.startedAt*1000;
      for(const i of t.items||[])if(!turn.items.has(i.id)){if(turn.items.size>=100){turn.incomplete=true;break;}turn.items.set(i.id,i);}
      this.items=turn.items;
    }
  }
  turn(id) {
    this.liveTurns??=new Map();
    if(!this.liveTurns.has(id)) {if(this.liveTurns.size>=8)this.liveTurns.delete(this.liveTurns.keys().next().value);this.liveTurns.set(id,{items:new Map(),ts:Date.now(),done:false});}
    return this.liveTurns.get(id);
  }
  receiveServerMessage(msg) {
    const p = msg.params;
    if (!p || p.threadId !== this.threadId) return; // never act on another task
    this.eventVersion=(this.eventVersion||0)+1;
    this.requests ??= new Map(); this.items ??= new Map();
    const nativeId=p.turnId||p.turn?.id;
    if(nativeId){this.items=this.turn(nativeId).items;this.turnId=nativeId;}
    const itemId=p.itemId||p.item?.id;
    if(msg.id===undefined&&itemId&&!this.items.has(itemId)&&this.items.size>=100){if(nativeId)this.turn(nativeId).incomplete=true;return;}
    if (msg.id !== undefined) {
      if (this.requests.size >= 32) return; // no implicit decision on overflow
      if (![...this.requests.values()].some(r => r.rpcId === msg.id)) {
        const key = randomUUID(); this.requests.set(key, { key, rpcId: msg.id, method: msg.method, params: p });
      }
    } else if (msg.method === 'serverRequest/resolved') {
      for (const [key, r] of this.requests) if (r.rpcId === p.requestId) this.requests.delete(key);
    } else if (msg.method === 'thread/status/changed') this.status = p.status;
    else if (msg.method === 'turn/started') { this.turnError = null; this.turnId = p.turn?.id; this.status = { type: 'active', activeFlags: [] }; }
    else if (msg.method === 'turn/completed') {
      if(nativeId)this.turn(nativeId).done=true;
      this.status = { type: 'idle' }; this.turnError = p.turn?.error ? 'This turn failed. See its transcript for details.' : null;
      for (const [key, r] of this.requests) if (r.params.turnId === p.turn?.id) this.requests.delete(key);
    } else if ((msg.method === 'item/started' || msg.method === 'item/completed') && p.item?.id) {
      this.items.set(p.item.id, p.item);
    } else if (msg.method === 'item/agentMessage/delta' && typeof p.delta === 'string') {
      const previous = this.items.get(p.itemId);
      this.items.set(p.itemId, { id: p.itemId, type: 'agentMessage', text: ((previous?.text || '') + p.delta).slice(-100000) });
    } else if (['item/reasoning/summaryTextDelta','item/reasoning/textDelta'].includes(msg.method) && typeof p.delta==='string') {
      const previous=this.items.get(p.itemId)||{id:p.itemId,type:'reasoning',summary:[],content:[]};
      const field=msg.method.includes('summary')?'summary':'content',index=p.summaryIndex??p.contentIndex??0;
      if(index<0||index>100)return;
      const parts=[...(previous[field]||[])];parts[index]=((parts[index]||'')+p.delta).slice(0,100000);
      this.items.set(p.itemId,{...previous,[field]:parts});
    } else if (['item/commandExecution/outputDelta','item/fileChange/outputDelta'].includes(msg.method) && typeof p.delta==='string') {
      const previous=this.items.get(p.itemId);if(previous)this.items.set(p.itemId,{...previous,aggregatedOutput:((previous.aggregatedOutput||'')+p.delta).slice(-100000)});
    }
  }
  requestView() {
    return [...(this.requests?.values() || [])].map(({ key, method, params }) => ({ key, method, params,
      item: this.liveTurns?.get(params.turnId)?.items.get(params.itemId) || this.items?.get(params.itemId) || null }));
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
