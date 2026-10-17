import {check} from './policy.js';

export function amAdapter({getSession,listRows,input,shared,isLocked}) {
  return {
    authorize:()=>check(!isLocked()),
    sourceExists:async id=>{const s=getSession(id);return !!s && !s.archivedAt && !isLocked();},
    roster:async c=>{
      check(!isLocked());
      const exported=new Map(c.permissions.export.map(x=>[x.id,x]));
      const rows=await listRows([...exported.keys()]);check(!isLocked());
      return rows.filter(r=>exported.has(r.id)).map(r=>({id:r.id,
        name:String(r.name || r.id).replace(/[\x00-\x1f\x7f]/g,' ').slice(0,50),cli:r.cli,
        state:['working','waiting','idle','stopped'].includes(r.state)?r.state:'unknown',
        lastActivityAt:r.lastActivityAt || null,summary:exported.get(r.id).summary,
        receives:!!shared(getSession(r.id)) && c.permissions.receive.some(x=>x.to===r.id)}));
    },
    deliver:async(m,context)=>{
      context.verify();check(!isLocked());
      const s=getSession(m.to);
      if(!s || s.archivedAt || !shared(s))return 'rejected';
      const stamp=s.sessionUuid;
      const state=await input.status(s.id);
      if(state.status!=='idle' || state.activeTurnId)return 'deferred';
      const source={federation:{instance:context.peer,sessionId:m.from,messageId:m.id,epoch:context.epoch}};
      const verify=()=>{
        context.verify();check(!isLocked());const current=getSession(m.to);
        check(current && !current.archivedAt && shared(current) && current.sessionUuid===stamp);
      };
      verify();context.beforeDispatch();
      await input.send(s.id,{text:`[message from federated agent; peer-attested identity ${JSON.stringify(source.federation)}]\n${m.text}`,
        requestId:context.requestId},{source,verifySource:verify});
      return 'accepted';
    },
  };
}
