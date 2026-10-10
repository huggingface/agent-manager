import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from './api-errors.js';
import { DATA_DIR } from './config.js';
import { codexBindings, configuredEndpoint, contextForThread } from './codex-context.js';
import { ObservationClient, taskStatus } from './codex-shared.js';
import { sharedCodexRollout } from './codex-reader.js';
import { recoveryPlan, verifyRecovered } from './codex-recovery.js';
import { CodexInteractiveClient } from './codex-interactive.js';

const fail = (code, message) => new ApiError(409, code, message);
const digest = text => createHash('sha256').update(text).digest('hex');
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
const uncertain = () => fail('codex-send-uncertain', 'Delivery is uncertain. Refresh the conversation before retrying; this message will not be sent twice.');

export class CodexInput {
  constructor({ getSession, listSessions, bindings = codexBindings, endpoint = configuredEndpoint,
    connect = (...args) => CodexInteractiveClient.connect(...args), observe = (...args) => ObservationClient.connect(...args),
    receipts = path.join(DATA_DIR, 'codex-input-receipts'), enabled = () => process.env.AM_CODEX_BINDINGS_PILOT === '1',
    assertWritable = () => {}, } = {}) {
    Object.assign(this, { getSession, listSessions, bindings, endpoint, connect, observe, receipts, enabled, assertWritable });
    this.clients = new Map(); this.busy = new Set(); this.attaching = new Map(); this.reconnecting = new Set();
  }
  context(id, { allowArchived = false } = {}) {
    if (!this.enabled()) throw fail('codex-pilot-disabled', 'Shared Reader input is disabled.');
    const s = this.getSession(id), binding = this.bindings.forSession(id), endpoint = this.endpoint();
    if (!s || (!allowArchived && s.archivedAt) || !binding) throw fail('codex-unmapped', 'This session has no active shared Codex binding.');
    const context = contextForThread(binding.threadId, { sessions: this.listSessions(), bindings: this.bindings, endpoint });
    if (context.amSessionId !== id) throw fail('codex-binding-stale', 'The shared binding changed.');
    return { ...context, endpoint, stamp: JSON.stringify([s.sessionUuid, binding.endpointId, binding.threadId, binding.revision, binding.cwd]) };
  }
  check(id, context, options) {
    if (this.context(id, options).stamp !== context.stamp) throw fail('codex-binding-stale', 'The shared binding changed.');
  }
  async metadata(client, context) {
    if (client.endpoint.socket !== context.endpoint.socket || client.endpoint.home !== context.endpoint.home) throw fail('codex-endpoint-changed', 'The Codex server changed.');
    const { thread } = await client.call('thread/read', { threadId: context.threadId, includeTurns: false });
    if (thread?.id !== context.threadId || thread.parentThreadId || fs.realpathSync(thread.cwd) !== context.workdir) throw fail('codex-thread-mismatch', 'The server returned a different conversation.');
    return thread;
  }
  existing(id, context) {
    const entry = this.clients.get(id);
    if (entry && (entry.stamp !== context.stamp || entry.client.closed)) { entry.client.close(); this.clients.delete(id); return null; }
    return entry?.client;
  }
  async status(id) {
    const context = this.context(id, { allowArchived: true }); let client = this.existing(id, context), temporary = false;
    try {
      if (!client) { client = await this.observe(context.endpoint); temporary = true; }
      const thread = await this.metadata(client, context);
      const latestTurn = await this.latestTurn(client, context);
      const activeTurnId = thread.status?.type === 'active' && latestTurn?.status === 'inProgress' ? latestTurn.id : null;
      let recoveryKey=null, recoveryError=null;
      if(thread.status?.type==='notLoaded' && !this.getSession(id).archivedAt) {
        try { recoveryKey=(await this.recovery(id,context,thread,latestTurn)).key; }
        catch { recoveryError='Saved settings require review in Codex Terminal or Remote before reopening this task.'; }
      }
      this.check(id, context, { allowArchived: true });
      return { activeTurnId, recoveryKey, recoveryError, lastTurnStatus:latestTurn?.status || null, connected: !temporary, status: client.requests?.size ? 'needs-input' : taskStatus(thread.status), requests: temporary ? [] : client.requestView(),
        liveText: temporary ? '' : [...(client.items?.values() || [])].filter(i => i.type === 'agentMessage').slice(-1)[0]?.text || '',
        turnError: client.turnError || null };
    } finally { if (temporary) client?.close(); }
  }
  async activeTurn(client, context, thread) {
    if (thread.status?.type !== 'active') return null;
    const turn = await this.latestTurn(client, context);
    return turn?.status === 'inProgress' && typeof turn.id === 'string' ? turn.id : null;
  }
  async latestTurn(client, context) {
    const page = await client.call('thread/turns/list', {
      threadId: context.threadId, limit: 1, itemsView: 'summary', sortDirection: 'desc',
    });
    return page?.data?.[0] || null;
  }
  async recovery(id,context,thread,latestTurn) {
    const file=await sharedCodexRollout(this.getSession(id),{bindings:this.bindings,config:context.endpoint});
    return recoveryPlan(file,context,thread,latestTurn);
  }
  async reconnect(id,{recoveryKey},{signal}={}) {
    if(typeof recoveryKey!=='string'||!/^[a-f0-9]{64}$/.test(recoveryKey))throw new ApiError(400,'invalid-input','A current recovery key is required.');
    if(this.attaching.has(id)||this.busy.has(id))throw fail('codex-recovery-busy','The task is already connecting. Refresh before trying again.');
    this.busy.add(id); this.reconnecting.add(id);
    let client;
    try {
      const context=this.context(id);
      client=await this.connect(context.endpoint);client.threadId=context.threadId;
      const thread=await this.metadata(client,context);
      if(thread.status?.type!=='notLoaded')throw fail('codex-recovery-stale','The task changed or is already loaded. Refresh before continuing.');
      const plan=await this.recovery(id,context,thread,await this.latestTurn(client,context));
      if(plan.key!==recoveryKey)throw fail('codex-recovery-stale','The saved task changed. Refresh before continuing.');
      this.check(id,context);this.assertWritable();
      if(signal?.aborted)throw fail('codex-recovery-cancelled','The task was not reopened.');
      const params={threadId:context.threadId,excludeTurns:true,...plan.settings.params};
      client.recoveryParams=params; // exact one-shot allowlist, never caller-supplied settings
      let resumed;
      try {resumed=await client.call('thread/resume',params);}
      catch {throw new ApiError(503,'codex-recovery-uncertain','Reconnection could not be confirmed. Refresh before trying again; no message was sent.');}
      finally {client.recoveryParams=null;}
      verifyRecovered(resumed,plan.settings,context.threadId);
      await client.hydrate();this.check(id,context);
      this.clients.get(id)?.client.close();this.clients.set(id,{client,stamp:context.stamp});client=null;
      return {ok:true,reconnected:true,threadId:context.threadId};
    } finally {client?.close();this.busy.delete(id);this.reconnecting.delete(id);}
  }
  async interrupt(id, { turnId }, { signal } = {}) {
    if (typeof turnId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(turnId)) {
      throw new ApiError(400, 'invalid-input', 'An exact turnId is required.');
    }
    const { client, context } = await this.attach(id);
    const thread = await this.metadata(client, context);
    if (await this.activeTurn(client, context, thread) !== turnId) {
      throw fail('codex-turn-stale', 'That turn is no longer active. Refresh before interrupting.');
    }
    this.check(id, context); this.assertWritable();
    if (signal?.aborted) throw fail('codex-interrupt-cancelled', 'The interruption was not submitted.');
    try {
      // The daemon checks this exact turn ID atomically. Never substitute a
      // newer ID if the turn changes between verification and this request.
      await client.call('turn/interrupt', { threadId: context.threadId, turnId });
    } catch (error) {
      if (error.code === 'rpc-error') throw fail('codex-interrupt-rejected', 'The server refused this interruption. Refresh the task.');
      throw new ApiError(503, 'codex-interrupt-uncertain', 'The interruption could not be confirmed. Refresh the task before trying again.');
    }
    return { ok: true, requested: true, turnId };
  }
  async attach(id) {
    if(this.reconnecting.has(id))throw fail('codex-recovery-busy','The task is reconnecting. Refresh shortly.');
    if (this.attaching.has(id)) return this.attaching.get(id);
    const pending = this.attachInner(id); this.attaching.set(id, pending);
    try { return await pending; } finally { this.attaching.delete(id); }
  }
  async attachInner(id) {
    const context = this.context(id); let client = this.existing(id, context);
    if (client) return { client, context };
    // No implicit task loading or daemon boot. Attach is a subscription to a
    // verified existing task, with zero settings overrides.
    if (this.clients.size >= 50) throw fail('codex-client-limit', 'Too many connected Reader sessions.');
    client = await this.connect(context.endpoint);
    try {
      client.threadId = context.threadId;
      const thread = await this.metadata(client, context);
      if (!['idle', 'active'].includes(thread.status?.type) || thread.canAcceptDirectInput !== true) throw fail('codex-not-loaded', 'This task is saved but not loaded. Use Reconnect task after reviewing its last turn.');
      this.check(id, context); this.assertWritable();
      const resumed = await client.call('thread/resume', { threadId: context.threadId, excludeTurns: true });
      if (resumed?.thread?.id !== context.threadId) throw fail('codex-thread-mismatch', 'The server returned a different conversation.');
      if(client.hydrate)await client.hydrate();
      this.check(id, context);
      this.clients.set(id, { client, stamp: context.stamp });
      return { client, context };
    } catch (e) { client.close(); throw e; }
  }
  receiptFile(requestId) { return path.join(this.receipts, requestId + '.json'); }
  readReceipt(requestId) {
    let fd;
    try { fd = fs.openSync(this.receiptFile(requestId), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      if (fs.fstatSync(fd).size > 8192) throw uncertain(); return JSON.parse(fs.readFileSync(fd, 'utf8'));
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  saveReceipt(requestId, record, first = false) {
    fs.mkdirSync(this.receipts, { recursive: true, mode: 0o700 });
    const dest = this.receiptFile(requestId), file = first ? dest : dest + '.' + randomUUID() + '.tmp';
    let fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      if (!first) fs.renameSync(file, dest);
      fd = fs.openSync(this.receipts, 'r'); fs.fsyncSync(fd);
    } finally { if (fd !== undefined) fs.closeSync(fd); if (!first) { try { fs.unlinkSync(file); } catch {} } }
  }
  async send(id, { text, requestId, attachments = [] }, { signal } = {}) {
    if (!uuid(requestId) || typeof text !== 'string' || (!text.trim() && !attachments.length) || text.length > 50000) throw new ApiError(400, 'invalid-input', 'A message and unique requestId are required.');
    if (this.busy.has(id)) throw fail('codex-send-busy', 'A message is already being submitted. Your draft is safe.');
    this.busy.add(id);
    try {
      const context = this.context(id), hash = digest(attachments.length ? JSON.stringify([text,attachments.map(a=>[a.id,a.path,a.kind])]) : text), existing = this.readReceipt(requestId);
      if (existing) {
        if (existing.session !== id || existing.stamp !== context.stamp || existing.hash !== hash) throw fail('codex-request-conflict', 'This message ID was used for different content.');
        if (existing.status === 'accepted') return { ok: true, turnId: existing.turnId, repeated: true };
        throw uncertain(); // persisted before sending; never replay after an ambiguous failure
      }
      const { client } = await this.attach(id);
      const thread = await this.metadata(client, context);
      if (thread.status?.type !== 'idle' || client.requests?.size) throw fail('codex-task-busy', 'Codex is working or waiting for an answer. Wait for it to finish; your draft is safe.');
      this.check(id, context); this.assertWritable();
      if (signal?.aborted) throw fail('codex-send-cancelled', 'The message was not submitted.');
      const receipt = { session: id, stamp: context.stamp, hash, status: 'sending', at: new Date().toISOString() };
      this.saveReceipt(requestId, receipt, true);
      // From this point, disconnects/timeout/restarts must never cause a retry.
      try {
        const result = await client.call('turn/start', { threadId: context.threadId,
          input: [...(text ? [{ type: 'text', text, text_elements: [] }] : []), ...attachments.filter(a=>a.kind==='image').map(a=>({type:'localImage',path:a.path}))], clientUserMessageId: requestId });
        if (!result?.turn?.id) throw uncertain();
        this.saveReceipt(requestId, { ...receipt, status: 'accepted', turnId: result.turn.id });
        return { ok: true, turnId: result.turn.id };
      } catch { throw uncertain(); }
    } finally { this.busy.delete(id); }
  }
  async answer(id, { key, decision, answers }) {
    const context = this.context(id), client = this.existing(id, context), request = client?.requests?.get(key);
    if (!request) throw fail('codex-request-stale', 'This request was already answered or the connection changed. Refresh.');
    const p = request.params; let response;
    if (request.method === 'item/commandExecution/requestApproval') {
      const allowed = (p.availableDecisions || ['accept', 'decline']).filter(v => ['accept', 'decline'].includes(v));
      if (!allowed.includes(decision)) throw new ApiError(400, 'invalid-input', 'Choose one of the offered one-time decisions.');
      response = { decision };
    } else if (request.method === 'item/fileChange/requestApproval') {
      if (!['accept', 'decline'].includes(decision) || (decision === 'accept' && (p.grantRoot || !client.items?.get(p.itemId)?.changes))) throw new ApiError(400, 'invalid-input', 'Review this change in Terminal or decline it.');
      response = { decision };
    } else if (request.method === 'item/permissions/requestApproval') {
      if (!['accept', 'decline'].includes(decision)) throw new ApiError(400, 'invalid-input', 'Choose approve once or deny.');
      response = { permissions: decision === 'accept' ? p.permissions : {}, scope: 'turn' };
    } else if (request.method === 'item/tool/requestUserInput') {
      if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new ApiError(400, 'invalid-input', 'Answers are required.');
      const clean = Object.create(null);
      for (const q of p.questions || []) {
        const value = answers[q.id];
        if (typeof value !== 'string' || !value.trim() || value.length > 10000) throw new ApiError(400, 'invalid-input', 'Answer each question.');
        clean[q.id] = { answers: [value] };
      }
      response = { answers: clean };
    } else throw fail('codex-request-unsupported', 'Answer this request in Terminal or Codex Remote.');
    this.check(id, context); this.assertWritable();
    await client.answer(key, response); return { ok: true };
  }
}
