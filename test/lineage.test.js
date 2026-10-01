'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { buildLineage, feedWindows } = require('../src/lineage');
const { writeTriage, readTriage, ValidationError } = require('../src/store');
const { explain, validate } = require('../src/explain');

const config = { projects: [{ id: 'quill', name: 'Quill' }, { id: 'atlas', name: 'Atlas' }], fallbacks: { unrouted: 'internal_unsorted' }, feed_freshness_threshold_days: 3 };
const runLog = Array.from({ length: 10 }, (_, i) => ({ run: 100 + i, started_at: `2026-07-${String(6 + i).padStart(2, '0')}T06:05:00Z`, status: i === 3 ? 'fail' : 'ok', error: i === 3 ? 'boom' : null, feeds: { granola: { last_file: '2026-07-06', files_seen: 0 } } }));
let n = 0;
const sig = (o = {}) => { n++; return { id: `2026-07-06_s${n}`, match_key: `s${n}`, type: 'meeting', date: '2026-07-06', time: '10:00', title: `Sig ${n}`, detected_on: '2026-07-07', attendees: [], projects: ['quill'], summary: null, notes: null, expected_files: [], status: {}, sources: { granola_note: 'g.md', transcript: null, recording: null }, ...o }; };
const analyzed = (o = {}) => ({ state: 'analyzed', analyzed_at: '2026-07-08', files_reviewed: ['g.md'], analysis_ref: 'run-54', ...o });
const run = (signals, hints = []) => buildLineage({ ledger: { version: 4, signals }, config, hints, runLog });
const kinds = (c) => c.issues.map((i) => i.kind);

test('fully written-back chain is healthy; gap sits at the exact link', () => {
  const [ok, gap] = run([sig({ summary: 's', notes: 'n', status: { quill: analyzed() } }), sig({ summary: 's', status: { quill: analyzed() } })]).chains;
  assert.equal(ok.health, 'healthy');
  assert.deepEqual(kinds(gap), ['artifact_missing']);
  assert.equal(gap.nodes.artifact.state, 'missing');
});

test('run beyond the newest logged run is dangling; earlier unlogged runs are only "unverifiable"', () => {
  const r = run([sig({ summary: 's', notes: 'n', status: { quill: analyzed({ analysis_ref: 'run-999' }) } }), sig({ summary: 's', notes: 'n', status: { quill: analyzed({ analysis_ref: 'run-54' }) } })]);
  assert.ok(kinds(r.chains[0]).includes('analysis_ref_dangling'));
  assert.equal(r.chains[0].nodes.summary.state, 'blocked');
  assert.equal(r.chains[1].health, 'healthy');
  assert.equal(r.fleet.unverifiableRefs, 1);
});

test('analysis citing a file the signal does not have is an error', () => {
  const c = run([sig({ sources: { granola_note: null, transcript: null, recording: null }, status: { quill: analyzed() } })]).chains[0];
  assert.ok(kinds(c).includes('analysis_cites_missing_source'));
  assert.equal(c.health, 'broken');
});

test('same id twice yields two distinct chain keys, both flagged', () => {
  const a = sig({ id: 'dup', time: '11:00' }), b = sig({ id: 'dup', time: '11:30' });
  const { chains } = run([a, b]);
  assert.notEqual(chains[0].key, chains[1].key);
  assert.ok(chains.every((c) => kinds(c).includes('duplicate_id')));
});

test('unrouted, stalled vs fresh pending, unknown project', () => {
  const { chains } = run([sig({ projects: ['internal_unsorted'] }), sig({ detected_on: '2026-07-07' }), sig({ detected_on: '2026-07-15' }), sig({ projects: ['nope'] })]);
  assert.deepEqual(chains.map((c) => c.health), ['gap', 'gap', 'pending', 'broken']);
  assert.ok(kinds(chains[1]).includes('stalled'));
});

test('feed dark window needs sustained lag; failed-run days are flagged', () => {
  const w = feedWindows(runLog, 3);
  assert.equal(w.length, 1);
  assert.equal(w[0].feed, 'granola');
  const c = run([sig({ detected_on: '2026-07-09' })]).chains[0];
  assert.ok(kinds(c).includes('detected_during_failed_run'));
});

test('summary gap on nearly every analyzed chain is marked systemic', () => {
  const r = run(Array.from({ length: 6 }, () => sig({ status: { quill: analyzed() } })));
  assert.equal(r.fleet.systemic[0].kind, 'summary_missing');
  assert.ok(r.chains.every((c) => c.issues[0].systemic));
});

test('stalled (never-analyzed) chains do not dilute the systemic-gap rate', () => {
  const r = run([...Array.from({ length: 6 }, () => sig({ status: { quill: analyzed() } })), ...Array.from({ length: 10 }, () => sig({ detected_on: '2026-07-07' }))]);
  assert.deepEqual(r.fleet.systemic, [{ kind: 'summary_missing', count: 6, of: 6 }]);
});

test('dropped hint gets a typo suggestion', () => {
  const r = run([], [{ type: 'keyword', match: 'drafting', project: 'quil' }]);
  assert.equal(r.fleet.droppedHints[0].suggestion, 'quill');
});

test('write path: validates, is atomic, keeps history, never invents keys', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lin-'));
  const { chains } = run([sig({ projects: ['internal_unsorted'] })]);
  const good = { key: chains[0].key, kind: 'unrouted', action: 'acknowledged', note: 'seen' };
  await writeTriage(dir, chains, good);
  await writeTriage(dir, chains, { ...good, action: 'reopened' });
  const e = Object.values(readTriage(dir).entries)[0];
  assert.equal(e.history.length, 2);
  assert.ok(!fs.existsSync(path.join(dir, 'triage.json.tmp')));
  for (const bad of [null, { ...good, key: 'nope' }, { ...good, kind: 'stalled' }, { ...good, action: 'delete' }, { ...good, action: 'wont_fix', note: '' }, { ...good, note: 'x'.repeat(501) }])
    assert.throws(() => writeTriage(dir, chains, bad), ValidationError);
});

test('model output must be well-formed and grounded, else template fallback', async () => {
  const c = run([sig({ status: { quill: analyzed({ analysis_ref: 'run-999' }) } })]).chains[0];
  const issue = c.issues[0];
  const reply = (text) => async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text }] }) });
  const good = await explain(c, issue, { apiKey: 'k', fetchFn: reply(JSON.stringify({ what: 'run-999 is past run-109', likelyCause: 'typo', fixSteps: ['re-run'] })) });
  assert.equal(good.source, 'model');
  const invented = await explain(c, issue, { apiKey: 'k', fetchFn: reply(JSON.stringify({ what: 'see run-12', likelyCause: 'x', fixSteps: ['y'] })) });
  assert.equal(invented.source, 'template');
  const down = await explain(c, issue, { apiKey: 'k', fetchFn: async () => { throw new Error('offline'); } });
  assert.equal(down.source, 'template');
  assert.throws(() => validate({ what: 1 }, {}));
  assert.equal((await explain(c, issue, { apiKey: '' })).source, 'template');
});
