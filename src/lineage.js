// src/lineage.js - Pure walker, break detector, and systemic analyzer
function analyzeLineage(ledger, config, routingHints, runLog, snapshotDate = "2026-09-05") {
  const signals = ledger.signals || [];
  const projects = config.projects || [];
  const validProjects = new Set(projects.map(p => p.id));
  
  let newestRun = 0;
  const failedRuns = new Set();
  const failedRunDates = new Set();
  
  if (Array.isArray(runLog)) {
    for (const entry of runLog) {
      if (entry.run > newestRun) newestRun = entry.run;
      if (entry.status === "failed" || (entry.files_seen && entry.files_seen.length === 0)) {
        failedRuns.add(entry.run);
        if (entry.date) failedRunDates.add(entry.date);
      }
    }
  }

  const chains = [];
  let summaryMissingCount = 0;
  let analyzedCount = 0;
  const duplicateIdMap = new Map();

  for (const sig of signals) {
    const count = duplicateIdMap.get(sig.id) || 0;
    duplicateIdMap.set(sig.id, count + 1);
  }

  for (const sig of signals) {
    const targetProjects = (sig.projects && sig.projects.length > 0) ? sig.projects : ["internal_unsorted"];
    const isDuplicate = duplicateIdMap.get(sig.id) > 1;

    for (const proj of targetProjects) {
      const chainKey = `${sig.id}_${proj}`;
      const issues = [];
      const context = [];

      const unknownProj = !validProjects.has(proj) && proj !== "internal_unsorted";
      if (unknownProj) {
        issues.push({ kind: "unknown_project", severity: "error", message: `Project '${proj}' not found in config.` });
      }

      if (isDuplicate) {
        issues.push({ kind: "duplicate_id", severity: "error", message: `Duplicate signal ID detected: ${sig.id}` });
      }

      const statusEntry = sig.status && sig.status[proj];
      let health = "pending";
      const nodes = {
        signal: { state: "ok", detail: `Detected on ${sig.date} at ${sig.time || '00:00'}` },
        analysis: { state: "missing", detail: "No analysis record found." },
        summary: { state: "missing", detail: "No summary generated." },
        artifact: { state: "missing", detail: "No written-back artifact." }
      };

      if (statusEntry) {
        nodes.analysis.state = "ok";
        nodes.analysis.detail = `Analyzed at run ${statusEntry.analysis_ref || 'unknown'}`;
        analyzedCount++;

        if (statusEntry.state === "analyzed") {
          health = "analyzed";
        } else if (statusEntry.state === "deferred") {
          health = "deferred";
        }
      } else {
        const sigDate = new Date(sig.date);
        const snap = new Date(snapshotDate);
        const diffDays = (snap - sigDate) / (1000 * 60 * 60 * 24);
        if (diffDays > 7) {
          health = "gap";
          issues.push({ kind: "stalled", severity: "warn", message: `Signal unpicked for ${Math.floor(diffDays)} days.` });
        }
      }

      if (sig.summary) {
        nodes.summary.state = "ok";
        nodes.summary.detail = "Summary present.";
      } else {
        summaryMissingCount++;
        if (statusEntry) {
          nodes.summary.state = "missing";
          issues.push({ kind: "summary_missing", severity: "warn", message: "Analyzed signal lacks a summary." });
        }
      }

      if (sig.expected_files && sig.expected_files.length > 0) {
        nodes.artifact.state = "ok";
        nodes.artifact.detail = `${sig.expected_files.length} expected files recorded.`;
      }

      if (failedRunDates.has(sig.date)) {
        issues.push({ kind: "detected_during_failed_run", severity: "warn", message: `Detected on date of failed ingest run (${sig.date}).` });
      }

      chains.push({
        key: chainKey,
        id: sig.id,
        title: sig.title || "Untitled Signal",
        date: sig.date,
        time: sig.time,
        project: proj,
        health: issues.some(i => i.severity === "error") ? "broken" : (issues.length > 0 ? "gap" : health),
        nodes,
        issues,
        context
      });
    }
  }

  const fleet = {
    asOf: snapshotDate,
    systemic: analyzedCount > 0 && summaryMissingCount === analyzedCount ? "All analyzed chains missing summary (fleet export anomaly)." : null,
    unverifiableRefs: 0,
    failedRunsCount: failedRuns.size
  };

  return { chains, fleet };
}

module.exports = { analyzeLineage };
