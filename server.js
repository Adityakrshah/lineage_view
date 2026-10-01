'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildLineage } = require('./src/lineage');
const { explain } = require('./src/explain');
const { readTriage, writeTriage, ValidationError } = require('./src/store');

const PORT = +process.env.PORT || 3000, HOST = '127.0.0.1';
const FIXTURE = path.resolve(process.env.FIXTURE_DIR || 'fixture');
const DATA = path.resolve(process.env.DATA_DIR || 'data');
class DataError extends Error {}

function readFile(name, optional) {
  try { return fs.readFileSync(path.join(FIXTURE, name), 'utf8'); }
  catch (e) { if (optional && e.code === 'ENOENT') return null; throw new DataError(`${name}: ${e.code === 'ENOENT' ? `not found in ${FIXTURE}` : e.message}`); }
}
function readJson(name, optional) {
  const t = readFile(name, optional);
  if (t === null) return null;
  try { return JSON.parse(t); } catch (e) { throw new DataError(`${name}: invalid JSON (${e.message})`); }
}

// Ledger is re-read per request: it is small, and it is written by another process.
function load() {
  const ledger = readJson('signal-ledger.json');
  if (!Array.isArray(ledger?.signals)) throw new DataError('signal-ledger.json: "signals" is not an array');
  const config = readJson('config.json');
  if (!Array.isArray(config?.projects)) throw new DataError('config.json: "projects" is not an array');
  const hints = readJson('routing-hints.json', true) || [];
  const warnings = [];
  if (ledger.version !== 4) warnings.push(`ledger version is ${ledger.version}, this view was built for 4`);
  const runLog = [];
  (readFile('run-log.jsonl', true) || '').split('\n').filter(Boolean).forEach((line, i) => {
    try { runLog.push(JSON.parse(line)); } catch { warnings.push(`run-log.jsonl line ${i + 1} is not valid JSON and was skipped`); }
  });
  if (!runLog.length) warnings.push('run-log.jsonl is missing or empty: dangling-run and feed checks are weaker');
  const result = buildLineage({ ledger, config, hints, runLog });
  result.fleet.warnings = warnings;
  return result;
}

const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
function body(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', (c) => { n += c.length; if (n > 10_000) { reject(new ValidationError('body too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString() || 'null')); } catch { reject(new ValidationError('body is not valid JSON')); } });
  });
}
const sameOrigin = (req) => { const o = req.headers.origin; return !o || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o); };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }
    if (req.method === 'GET' && url.pathname === '/api/overview') {
      const { projects, fleet } = load();
      return send(res, 200, { projects, fleet, triage: readTriage(DATA).entries });
    }
    if (req.method === 'GET' && url.pathname === '/api/chains') {
      const project = url.searchParams.get('project');
      const { chains } = load();
      return send(res, 200, { chains: chains.filter((c) => c.project === project) });
    }
    if (req.method === 'POST' && ['/api/triage', '/api/explain'].includes(url.pathname)) {
      if (!sameOrigin(req) || req.headers['content-type']?.split(';')[0] !== 'application/json') return send(res, 403, { error: 'forbidden', detail: 'same-origin JSON requests only' });
      const b = await body(req);
      const { chains } = load();
      if (url.pathname === '/api/triage') return send(res, 200, await writeTriage(DATA, chains, b));
      const chain = chains.find((c) => c.key === b?.key), issue = chain?.issues.find((i) => i.kind === b?.kind);
      if (!issue) throw new ValidationError('unknown chain or issue');
      return send(res, 200, await explain(chain, issue));
    }
    send(res, 404, { error: 'not_found' });
  } catch (e) {
    if (e instanceof ValidationError) return send(res, 400, { error: 'invalid', detail: e.message });
    if (e instanceof DataError) return send(res, 503, { error: 'data_unreadable', detail: e.message });
    console.error(e);
    send(res, 500, { error: 'internal', detail: e.message.startsWith('data/triage') ? e.message : 'unexpected server error' });
  }
});

if (require.main === module) server.listen(PORT, HOST, () => console.log(`Lineage view: http://${HOST}:${PORT}  (fixture: ${FIXTURE})`));
module.exports = { server, load };
