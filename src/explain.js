async function explainIssue(chainKey, kind, issueMessage, facts) {
  const templateResult = {
    source: "template",
    what: issueMessage || `Issue detected of kind: ${kind}`,
    likelyCause: getLikelyCause(kind),
    owner: getOwner(kind),
    fixSteps: getFixSteps(kind)
  };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return templateResult;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: process.env.EXPLAIN_MODEL || "claude-3-5-sonnet-20241022",
        max_tokens: 300,
        system: "You are an expert diagnostic assistant for Supanova Inbox. Output strictly valid JSON matching {what, likelyCause, fixSteps[]}.",
        messages: [{ role: "user", content: `Explain chain issue ${kind} with message: ${issueMessage}` }]
      })
    });

    if (!response.ok) return templateResult;
    const data = await response.json();
    const text = data.content?.[0]?.text;
    if (!text) return templateResult;
    
    const parsed = JSON.parse(text);
    return {
      source: "model",
      what: parsed.what || templateResult.what,
      likelyCause: parsed.likelyCause || templateResult.likelyCause,
      owner: templateResult.owner,
      fixSteps: parsed.fixSteps || templateResult.fixSteps
    };
  } catch (err) {
    return templateResult;
  }
}

function getLikelyCause(kind) {
  switch (kind) {
    case "summary_missing": return "Upstream export job failed to populate summary field.";
    case "stalled": return "Human review queue backlog or missing assignee.";
    case "duplicate_id": return "Ingestion pipeline ran twice without ID deduplication.";
    default: return "Unexpected schema or synchronization drift.";
  }
}

function getOwner(kind) {
  if (kind.startsWith("analysis_")) return "AI Engineering Pipeline";
  if (kind === "summary_missing") return "Data Exporter Service";
  return "Triage Operations Lead";
}

function getFixSteps(kind) {
  switch (kind) {
    case "summary_missing": return ["Verify export script execution", "Re-run summarization worker on un-summarized IDs"];
    case "stalled": return ["Review pending status queue", "Assign reviewer or mark as deferred"];
    default: return ["Inspect raw ledger entry", "Replay event through validation pipeline"];
  }
}

module.exports = { explainIssue };
