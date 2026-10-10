// Codex protocol -> AM presentation contracts. No protocol names reach the view.
const cap = value => { const text = typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2); return {text:text.slice(0,20000), ...(text.length>20000?{more:text.length-20000}:{})}; };
export function itemBlocks(item) {
  switch(item.type) {
    case 'userMessage': return (item.content||[]).flatMap(c => c.type==='text' ? [{type:'text',...cap(c.text)}] : c.type==='image' && /^data:image\//.test(c.url||'') ? [{type:'image',src:c.url}] : c.type==='localImage' ? [{type:'text',text:'[Image: '+c.path+']'}] : []);
    case 'agentMessage': return [{type:'text',...cap(item.text||'')}];
    case 'reasoning': return [...(item.summary||[]),...(item.content||[])].filter(Boolean).map(t=>({type:'thinking',...cap(t)}));
    case 'contextCompaction': return [{type:'compaction',text:'Context compacted'}];
    case 'plan': return [{type:'text',...cap(item.text||'')}];
    default: {
      const names={commandExecution:'exec_command',fileChange:'apply_patch',mcpToolCall:`${item.server}.${item.tool}`,dynamicToolCall:item.tool,webSearch:'web_search',imageView:'view_image',collabAgentToolCall:item.tool};
      if(!names[item.type])return [];
      const input=item.type==='commandExecution'?{command:item.command,cwd:item.cwd}:item.arguments??item.changes??item.action??item.query??item.path??item.prompt??{};
      const blocks=[{type:'tool_use',id:item.id,name:names[item.type],...cap(input)}];
      const result=item.aggregatedOutput??item.result??item.error??item.agentsStates;
      if(result!=null)blocks.push({type:'tool_result',id:item.id,...cap(result),failed:item.status==='failed'||!!item.error});
      return blocks;
    }
  }
}
export function liveView(client) {
  const turns=[];const replaceTurnIds=[];
  for(const [turnId,turn] of client.liveTurns||[]) {
    if(!turn.items.size||turn.incomplete)continue;
    replaceTurnIds.push(turnId);
    for(const item of turn.items.values()) {
      const blocks=itemBlocks(item);if(!blocks.length)continue;
      turns.push({id:'live:'+turnId+':'+item.id,nativeTurnId:turnId,role:item.type==='userMessage'?'user':'assistant',
        ts:turn.ts,blocks,...(item.type==='agentMessage'&&item.phase==='final_answer'?{kind:'final'}:{})});
    }
    if(turn.done) {
      const last=turns.filter(t=>t.nativeTurnId===turnId&&t.role==='assistant'&&t.blocks.some(b=>b.type==='text')).at(-1);
      if(last)last.kind='final';
    }
  }
  return {replaceTurnIds,turns};
}
export function requestView(client) {
  return client.requestView().map(r=>{
    const p=r.params;let kind='confirmation',details='',choices=[],questions;
    if(r.method==='item/tool/requestUserInput') {kind='question';questions=(p.questions||[]).map(q=>({id:q.id,text:q.question,secret:!!q.isSecret,options:q.options||[]}));}
    else if(r.method==='item/commandExecution/requestApproval') {kind='permission';details=JSON.stringify({command:p.command,cwd:p.cwd,reason:p.reason,network:p.networkApprovalContext,permissions:p.additionalPermissions},null,2);choices=(p.availableDecisions||['accept','decline']).filter(x=>['accept','decline'].includes(x));}
    else if(r.method==='item/fileChange/requestApproval') {kind='permission';details=JSON.stringify({changes:r.item?.changes,reason:p.reason,grantRoot:p.grantRoot},null,2);choices=p.grantRoot||!r.item?.changes?['decline']:['accept','decline'];}
    else if(r.method==='item/permissions/requestApproval') {kind='permission';details=JSON.stringify({permissions:p.permissions,cwd:p.cwd,reason:p.reason},null,2);choices=['accept','decline'];}
    else details='This request needs to be reviewed in Terminal or Codex Remote.';
    return {key:r.key,kind,details,questions,choices:choices.map(value=>({value,label:value==='accept'?'Approve once':'Deny'})),terminalFallback:!questions&&!choices.includes('accept')};
  });
}
