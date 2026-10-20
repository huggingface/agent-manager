import { codexLaunchBlock, bindingIfKnown } from './codex-launch-policy.js';
// Select execution behind AM's existing HTTP contracts. Views never select a
// transport; bindings remain the only authority for choosing the shared task.
import { liveView, requestView } from './codex-view.js';
export class SessionRuntime {
  constructor({codex,bindings}) {this.codex=codex;this.bindings=bindings;this.states=new Map();this.checks=new Map();}
  // Display only, so an unreadable bindings file answers "not shared" instead
  // of throwing: this is on the path of /api/tree and /api/sessions, and a
  // sidebar that cannot load is worse than a row missing a shared badge. The
  // launch path reads the file for itself and refuses there.
  shared(session) {return session.cli==='codex'&&!!(session.codexSharedOnly||bindingIfKnown(session,this.bindings));}
  async refresh(session) {
    if(!this.shared(session))return null;
    if(this.checks.has(session.id))return this.checks.get(session.id);
    const pending=this.codex.status(session.id).then(status=>{this.states.set(session.id,{...status,at:Date.now()});return status;})
      .catch(()=>{const status={status:'unknown',at:Date.now()};this.states.set(session.id,status);return status;})
      .finally(()=>this.checks.delete(session.id));
    this.checks.set(session.id,pending);return pending;
  }
  // Coordination must await a fresh native observation. An absent TUI or an
  // unavailable daemon is not evidence that a shared task has finished.
  async coordinationState(session) {
    if (!this.shared(session)) return null;
    const current = await this.refresh(session);
    return ({working:'working', idle:'waiting', 'needs-input':'waiting', unloaded:'stopped'})[current?.status] || 'unknown';
  }
  presentation(session) {
    // Same reason: the roster is built from this. A file we cannot read leaves
    // the row undecorated; attempting to launch still produces the refusal that
    // names the file.
    let block;
    try { block = codexLaunchBlock(session, this.bindings); } catch { return null; }
    if (block) return {codexMigrationRequired:block};
    if(!this.shared(session))return null;
    const current=this.states.get(session.id);
    if(!current||Date.now()-current.at>3000)void this.refresh(session);
    const status=current?.status||'unknown';
    return {recoveryKey:session.archivedAt ? null : current?.recoveryKey || null, interruptTurnId:session.archivedAt ? null : current?.activeTurnId || null, state:status==='working'?'working':['idle','needs-input'].includes(status)?'waiting':'stopped',
      running:['idle','working','needs-input'].includes(status),
      inputRequired:status==='needs-input'?{kind:'permission',cli:'codex',confidence:'high',detectedAt:new Date(current.at).toISOString()}:null};
  }
  async trace(session,page,{interactive=true}={}) {
    if (!interactive) return page;
    const block = codexLaunchBlock(session, this.bindings);
    if (block) return {...page, interaction:{canSend:false, requests:[], error:block.message}, codexMigrationRequired:block};
    if(!this.shared(session))return page;
    if (session.archivedAt) {
      const state = await this.refresh(session);
      return {...page, activity:state.status === 'working' ? 'working' : null,
        live:{replaceTurnIds:[],turns:[]}, interaction:{canSend:false,requests:[],error:null}};
    }
    let client,problem=null;
    try {({client}=await this.codex.attach(session.id));}
    catch(e){problem=e.message;}
    // Display catch-up is optional and uses its own bounded transport. Sending
    // input and receiving approvals never depend on downloading old tool output.
    if (client?.hydrate) await client.hydrate();
    const state=await this.refresh(session);
    const requests=client?requestView(client):[];
    if(client)for(const t of page.turns||[]) {
      if(t.nativeTurnId&&t.event?.type==='task-complete'&&client.liveTurns?.get(t.nativeTurnId)?.done) {
        // Native notifications are ordered on this connection. A persisted
        // completion also covers earlier completed turns, even if a new Reader
        // starts after their history pages. Do not resurrect those at the tail.
        for(const [id,turn] of client.liveTurns) {
          if(turn.done)client.liveTurns.delete(id);
          if(id===t.nativeTurnId)break;
        }
      }
    }
    const live=client&&!client.closed?liveView(client):{replaceTurnIds:[],turns:[]};
    const outcome={interrupted:'The last turn was interrupted; it did not complete. No message was resent.',failed:'The last turn failed. No message was resent.'}[state.lastTurnStatus];
    return {...page,activity:state.status==='working'?'working':['idle','needs-input'].includes(state.status)?'waiting':null,live,
      interaction:{canSend:state.status==='idle'&&!requests.length,requests,error:[outcome,state.recoveryError||problem||client?.turnError].filter(Boolean).join(' ')||null}};
  }
  async send(session,input,options) {
    const result=await this.codex.send(session.id,input,options);
    this.states.set(session.id,{status:'working',at:Date.now()});return result;
  }
}
