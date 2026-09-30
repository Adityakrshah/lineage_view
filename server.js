const http = require('http');
const fs = require('fs');
const path = require('path');
const { analyzeLineage } = require('./src/lineage');
const { explainIssue } = require('./src/explain');
const { loadTriage, saveTriageEntry } = require('./src/store');

const PORT = process.env.PORT || 3000;
const FIXTURE_DIR = process.env.FIXTURE_DIR || path.join(__dirname, 'fixture');

function loadFixtureFiles() {
  try {
    const ledgerPath = path.join(FIXTURE_DIR, 'signal-ledger.json');
    const configPath = path.join(FIXTURE_DIR, 'config.json');
    const hintsPath = path.join(FIXTURE_DIR, 'routing-hints.json');
    const logPath = path.join(FIXTURE_DIR, 'run-log.jsonl');

    if (!fs.existsSync(ledgerPath)) throw new Error("signal-ledger.json missing");
    
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : { projects: [] };
    const routingHints = fs.existsSync(hintsPath) ? JSON.parse(fs.readFileSync(hintsPath, 'utf8')) : [];
    
    let runLog = [];
    if (fs.existsSync(logPath)) {
      runLog = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    }
    return { ledger, config, routingHints, runLog };
  } catch (err) {
    throw new Error(`Data unreadable: ${err.message}`);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (origin && new URL(origin).host !== host) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: Same-origin check failed' }));
      return;
    }
  }

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const htmlPath = path.join(__dirname, 'public', 'index.html');
      if (!fs.existsSync(htmlPath)) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end("UI index.html not built yet.");
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(htmlPath));
    } 
    else if (req.method === 'GET' && url.pathname === '/api/overview') {
      const { ledger, config, routingHints, runLog } = loadFixtureFiles();
      const { chains, fleet } = analyzeLineage(ledger, config, routingHints, runLog);
      
      const projectMap = {};
      for (const p of config.projects || []) {
        projectMap[p.id] = { id: p.id, brokenCount: 0, totalCount: 0 };
      }
      projectMap["internal_unsorted"] = { id: "internal_unsorted", brokenCount: 0, totalCount: 0 };

      for (const c of chains) {
        if (!projectMap[c.project]) projectMap[c.project] = { id: c.project, brokenCount: 0, totalCount: 0 };
        projectMap[c.project].totalCount++;
        if (c.health === 'broken' || c.health === 'gap') projectMap[c.project].brokenCount++;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ projects: Object.values(projectMap), fleet, triage: loadTriage() }));
    }
    else if (req.method === 'GET' && url.pathname === '/api/chains') {
      const proj = url.searchParams.get('project');
      const { ledger, config, routingHints, runLog } = loadFixtureFiles();
      const { chains } = analyzeLineage(ledger, config, routingHints, runLog);
      const filtered = proj ? chains.filter(c => c.project === proj) : chains;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ chains: filtered }));
    }
    else if (req.method === 'POST' && url.pathname === '/api/explain') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const explanation = await explainIssue(data.key, data.kind, data.message, data.facts);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(explanation));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    }
    else if (req.method === 'POST' && url.pathname === '/api/triage') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          if (body.length > 10240) throw new Error("Payload too large");
          const data = JSON.parse(body);
          const saved = saveTriageEntry(data);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, entry: saved }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    }
    else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  } catch (err) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'data_unreadable', details: err.message }));
  }
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Lineage View server running at http://127.0.0.1:${PORT}`);
  });
}

module.exports = server;
