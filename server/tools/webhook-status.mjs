import fs from 'node:fs';
import path from 'node:path';
if(process.argv.length!==3)throw new Error('Usage: node webhook-status.mjs DATA_DIR/webhook-events');
const dir=process.argv[2];
for(const name of fs.readdirSync(dir).filter(n=>/^[a-f0-9]{64}\.json$/.test(n))) {
  const j=JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
  console.log(JSON.stringify({source:j.sourceId,eventId:j.event.id,requestId:j.requestId,state:j.state,reason:j.reason,createdAt:j.createdAt,updatedAt:j.updatedAt}));
}
