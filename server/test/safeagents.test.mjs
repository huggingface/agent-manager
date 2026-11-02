// The tool-call guard (src/safeagents.js): reading what the proxy says, and
// handing its address only to the launches it can actually guard.
//
// The parsing is the part that breaks quietly — a line it misreads is a call
// that never shows up on the Safety page — so it is checked against the exact
// format safeagents prints when its output is not a terminal. The live section
// runs the real proxy in front of a fake Anthropic server, when `safeagents` is
// installed, and is skipped (and says so) when it is not.
// Run with: node test/safeagents.test.mjs
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { freePort } from './free-port.mjs';
import { parseCallLine, readJournal, proxyArgs, createSafeAgents } from '../src/safeagents.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'safeagents-'));

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n          got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`}`);
};

console.log('\nreading the proxy\'s call lines');
check('a pass is all call, no reason',
  parseCallLine('17:53:21         PASS   Bash          ruff check src && pytest -q'),
  { time: '17:53:21', journalId: null, verdict: 'passed', tool: 'Bash', what: 'ruff check src && pytest -q', why: '' });
check('a block carries its journal id and reason',
  parseCallLine('17:53:21  #12    BLOCK  shell_exec    id && uname -a  undeclared tool'),
  { time: '17:53:21', journalId: 12, verdict: 'blocked', tool: 'shell_exec', what: 'id && uname -a', why: 'undeclared tool' });
check('two spaces inside a command stay in the command',
  parseCallLine('09:00:01  #3     WARN   Bash          echo  a  b  side_channel.x (judge allow)').what,
  'echo  a  b');
check('a tool name longer than its column still parses',
  parseCallLine('09:00:01  #4     FLAG   mcp__server__long_tool  {"q":1}  host `x.example`').tool,
  'mcp__server__long_tool');
check('a log message is not a call',
  parseCallLine('[safeagents] listening on http://127.0.0.1:8787 -> https://api.anthropic.com (block, atif-scan)'),
  null);

console.log('\nreading the journal');
const journal = path.join(TMP, 'calls.jsonl');
check('a missing journal is empty, not an error', readJournal(journal), []);
fs.writeFileSync(journal, [
  JSON.stringify({ id: 1, time: 1, verdict: 'flagged', tool: 'Bash' }),
  'not json',
  JSON.stringify({ id: 'two' }),
  JSON.stringify({ id: 2, time: 2, verdict: 'blocked', tool: 'WebFetch' }),
  '',
].join('\n'));
check('newest first, damaged lines skipped', readJournal(journal).map((e) => e.id), [2, 1]);
check('the limit keeps the newest', readJournal(journal, { limit: 1 }).map((e) => e.id), [2]);
check('a tail read drops the partial first line',
  readJournal(journal, { tailBytes: fs.statSync(journal).size - 5 }).map((e) => e.id), [2]);

console.log('\nthe proxy command line');
check('log-only unless blocking',
  proxyArgs({ upstream: 'https://api.anthropic.com', listen: '127.0.0.1:1', mode: 'log-only', journal: 'j' }),
  ['https://api.anthropic.com', '127.0.0.1:1', '--log-only', '--journal', 'j']);
check('a draining proxy never blocks',
  proxyArgs({ upstream: 'u', listen: 'l', mode: 'off', journal: 'j' }).includes('--log-only'), true);
check('blocking, with extra hosts',
  proxyArgs({ upstream: 'u', listen: 'l', mode: 'block', allowHosts: ['docs.rs', 'go.dev'], journal: 'j' }),
  ['u', 'l', '--allow-host', 'docs.rs', '--allow-host', 'go.dev', '--journal', 'j']);

console.log('\nwhich launches get the proxy');
{
  const guard = createSafeAgents({ dataDir: TMP, bin: path.join(TMP, 'no-such-safeagents'), port: await freePort() });
  check('off: nobody', guard.envFor({ id: 'a', cli: 'claude' }, 'r1'), {});
  await guard.configure({ mode: 'block' });
  check('a missing binary is reported, not crashed on', guard.status().state, 'unavailable');
  check('…and a launch is not pointed at a proxy nobody answers', guard.envFor({ id: 'a', cli: 'claude' }, 'r1'), {});
  await guard.shutdown();
}

let live = true;
try { execFileSync('safeagents', ['--help'], { stdio: 'ignore', timeout: 30_000 }); } catch { live = false; }
if (!live) {
  console.log('\nlive proxy: SKIPPED (safeagents is not on PATH)');
} else {
  console.log('\nlive proxy in front of a fake Anthropic server');
  // Answers every request with one tool call: the tool and input are whatever
  // the request's last user message asks for, so each test chooses its call.
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const ask = JSON.parse(JSON.parse(body).messages.at(-1).content);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_1', name: ask.tool, input: ask.input }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  const upstreamPort = await freePort();
  await new Promise((r) => upstream.listen(upstreamPort, '127.0.0.1', r));
  const running = new Set();
  const guard = createSafeAgents({
    dataDir: TMP, port: await freePort(), upstream: `http://127.0.0.1:${upstreamPort}`,
    isRunning: (id) => running.has(id),
  });
  await guard.configure({ mode: 'block' });
  check('it starts', guard.status().state, 'ready');
  running.add('s1');
  const env = guard.envFor({ id: 's1', cli: 'claude' }, 'r1');
  check('a Claude launch is pointed at it', env.ANTHROPIC_BASE_URL, guard.status().listen);
  check('a Codex launch is not', guard.envFor({ id: 's2', cli: 'codex' }, 'r2'), {});

  const send = async (tool, input) => {
    const r = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'fake', max_tokens: 10,
        tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: JSON.stringify({ tool, input }) }],
      }),
    });
    return r.json();
  };
  const ok = await send('Bash', { command: 'ls -la' });
  const blocked = await send('shell_exec', { command: 'id && uname -a' });
  check('a clean call reaches the agent', ok.content.map((c) => c.type), ['tool_use']);
  check('an undeclared tool is swapped for text', blocked.content.some((c) => c.type === 'tool_use'), false);
  // the call lines are written after the response; give the pipe a moment
  for (let i = 0; i < 50 && guard.recentCalls().length < 2; i++) await new Promise((r) => setTimeout(r, 100));
  check('both calls are on the live list, newest first',
    guard.recentCalls().map((c) => [c.verdict, c.tool]), [['blocked', 'shell_exec'], ['passed', 'Bash']]);
  const kept = guard.journal(10);
  check('only the blocked one is journaled, with its arguments',
    kept.map((e) => [e.verdict, e.tool, JSON.parse(e.arguments).command]), [['blocked', 'shell_exec', 'id && uname -a']]);
  check('the live line points at its journal entry', guard.recentCalls()[0].journalId, kept[0].id);

  await guard.configure({ mode: 'off' });
  check('off with a guarded session still running: it drains', guard.status().state, 'draining');
  check('…and new launches are not routed', guard.envFor({ id: 's3', cli: 'claude' }, 'r3'), {});
  running.delete('s1');
  await guard.configure({ mode: 'off' });
  check('once that session ends, it stops', [guard.status().state, guard.status().pid], ['off', null]);

  await guard.shutdown();
  upstream.close();
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
