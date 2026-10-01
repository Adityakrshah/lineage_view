'use strict';
// Pure lineage walker: (ledger, config, hints, runLog) -> chains, project rollups, fleet findings.
// No I/O and no model. Everything a human sees as "broken" is decided here, deterministically.

const DAY = 864e5;
const STALE_DAYS = 7; // routed but untouched this long = stalled
const SYSTEMIC_RATE = 0.9, SYSTEMIC_MIN = 5; // a gap on >=90% of chains is a data-source problem, not N faults
const ts = (s) => Date.parse(String(s).slice(0, 10) + 'T00:00:00Z');
const daysBetween = (a, b) => Math.round((ts(a) - ts(b)) / DAY);
const RANK = { info: 0, warn: 1, error: 2 };
const mk = (kind, severity, at, message, facts = {}) => ({ kind, severity, at, message, facts });
const worst = (list) => list.reduce((m, i) => (RANK[i.severity] > RANK[m] ? i.severity : m), 'info');

function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// A feed is "dark" when it saw no files AND its newest file is older than the freshness
// threshold, for >= minRuns consecutive runs. (files_seen==0 alone is normal on a quiet day.)
function feedWindows(runLog, threshold, minRuns = 5) {
  const out = [];
  const feeds = new Set(runLog.flatMap((r) => Object.keys(r.feeds || {})));
  for (const feed of feeds) {
    let cur = null;
    const close = () => { if (cur && cur.runs >= minRuns) out.push(cur); cur = null; };
    for (const r of runLog) {
      const f = r.feeds?.[feed];
      if (!f) { close(); continue; }
      const day = r.started_at.slice(0, 10);
      const lag = daysBetween(day, f.last_file);
      if (f.files_seen === 0 && lag > threshold) {
        cur ??= { feed, from: day, to: day, runs: 0, maxLagDays: 0 };
        cur.to = day; cur.runs++; cur.maxLagDays = Math.max(cur.maxLagDays, lag);
      } else close();
    }
    close();
  }
  return out;
}

function walkChain(s, p, ctx) {
  const { projects, fb, maxRun, asOf } = ctx;
  const issues = [];
  const nodes = { signal: { state: 'ok', detail: `detected ${s.detected_on}` }, analysis: null, summary: null, artifact: null };
  const fill = (state) => { for (const k of ['analysis', 'summary', 'artifact']) nodes[k] ??= { state }; return { nodes, issues }; };

  if (p === fb.unrouted) {
    issues.push(mk('unrouted', 'warn', 'signal', 'No project matched this signal, so it never entered a project chain.'));
    return fill('n/a');
  }
  if (!projects.has(p)) {
    issues.push(mk('unknown_project', 'error', 'signal', `Routed to "${p}", which is not a project in config.json.`, { project: p }));
    return fill('n/a');
  }
  const st = s.status?.[p];
  if (!st || st.state === 'pending') {
    const age = daysBetween(asOf, s.detected_on);
    if (age > STALE_DAYS) {
      issues.push(mk('stalled', 'warn', 'analysis', `${st ? 'Marked pending' : 'No status recorded for this project'} ${age} days after detection; nothing has picked it up.`, { ageDays: age }));
      nodes.analysis = { state: 'warn', detail: 'stalled' };
    } else nodes.analysis = { state: 'pending', detail: st ? 'pending' : 'not started' };
    return fill('blocked');
  }
  if (st.state === 'deferred') { nodes.analysis = { state: 'deferred', detail: 'deferred' }; return fill('blocked'); }
  if (st.state !== 'analyzed') {
    issues.push(mk('bad_state', 'error', 'analysis', `Unknown status state "${st.state}".`, { state: st.state }));
    nodes.analysis = { state: 'error', detail: String(st.state) };
    return fill('blocked');
  }

  // --- analysis (state: analyzed) ---
  const a = [];
  const ref = st.analysis_ref;
  const m = typeof ref === 'string' ? /^run-(\d+)$/.exec(ref) : null;
  if (!ref) a.push(mk('analysis_ref_missing', 'error', 'analysis', 'Marked analyzed but has no analysis_ref, so there is no run to trace.'));
  else if (!m) a.push(mk('analysis_ref_malformed', 'error', 'analysis', `analysis_ref "${ref}" is not in the run-N form.`, { ref }));
  else if (+m[1] > maxRun) a.push(mk('analysis_ref_dangling', 'error', 'analysis', `analysis_ref ${ref} points past the newest run ever logged (run-${maxRun}); that run does not exist.`, { ref, newestRun: maxRun }));
  const have = new Set(Object.values(s.sources || {}).filter(Boolean));
  const files = Array.isArray(st.files_reviewed) ? st.files_reviewed : [];
  if (!files.length) a.push(mk('analysis_no_evidence', 'warn', 'analysis', 'Marked analyzed but reviewed no files.'));
  const phantom = files.filter((f) => !have.has(f));
  if (phantom.length) a.push(mk('analysis_cites_missing_source', 'error', 'analysis', `Analysis claims to have reviewed ${phantom.length} file(s) this signal has no record of.`, { files: phantom }));
  if (st.analyzed_at && ts(st.analyzed_at) < ts(s.date)) a.push(mk('analysis_time_travel', 'error', 'analysis', `analyzed_at (${st.analyzed_at}) is before the meeting date (${s.date}).`));
  issues.push(...a);
  const aw = a.length ? worst(a) : null;
  nodes.analysis = { state: aw === 'error' ? 'error' : aw === 'warn' ? 'warn' : 'ok', detail: ref || 'no ref', analyzed: true };
  if (aw === 'error') return fill('blocked');

  // --- summary (signal.summary; shared across projects, see README assumption) ---
  if (typeof s.summary === 'string' && s.summary.trim()) nodes.summary = { state: 'ok' };
  else {
    issues.push(mk('summary_missing', 'warn', 'summary', 'Analysis is recorded but no summary exists for this signal.'));
    nodes.summary = { state: 'missing' };
    return fill('blocked');
  }
  // --- written-back artifact (project-owned `notes`, see README assumption) ---
  if (typeof s.notes === 'string' && s.notes.trim()) nodes.artifact = { state: 'ok' };
  else {
    issues.push(mk('artifact_missing', 'warn', 'artifact', 'A summary exists but nothing was written back to the project.'));
    nodes.artifact = { state: 'missing' };
  }
  return { nodes, issues };
}

function buildLineage({ ledger, config, hints = [], runLog = [] }) {
  const projects = new Map(config.projects.map((p) => [p.id, p]));
  const fb = config.fallbacks || { unrouted: 'internal_unsorted' };
  const threshold = config.feed_freshness_threshold_days ?? 3;
  const signals = ledger.signals;
  runLog = [...runLog].sort((x, y) => x.run - y.run);
  const maxRun = runLog.reduce((m, r) => Math.max(m, r.run), 0);
  const asOf = [...runLog.map((r) => r.started_at.slice(0, 10)), ...signals.map((s) => s.detected_on)].filter(Boolean).sort().pop() || '1970-01-01';
  const failedDays = new Map(runLog.filter((r) => r.status !== 'ok').map((r) => [r.started_at.slice(0, 10), r]));
  const windows = feedWindows(runLog, threshold);
  const ctx = { projects, fb, maxRun, asOf };

  const idCount = new Map(), dayKey = new Map();
  for (const s of signals) {
    idCount.set(s.id, (idCount.get(s.id) || 0) + 1);
    const k = `${s.date}|${s.match_key}`;
    dayKey.set(k, [...(dayKey.get(k) || []), s]);
  }

  const chains = [], seenKeys = new Set();
  for (const s of signals) {
    const targets = s.projects?.length ? s.projects : [fb.unrouted];
    const shared = [];
    if (idCount.get(s.id) > 1) {
      const times = signals.filter((x) => x.id === s.id).map((x) => x.time);
      shared.push(mk('duplicate_id', 'error', 'signal', `${idCount.get(s.id)} ledger entries share the id ${s.id} (times ${times.join(', ')}); identity is not unique.`, { id: s.id, times }));
    }
    const twins = (dayKey.get(`${s.date}|${s.match_key}`) || []).filter((x) => x !== s && x.id !== s.id);
    if (twins.length) shared.push(mk('possible_duplicate', 'warn', 'signal', `Same meeting title on the same day also recorded as ${twins.map((t) => t.id).join(', ')}.`, { others: twins.map((t) => ({ id: t.id, time: t.time, attendees: t.attendees })) }));
    const orphanKeys = Object.keys(s.status || {}).filter((k) => !targets.includes(k));
    if (orphanKeys.length) shared.push(mk('status_orphan_key', 'error', 'signal', `status has entries for project(s) this signal is not routed to: ${orphanKeys.join(', ')}.`, { keys: orphanKeys }));
    if (failedDays.has(s.detected_on)) shared.push(mk('detected_during_failed_run', 'warn', 'signal', `Recorded as detected on ${s.detected_on}, but that day's ingest run failed and saw nothing.`, { run: failedDays.get(s.detected_on).run }));

    const context = [];
    const dark = windows.find((w) => w.feed === 'granola' && s.detected_on >= w.from && s.detected_on <= w.to);
    if (dark && !s.sources?.granola_note) context.push(`granola feed was dark ${dark.from} to ${dark.to}; a missing granola note here is expected, not a chain fault.`);
    if (failedDays.has(s.detected_on)) context.push(`ingest run ${failedDays.get(s.detected_on).run} failed that day (${failedDays.get(s.detected_on).error}).`);

    for (const p of targets) {
      const { nodes, issues } = walkChain(s, p, ctx);
      const all = [...shared.map((i) => ({ ...i })), ...issues];
      let key = `${s.id}@${s.time}:${p}`;
      for (let n = 2; seenKeys.has(key); n++) key = `${s.id}@${s.time}:${p}~${n}`;
      seenKeys.add(key);
      const sev = all.length ? worst(all) : null;
      const pendingish = ['pending', 'deferred'].includes(nodes.analysis.state);
      chains.push({
        key, id: s.id, title: s.title, date: s.date, time: s.time, project: p, nodes, issues: all, context,
        health: sev === 'error' ? 'broken' : sev === 'warn' ? 'gap' : pendingish ? 'pending' : 'healthy',
      });
    }
  }

  // Systemic gaps: if nearly every analyzed chain lacks the same thing, say so once.
  const fleetSystemic = [];
  const eligible = chains.filter((c) => c.nodes.analysis.analyzed && c.nodes.analysis.state !== 'error');
  for (const kind of ['summary_missing', 'artifact_missing']) {
    const hit = eligible.filter((c) => c.issues.some((i) => i.kind === kind));
    const denom = kind === 'summary_missing' ? eligible.length : eligible.filter((c) => c.nodes.summary.state === 'ok').length;
    if (denom >= SYSTEMIC_MIN && hit.length / denom >= SYSTEMIC_RATE) {
      fleetSystemic.push({ kind, count: hit.length, of: denom });
      for (const c of hit) for (const i of c.issues) if (i.kind === kind) i.systemic = true;
    }
  }

  const unrouted = chains.filter((c) => c.project === fb.unrouted);
  const dropped = hints.filter((h) => !projects.has(h.project)).map((h) => ({
    ...h,
    suggestion: [...projects.keys()].map((id) => [id, lev(String(h.project), id)]).filter(([, d]) => d <= 2).sort((x, y) => x[1] - y[1])[0]?.[0] ?? null,
    wouldRoute: h.type === 'keyword' ? unrouted.filter((c) => c.title.toLowerCase().includes(String(h.match).toLowerCase())).length : null,
  }));
  const refs = chains.filter((c) => c.nodes.analysis.analyzed);
  const runNums = new Set(runLog.map((r) => r.run));
  const unverifiableRefs = refs.filter((c) => { const n = /^run-(\d+)$/.exec(c.nodes.analysis.detail); return n && +n[1] <= maxRun && !runNums.has(+n[1]); }).length;

  const buckets = [...config.projects.map((p) => ({ id: p.id, name: p.name })), { id: fb.unrouted, name: 'Unsorted (no project matched)' }];
  for (const c of chains) if (!buckets.some((b) => b.id === c.project)) buckets.push({ id: c.project, name: `Unknown project "${c.project}"` });
  const rollup = buckets.map((b) => {
    const mine = chains.filter((c) => c.project === b.id);
    const counts = { broken: 0, gap: 0, pending: 0, healthy: 0 };
    mine.forEach((c) => counts[c.health]++);
    return { ...b, total: mine.length, counts };
  });

  return {
    asOf, chains, projects: rollup,
    fleet: {
      asOf, signalCount: signals.length, chainCount: chains.length, newestRun: maxRun,
      droppedHints: dropped, feedWindows: windows, systemic: fleetSystemic, unverifiableRefs,
      failedRuns: runLog.filter((r) => r.status !== 'ok').map((r) => ({ run: r.run, day: r.started_at.slice(0, 10), error: r.error })),
    },
  };
}

module.exports = { buildLineage, feedWindows, walkChain };
