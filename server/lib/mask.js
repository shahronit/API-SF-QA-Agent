'use strict';
/**
 * Sensitive-data masking. Applied to every API response, SSE event, stored
 * request/response, report and Jira defect body.
 */
const MASK = '••••••••';

const SENSITIVE_KEY = /^(password|passwd|pwd|secret|client_?secret|access_?token|refresh_?token|id_?token|session_?id|sid|authorization|proxy-authorization|cookie|set-cookie|api_?key|x-api-key|private_?key|assertion|token|bearer|sessionid|credentials?)$/i;
const SENSITIVE_KEY_LOOSE = /(password|secret|token|session_?id|authorization|api_?key|private_?key|cookie)/i;

// Patterns matched inside free text (logs, bodies, error messages).
const TEXT_PATTERNS = [
  // Salesforce session id / access token: 00D<org>!<token>
  [/\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._\-]{20,}/g, MASK],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  // Bearer / Basic auth values
  [/\b(Bearer|Basic|OAuth)\s+(?!\{\{)[A-Za-z0-9._~+/=!\-]{12,}/gi, `$1 ${MASK}`],
  // Atlassian API tokens
  [/\bATATT[A-Za-z0-9_\-=]{20,}/g, MASK],
  // key=value / "key":"value" pairs in query strings, form bodies and JSON text
  [/("?(?:access_token|refresh_token|client_secret|password|sessionId|session_id|sid|api_key|apiKey|assertion)"?\s*[:=]\s*"?)([^"&\s,}]{3,})/gi, `$1${MASK}`],
  // <sessionId> in SOAP envelopes
  [/(<(?:\w+:)?sessionId>)[^<]+(<\/(?:\w+:)?sessionId>)/gi, `$1${MASK}$2`],
  [/(<(?:\w+:)?password>)[^<]+(<\/(?:\w+:)?password>)/gi, `$1${MASK}$2`],
];

let knownSecrets = [];
/** Register literal secret values (from env) that must never be echoed. */
function registerSecrets(values) {
  knownSecrets = [...new Set(values.filter((v) => typeof v === 'string' && v.length >= 6))]
    .sort((a, b) => b.length - a.length);
}

const isTemplateRef = (v) => /^\s*((Bearer|Basic)\s+)?\{\{[^}]+\}\}\s*$/i.test(v);

function maskText(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = s;
  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.split(secret).join(MASK);
  }
  for (const [rx, rep] of TEXT_PATTERNS) out = out.replace(rx, rep);
  return out;
}

function maskDeep(value, depth = 0, keyName = '') {
  if (depth > 40) return value;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (keyName && (SENSITIVE_KEY.test(keyName) || SENSITIVE_KEY_LOOSE.test(keyName)) && value.length > 0 && !isTemplateRef(value)) {
      return MASK;
    }
    return maskText(value);
  }
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, depth + 1, keyName));
  if (typeof value === 'object') {
    if (Buffer.isBuffer(value)) return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskDeep(v, depth + 1, k);
    return out;
  }
  return value;
}

/** Mask HTTP headers specifically (case-insensitive). */
function maskHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = /^(authorization|proxy-authorization|cookie|set-cookie|x-sfdc-session|x-api-key)$/i.test(k) && !isTemplateRef(String(v))
      ? (String(v).match(/^(Bearer|Basic|OAuth)\s/i) ? `${String(v).split(' ')[0]} ${MASK}` : MASK)
      : maskText(String(v));
  }
  return out;
}

module.exports = { maskDeep, maskText, maskHeaders, registerSecrets, MASK };
