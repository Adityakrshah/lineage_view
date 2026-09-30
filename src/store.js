const fs = require('fs');
const path = require('path');

const TRIAGE_FILE = path.join(__dirname, '..', 'data', 'triage.json');

function ensureDataDir() {
  const dir = path.dirname(TRIAGE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadTriage() {
  try {
    if (!fs.existsSync(TRIAGE_FILE)) return { entries: [] };
    return JSON.parse(fs.readFileSync(TRIAGE_FILE, 'utf8'));
  } catch (err) {
    return { entries: [] };
  }
}

function saveTriageEntry(payload) {
  if (!payload || typeof payload !== 'object') throw new Error("Invalid payload.");
  const { key, kind, action, note } = payload;
  if (!key || !kind || !action) throw new Error("Missing required fields.");
  if (!['acknowledged', 'wont_fix', 'reopened'].includes(action)) throw new Error(`Invalid action: ${action}`);
  if (action === 'wont_fix' && (!note || note.trim().length === 0)) throw new Error("Note required for wont_fix.");
  if (note && note.length > 500) throw new Error("Note exceeds 500 characters.");

  ensureDataDir();
  const db = loadTriage();
  db.entries.push({ key, kind, action, note: note || "", timestamp: new Date().toISOString() });

  const tempFile = `${TRIAGE_FILE}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const fd = fs.openSync(tempFile, 'w');
  fs.writeSync(fd, JSON.stringify(db, null, 2));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tempFile, TRIAGE_FILE);
  return db.entries[db.entries.length - 1];
}

module.exports = { loadTriage, saveTriageEntry };
