'use strict';
// The ONLY write path. Writes triage decisions to data/triage.json, never to the ledger.
// Validate -> serialise -> temp file + fsync + rename (atomic) -> history lives in the same file,
// so state and audit trail can never disagree after a crash.
const fs = require('fs');
const path = require('path');

const ACTIONS = ['acknowledged', 'wont_fix', 'reopened'];
class ValidationError extends Error {}
let queue = Promise.resolve();

function readTriage(dir) {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(dir, 'triage.json'), 'utf8'));
    if (t && typeof t.entries === 'object') return t;
    throw new Error('bad shape');
  } catch (e) {
    if (e.code === 'ENOENT') return { version: 1, entries: {} };
    throw new Error(`data/triage.json is unreadable (${e.message}); fix or remove it`);
  }
}

function validate(body, chains) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('body must be a JSON object');
  const { key, kind, action, note = '' } = body;
  if (typeof key !== 'string' || typeof kind !== 'string') throw new ValidationError('key and kind are required strings');
  if (!ACTIONS.includes(action)) throw new ValidationError(`action must be one of ${ACTIONS.join(', ')}`);
  if (typeof note !== 'string' || note.length > 500) throw new ValidationError('note must be a string of at most 500 characters');
  const chain = chains.find((c) => c.key === key);
  if (!chain) throw new ValidationError('unknown chain key');
  if (!chain.issues.some((i) => i.kind === kind)) throw new ValidationError('that chain has no issue of this kind');
  if ((action === 'wont_fix') && !note.trim()) throw new ValidationError('a note is required to mark something wont_fix');
  return { key, kind, action, note: note.trim() };
}

function writeTriage(dir, chains, body, now = () => new Date().toISOString()) {
  const v = validate(body, chains); // fail fast, before queueing
  const run = queue.then(() => {
    fs.mkdirSync(dir, { recursive: true });
    const cur = readTriage(dir);
    const id = `${v.key}|${v.kind}`;
    const prev = cur.entries[id];
    const at = now();
    cur.entries[id] = { action: v.action, note: v.note, at, history: [...(prev?.history || []), { action: v.action, note: v.note, at }] };
    const file = path.join(dir, 'triage.json'), tmp = file + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(cur, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    return { id, ...cur.entries[id] };
  });
  queue = run.catch(() => {});
  return run;
}

module.exports = { readTriage, writeTriage, ValidationError, ACTIONS };
