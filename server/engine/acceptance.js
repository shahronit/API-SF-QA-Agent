'use strict';
/**
 * Map Jira acceptance criteria (and integration-doc rules) onto executable assertions.
 * Only encodes status codes, SLAs and named fields that already appear in
 * describe — never invents Salesforce metadata.
 *
 * Each mapping is { test, ac, check, source }. `check` is the assertion type that
 * encodes the criterion, or `coverage` when an existing test exercises it without
 * an extra assertion. (The key is not called `assertion` — that name is masked as a
 * JWT secret in every API response.)
 */

const ERROR_CODE_RX = /\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+){1,})\b/;
const AUTH_RX = /\b(permission|permissions|unauthori[sz]ed|unauthenticated|authenticat\w*|access token|token|profile|read-only|restricted|privilege\w*|entitled|role|only [\w\s]{0,40}users?)\b/i;
const PERSIST_RX = /\b(persist\w*|retriev\w*|stored|saved|read back|equals the submitted|is returned|are returned)\b/i;
const RULE_RX = /\b(required|mandatory|must|reject\w*|invalid|not allowed|only|within|under|below|returns?|responds?|error|duplicate|unique)\b/i;
const NOISE = new Set(['Given', 'When', 'Then', 'And', 'The', 'Only', 'Email', 'API', 'REST', 'HTTP', 'JSON', 'Response', 'Request', 'Requests', 'Query']);

function acceptanceLines(story) {
  const src = (story && (story.acceptanceCriteria || story.description)) || '';
  // Gherkin keywords are capitalised; a lower-case "when provided" mid-sentence is not a new step.
  return String(src).split(/\n|(?=\b(?:Given|When|Then)\b)/)
    .map((s) => s.replace(/^[\s\-*\d.)]+/, '').trim())
    .filter((s) => s.length > 3);
}

/** Field-like terms: CamelCase / API names, plus a small set of common lower-case field words. */
function fieldTerms(line) {
  const out = new Set();
  for (const m of String(line).matchAll(/\b([A-Za-z][A-Za-z0-9]*(?:__c)?)\b/g)) {
    const w = m[1];
    if (NOISE.has(w) && w !== 'Email') continue;
    if (/__c$/.test(w) || /^[A-Z][a-z]+[A-Z]/.test(w) || /^[a-z]+[A-Z]/.test(w)) out.add(w.toLowerCase());
  }
  for (const w of ['email', 'phone', 'rating', 'stage', 'company', 'amount', 'subject', 'priority', 'industry', 'website']) {
    if (new RegExp(`\\b${w}s?\\b`, 'i').test(line)) out.add(w);
  }
  return [...out];
}

function parseLine(line, source) {
  const statusM = line.match(/\b(?:http(?:\s+status)?|status(?:\s+code)?|returns?|respond(?:s|ing)?(?:\s+with)?)\s*(\d{3})\b/i)
    || line.match(/\b(\d{3})\b(?=.*\b(?:status|response|created|rejected|unauthorized|forbidden|not found)\b)/i);
  const sec = line.match(/\b(?:within|under|below|less than)\s+(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)\b/i);
  const ms = line.match(/\b(\d{2,6})\s*(?:ms|milliseconds)\b/i);
  const fields = fieldTerms(line);
  const code = line.match(ERROR_CODE_RX);
  const negative = /\b(reject\w*|invalid|missing|without|omit\w*|fail\w*|error|unauthori[sz]ed|unauthenticated|forbidden|not found|cannot|malformed)\b/i.test(line);
  return {
    text: line,
    source: source || 'jira',
    status: statusM ? Number(statusM[1]) : null,
    responseTimeMs: sec ? Math.round(Number(sec[1]) * 1000) : (ms ? Number(ms[1]) : null),
    errorCode: code ? code[1] : null,
    fieldHint: fields[0] || null,
    fields,
    auth: AUTH_RX.test(line),
    persist: PERSIST_RX.test(line),
    constraint: !negative && /\b(must|required|mandatory|one of|allowed values?)\b/i.test(line),
    negative,
  };
}

function parseAcceptance(story) {
  return acceptanceLines(story).map((l) => parseLine(l));
}

/** Testable rules stated in integration docs (status codes, error codes, required fields, SLAs). */
function parseDocRules(docs) {
  const out = [];
  for (const d of docs || []) {
    const lines = String((d && d.body) || '')
      .split(/\n|(?<=[.;])\s+/)
      .map((s) => s.replace(/^[\s\-*#\d.)]+/, '').replace(/[.;]+$/, '').trim())
      .filter((s) => s.length > 8 && s.length < 400);
    for (const l of lines) {
      const item = parseLine(l, 'doc');
      if (item.status || item.responseTimeMs || item.errorCode || RULE_RX.test(l)) out.push({ ...item, doc: d.name || 'Document' });
    }
  }
  return out.slice(0, 40);
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

const isSetup = (tc) => /^setup\b/i.test(String(tc.title || '')) || (tc.tags || []).includes('setup');
const isAuthTest = (tc) => tc.testType === 'Security' || ['none', 'invalid', 'lowpriv'].includes(tc.auth);

function coverageMatch(item, tc) {
  const title = String(tc.title || '').toLowerCase();
  if (item.auth) return isAuthTest(tc);
  if (isAuthTest(tc)) return false;
  if (item.persist && !item.negative) return String(tc.method).toUpperCase() === 'GET' && /retriev|query|compare|persist|read/.test(title);
  let hay = title;
  try { hay += ` ${decodeURIComponent(String(tc.endpoint || ''))} ${JSON.stringify(tc.query || {})} ${(tc.assertions || []).map((a) => a.path || '').join(' ')}`.toLowerCase(); } catch { /* malformed URI */ }
  return item.fields.some((f) => new RegExp(`\\b${f}\\b`).test(hay));
}

function applyAcceptance(scenarios, items) {
  const mapped = [];
  if (!items || !items.length) return mapped;
  const add = (tc, item, check) => mapped.push({ test: tc.title, ac: item.text, check, source: item.source });
  for (const s of scenarios || []) {
    for (const tc of s.testCases || []) {
      if (isSetup(tc)) continue;
      for (const item of items) {
        if (!verbFor(item.text, tc.method)) continue;
        if (item.negative && tc.testType === 'Functional') continue;
        if (!item.negative && tc.testType === 'Negative' && !(item.constraint && !item.status && coverageMatch(item, tc))) continue;
        let hit = false;
        if (item.status && !(item.auth && !isAuthTest(tc)) && !(item.negative && item.fields.length && !coverageMatch(item, tc))) {
          const existing = (tc.assertions || []).find((a) => a.type === 'status');
          if (existing && Number(existing.expected) === item.status) {
            existing.label = existing.label || `Jira AC: ${item.text.slice(0, 90)}`;
            add(tc, item, 'status'); hit = true;
          } else if (!existing || (item.negative && item.status >= 400 && tc.testType === 'Negative')) {
            if (existing && item.negative) existing.expected = item.status;
            else {
              tc.assertions = tc.assertions || [];
              if (!tc.assertions.some((a) => a.type === 'status' && Number(a.expected) === item.status)) {
                tc.assertions.push({ type: 'status', op: item.status >= 400 && Array.isArray(existing && existing.expected) ? 'in' : 'eq', expected: item.status, label: `${item.source === 'doc' ? 'Doc rule' : 'Jira AC'}: ${item.text.slice(0, 90)}` });
              }
            }
            add(tc, item, 'status'); hit = true;
          }
        }
        if (item.errorCode && item.negative !== false) {
          const sfe = (tc.assertions || []).find((a) => a.type === 'sfError');
          if (sfe && String(sfe.expected) === item.errorCode) {
            sfe.label = sfe.label || `${item.source === 'doc' ? 'Doc rule' : 'Jira AC'}: ${item.text.slice(0, 90)}`;
            add(tc, item, 'sfError'); hit = true;
          }
        }
        if (item.responseTimeMs) {
          const rt = (tc.assertions || []).find((a) => a.type === 'responseTime');
          if (rt) rt.expected = Math.min(Number(rt.expected) || item.responseTimeMs, item.responseTimeMs);
          else (tc.assertions || (tc.assertions = [])).push({ type: 'responseTime', op: 'lt', expected: item.responseTimeMs, label: `${item.source === 'doc' ? 'Doc SLA' : 'Jira AC SLA'}: ${item.text.slice(0, 90)}` });
          add(tc, item, 'responseTime'); hit = true;
        }
        if (!hit && !item.status && !item.responseTimeMs && !item.errorCode && coverageMatch(item, tc)) add(tc, item, 'coverage');
      }
    }
  }
  return mapped;
}

module.exports = { parseAcceptance, parseDocRules, applyAcceptance, acceptanceLines, parseLine };
