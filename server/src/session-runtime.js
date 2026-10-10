// Select execution behind AM's existing HTTP contracts. Views never select a
// transport; bindings remain the only authority for choosing the shared task.
import { liveView, requestView } from './codex-view.js';
export class SessionRuntime {
  constructor({codex,bindings}) {this.codex=codex;this.bindings=bindings;this.states=new Map();this.checks=new Map();}
  shared(session) {return session.cli==='codex'&&!!(session.codexSharedOnly||this.bindings.forSession(session.id));}
  async refresh(session) {
    if(!this.shared(session))return null;
    if(this.checks.has(session.id))return this.checks.get(session.id);
    const pending=this.codex.status(session.id).then(status=>{this.states.set(session.id,{...status,at:Date.now()});return status;})
      .catch(()=>{const status={status:'unknown',at:Date.now()};this.states.set(session.id,status);return status;})
      .finally(()=>this.checks.delete(session.id));
    this.checks.set(session.id,pending);return pending;
  }
  presentation(session) {
    if(!this.shared(session))return null;
    const current=this.states.get(session.id);
    if(!current||Date.now()-current.at>3000)void this.refresh(session);
    const status=current?.status||'unknown';
    return {recoveryKey:session.archivedAt ? null : current?.recoveryKey || null, interruptTurnId:session.archivedAt ? null : current?.activeTurnId || null, state:status==='working'?'working':['idle','needs-input'].includes(status)?'waiting':'stopped',
      running:['idle','working','needs-input'].includes(status),
      inputRequired:status==='needs-input'?{kind:'permission',cli:'codex',confidence:'high',detectedAt:new Date(current.at).toISOString()}:null};
  }
  async trace(session,page,{interactive=true}={}) {
    if(!this.shared(session)||!interactive)return page;
    if (session.archivedAt) {
      const state = await this.refresh(session);
      return {...page, activity:state.status === 'working' ? 'working' : null,
        live:{replaceTurnIds:[],turns:[]}, interaction:{canSend:false,requests:[],error:null}};
    }
    let client,problem=null;
    try {({client}=await this.codex.attach(session.id));}
    catch(e){problem=e.message;}
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
