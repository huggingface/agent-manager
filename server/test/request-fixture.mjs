// Harmless transport fixture: exercise the production admission adapters ahead
// of parsing/state/upgrade, with counters in place of domain work or a PTY.
import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createRequestPolicy, requestAdmission, terminalUpgrade } from '../src/request-admission.js';

export async function requestFixture({ configure = () => {}, env = (port) => ({ PORT: String(port) }) } = {}) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const state = { parsed: 0, writes: 0, reads: 0, upgrades: 0, controls: 0, headers: [], bodies: [] };
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const policy = createRequestPolicy(env(port));
  app.use(requestAdmission(policy));
  app.use((req, _res, next) => { state.headers.push({ ...req.headers }); next(); });
  configure(app, state);
  app.use((req, _res, next) => { state.parsed++; next(); });
  app.use(express.raw({ type: () => true, limit: '20mb' }));
  app.get(['/api/remote/:name/stream', '/api/remote/:name/messages', '/api/update/check'], (_req, res) => {
    state.reads++; res.json({ messages: [], seq: 0 });
  });
  app.get('*', (_req, res) => res.json({ ok: true }));
  app.all('*', (req, res) => {
    state.writes++; state.bodies.push(Buffer.isBuffer(req.body) ? req.body.toString() : '');
    res.json({ ok: true, id: 'fixture' });
  });
  server.on('upgrade', terminalUpgrade(wss, policy));
  wss.on('connection', (ws) => {
    state.upgrades++;
    ws.send('fixture replay');
    ws.on('message', () => { state.controls++; ws.send('fixture acknowledgement'); });
  });
  return {
    app, server, state, port, origin: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
