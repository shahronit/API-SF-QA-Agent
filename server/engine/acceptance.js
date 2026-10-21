'use strict';
/**
 * Map Jira acceptance criteria onto executable assertions.
 * Only encodes status codes, SLAs and named fields that already appear in
 * describe — never invents Salesforce metadata.
 */

function acceptanceLines(story) {
  const src = (story && (story.acceptanceCriteria || story.description)) || '';
  return String(src).split(/\n|(?=\bGiven\b)|(?=\bWhen\b)|(?=\bThen\b)/i)
    .map((s) => s.replace(/^[\s\-*\d.)]+/, '').trim())
    .filter((s) => s.length > 3);
}

function parseLine(line) {
  const statusM = line.match(/\b(?:http(?:\s+status)?|status(?:\s+code)?|returns?|respond(?:s|ing)?(?:\s+with)?)\s*(\d{3})\b/i)
    || line.match(/\b(\d{3})\b(?=.*\b(?:status|response|created|rejected|unauthorized|forbidden|not found)\b)/i);
  const sec = line.match(/\bwithin\s+(\d+(?:\.\d+)?)\s*seconds?\b/i);
  const ms = line.match(/\b(\d{2,6})\s*(?:ms|milliseconds)\b/i);
  const fieldM = line.match(/\b([A-Za-z][A-Za-z0-9_]{2,}(?:__c)?)\b/);
  const negative = /\b(reject|invalid|missing|without|fail|error|unauthori[sz]ed|forbidden|not found)\b/i.test(line);
  return {
    text: line,
    status: statusM ? Number(statusM[1]) : null,
    responseTimeMs: sec ? Math.round(Number(sec[1]) * 1000) : (ms ? Number(ms[1]) : null),
    fieldHint: fieldM ? fieldM[1] : null,
    negative,
  };
}

function parseAcceptance(story) {
  return acceptanceLines(story).map(parseLine);
}

function verbFor(text, method) {
  const t = String(text || '').toLowerCase();
  const m = String(method || '').toUpperCase();
  if (/\b(create|insert|post|submit|register|add)\b/.test(t)) return m === 'POST' || m === 'PUT';
  if (/\b(update|patch|edit|change|modify)\b/.test(t)) return m === 'PATCH' || m === 'PUT';
  if (/\b(delete|remove|purge)\b/.test(t)) return m === 'DELETE';
  if (/\b(get|read|retrieve|query|list|fetch|show)\b/.test(t)) return m === 'GET';
  return true;
}

function applyAcceptance(scenarios, items) {
  const mapped = [];
  if (!items || !items.length) return mapped;
  for (const s of scenarios || []) {
    for (const tc of s.testCases || []) {
      for (const item of items) {
        if (!verbFor(item.text, tc.method)) continue;
        if (item.negative && tc.testType === 'Functional') continue;
        if (!item.negative && tc.testType === 'Negative') continue;
        if (item.status) {
          const existing = (tc.assertions || []).find((a) => a.type === 'status');
          if (existing && Number(existing.expected) === item.status) {
            existing.label = existing.label || `Jira AC: ${item.text.slice(0, 90)}`;
            mapped.push({ test: tc.title, ac: item.text, assertion: 'status' });
          } else if (!existing || (item.negative && item.status >= 400 && tc.testType === 'Negative')) {
            if (existing && item.negative) existing.expected = item.status;
            else {
              tc.assertions = tc.assertions || [];
              if (!tc.assertions.some((a) => a.type === 'status' && Number(a.expected) === item.status)) {
                tc.assertions.push({ type: 'status', op: item.status >= 400 && Array.isArray(existing && existing.expected) ? 'in' : 'eq', expected: item.status, label: `Jira AC: ${item.text.slice(0, 90)}` });
              }
            }
            mapped.push({ test: tc.title, ac: item.text, assertion: 'status' });
          }
        }
        if (item.responseTimeMs) {
          const rt = (tc.assertions || []).find((a) => a.type === 'responseTime');
          if (rt) rt.expected = Math.min(Number(rt.expected) || item.responseTimeMs, item.responseTimeMs);
          else (tc.assertions || (tc.assertions = [])).push({ type: 'responseTime', op: 'lt', expected: item.responseTimeMs, label: `Jira AC SLA: ${item.text.slice(0, 90)}` });
          mapped.push({ test: tc.title, ac: item.text, assertion: 'responseTime' });
        }
      }
    }
  }
  return mapped;
}

module.exports = { parseAcceptance, applyAcceptance, acceptanceLines };
