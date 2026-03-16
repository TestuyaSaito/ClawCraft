// ═══════════════════════════════════════════════════════════════
// ACTION PARSER — extracts structured actions from LLM output
// ═══════════════════════════════════════════════════════════════

const VALID_ACTIONS = new Set(['delegate', 'report', 'blocker', 'request-review', 'review-result', 'handoff']);

// Parse ACTION:type key="value" key="value" lines from text
function parseActions(text) {
  const actions = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const match = line.match(/^ACTION:(\S+)\s*(.*)/);
    if (!match) continue;
    const type = match[1].toLowerCase();
    if (!VALID_ACTIONS.has(type)) continue;
    const params = {};
    const paramRegex = /(\w[\w-]*)="([^"]*)"/g;
    let pm;
    while ((pm = paramRegex.exec(match[2])) !== null) {
      params[pm[1]] = pm[2];
    }
    actions.push({ type, ...params });
  }
  return actions;
}

// Check if text contains any action blocks
function hasActions(text) {
  return /^ACTION:\w+/m.test(text);
}

// Extract the plain text (non-action) portion
function extractPlainText(text) {
  return text.split('\n')
    .filter(l => !l.match(/^ACTION:\S+/))
    .join('\n')
    .trim();
}

module.exports = { parseActions, hasActions, extractPlainText, VALID_ACTIONS };
