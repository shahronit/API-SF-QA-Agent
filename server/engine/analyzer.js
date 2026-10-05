'use strict';
/**
 * Failure analysis: classifies each failed/blocked result and suggests a root
 * cause, with evidence and a recommended action. Confidence and provenance are
 * explicit — a rule-based hypothesis is labelled ASSUMED until a human confirms.
 */
const { explainResponse, sfErrors } = require('../lib/errors');

function analyseCore(result, testCase) {
  if (result.status === 'passed' || result.status === 'skipped') return null;
  const ev = [];
  const failedAssertions = (result.assertions || []).filter((a) => a.result === 'FAIL');
  const resp = result.response || {};
  const errs = sfErrors(resp.body);
  const code = errs[0] && (errs[0].errorCode || errs[0].statusCode);

  if (result.status === 'blocked') {
    return {
      category: result.error && result.error.category === 'safety' ? 'Production safety' : 'Blocked dependency',
      rootCause: result.error ? result.error.title : 'Test could not run.',
      evidence: result.error ? result.error.evidence || [] : [],
      action: result.error ? result.error.action : 'Fix the upstream failure and re-run.',
      confidence: 'high', label: 'VERIFIED', defectCandidate: false,
    };
  }
  if (result.error && result.error.category === 'environment') {
    return { category: 'Environment / connectivity', rootCause: result.error.title, evidence: result.error.evidence || [], action: result.error.action, confidence: 'high', label: 'VERIFIED', defectCandidate: false };
  }
  if (result.error && ['configuration', 'authentication'].includes(result.error.category) && !resp.status) {
    return { category: 'Configuration', rootCause: result.error.title, evidence: result.error.evidence || [], action: result.error.action, confidence: 'high', label: 'VERIFIED', defectCandidate: false };
  }

  for (const a of failedAssertions) ev.push(`${a.check} — ${a.message || `actual ${JSON.stringify(a.actual)}`}`);
  if (resp.status) ev.push(`HTTP ${resp.status}${code ? ` / ${code}` : ''}`);
  if (errs[0] && errs[0].message) ev.push(`Salesforce message: ${String(errs[0].message).slice(0, 300)}`);

  const sfv = result.sfValidation;
  if (sfv && sfv.status === 'FAIL' && sfv.comparisons) {
    const diffs = sfv.comparisons.filter((c) => !c.match);
    for (const d of diffs) ev.push(`Salesforce ${sfv.object}.${d.field}: expected ${JSON.stringify(d.expected)}, persisted ${JSON.stringify(d.actual)}`);
    const mappingCheck = testCase && testCase.sfValidation && testCase.sfValidation.mappingCheck;
    const allNull = diffs.every((d) => d.actual === null);
    return {
      category: mappingCheck && allNull ? 'Integration mapping defect' : 'Data persistence / automation defect',
      rootCause: mappingCheck && allNull
        ? `Field(s) ${diffs.map((d) => d.field).join(', ')} were not mapped by the integration endpoint — the API accepted the request but Salesforce stored null.`
        : `Persisted value differs from the submitted value for ${diffs.map((d) => d.field).join(', ')}. A flow, trigger, workflow field update or default value is likely overwriting the field after save.`,
      evidence: ev,
      action: mappingCheck && allNull
        ? 'Review the Apex REST resource / middleware mapping for the listed fields and add unit tests for the mapping.'
        : 'Check record-triggered flows, Apex triggers and field updates on the object for logic that modifies these fields (Setup → Object Manager → Flow Triggers / Triggers).',
      confidence: 'medium', label: 'ASSUMED', defectCandidate: true,
    };
  }

  const status = resp.status;
  const rtFail = failedAssertions.find((a) => a.type === 'responseTime');
  if (rtFail && failedAssertions.length === 1) {
    return {
      category: 'Performance (SLA breach)',
      rootCause: `Response time ${rtFail.actual} ms exceeded the ${rtFail.expected} ms SLA. Typical causes: non-selective SOQL filter, missing index, large data volume, or synchronous automation.`,
      evidence: ev, action: 'Check the query plan for the SOQL, review indexes/skinny tables, and compare latency across runs on the trend chart.',
      confidence: 'medium', label: 'ASSUMED', defectCandidate: true,
    };
  }
  if (status >= 500) {
    const apex = errs[0] && /System\.\w+Exception|Class\.\w+/.test(errs[0].message || '');
    return {
      category: 'Server-side defect',
      rootCause: apex
        ? `Unhandled Apex exception: ${String(errs[0].message).split('\n')[0].slice(0, 240)}. The endpoint should translate this into a handled 4xx error.`
        : `The endpoint returned HTTP ${status}.`,
      evidence: ev, action: 'Review the Apex class named in the stack trace, add exception handling and a negative unit test; check debug logs at the failure timestamp using the correlation id.',
      confidence: apex ? 'high' : 'medium', label: apex ? 'VERIFIED' : 'ASSUMED', defectCandidate: true,
    };
  }
  const exp = status ? explainResponse({ status, body: resp.body }) : null;
  const statusAssert = failedAssertions.find((a) => a.type === 'status');
  if (statusAssert && status >= 400) {
    const expectedSuccess = [].concat(statusAssert.expected).some((s) => Number(s) < 400);
    if (expectedSuccess) {
      const testData = ['REQUIRED_FIELD_MISSING', 'DUPLICATES_DETECTED', 'DUPLICATE_VALUE', 'FIELD_CUSTOM_VALIDATION_EXCEPTION', 'INVALID_CROSS_REFERENCE_KEY', 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY'].includes(code);
      const auth = ['INVALID_SESSION_ID', 'INSUFFICIENT_ACCESS_OR_READONLY', 'API_DISABLED_FOR_ORG', 'INSUFFICIENT_ACCESS'].includes(code);
      return {
        category: auth ? 'Access / configuration' : testData ? 'Test data or org configuration' : 'Functional defect',
        rootCause: exp ? `${exp.title}. ${exp.cause}` : `Unexpected HTTP ${status}.`,
        evidence: ev, action: exp ? exp.action : 'Inspect the response body.',
        confidence: 'medium', label: 'ASSUMED', defectCandidate: !auth && !testData,
      };
    }
  }
  if (statusAssert && status < 400) {
    return {
      category: 'Missing validation (functional defect)',
      rootCause: `The API accepted a request that should have been rejected (expected ${JSON.stringify(statusAssert.expected)}, got ${status}). A validation rule, required-field constraint or input check may be missing.`,
      evidence: ev, action: 'Confirm the requirement with the BA; if confirmed, add the validation (validation rule / Apex check) and re-run.',
      confidence: 'medium', label: 'ASSUMED', defectCandidate: true,
    };
  }
  const errAssert = failedAssertions.find((a) => a.type === 'sfError');
  if (errAssert) {
    return {
      category: 'Error contract mismatch',
      rootCause: `Salesforce returned error code ${errAssert.actual || 'none'} instead of ${errAssert.expected}. ${exp ? exp.cause : ''}`.trim(),
      evidence: ev, action: 'Confirm which error code the consumer relies on; update the test if the platform behaviour is correct, otherwise raise a defect.',
      confidence: 'low', label: 'ASSUMED', defectCandidate: false,
    };
  }
  if (failedAssertions.some((a) => a.type === 'schema')) {
    return { category: 'Contract violation', rootCause: 'The response body does not match the expected schema.', evidence: ev, action: 'Compare the response with the API contract and agree whether the contract or the implementation is wrong.', confidence: 'medium', label: 'ASSUMED', defectCandidate: true };
  }
  return { category: 'Assertion failure', rootCause: failedAssertions.map((a) => a.message).join('; ') || 'One or more assertions failed.', evidence: ev, action: 'Review the assertions against the response; update test expectations if behaviour changed intentionally.', confidence: 'low', label: 'ASSUMED', defectCandidate: false };
}

/** The eleven failure classifications from the QA plan. */
const CLASSIFICATIONS = [
  'Test Data Issue', 'Authentication Issue', 'Authorization Issue', 'API Contract Issue', 'Salesforce Configuration Issue', 'Salesforce Automation Issue',
  'Integration Issue', 'Application Defect', 'Environment Issue', 'Performance Issue', 'External Dependency Issue',
];

const AUTH_CODES = ['INVALID_SESSION_ID', 'INVALID_AUTH_HEADER', 'INVALID_LOGIN', 'INVALID_GRANT', 'invalid_client', 'invalid_client_id'];
const AUTHZ_CODES = ['INSUFFICIENT_ACCESS_OR_READONLY', 'INSUFFICIENT_ACCESS', 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY', 'FIELD_INTEGRITY_EXCEPTION_FLS', 'NOT_FOUND_FLS'];
const CONFIG_CODES = ['API_DISABLED_FOR_ORG', 'REQUEST_LIMIT_EXCEEDED', 'FIELD_CUSTOM_VALIDATION_EXCEPTION', 'INVALID_TYPE', 'ENTITY_IS_LOCKED'];
const DATA_CODES = ['REQUIRED_FIELD_MISSING', 'DUPLICATES_DETECTED', 'DUPLICATE_VALUE', 'INVALID_CROSS_REFERENCE_KEY', 'STRING_TOO_LONG', 'INVALID_EMAIL_ADDRESS', 'MALFORMED_ID', 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST'];

/** Map the analyser's category (+ evidence) onto one of the eleven plan classifications. Never defaults blindly to "Application Defect". */
function classify(core, result, testCase) {
  const resp = result.response || {};
  const errs = sfErrors(resp.body);
  const code = errs[0] && (errs[0].errorCode || errs[0].statusCode);
  const msg = String((errs[0] && errs[0].message) || '');
  const tags = (testCase && testCase.tags) || [];
  const status = resp.status;
  switch (core.category) {
    case 'Production safety': return null; // policy block, not a failure
    case 'Blocked dependency': return 'Test Data Issue';
    case 'Environment / connectivity': return 'Environment Issue';
    case 'Configuration': return result.error && result.error.category === 'authentication' ? 'Authentication Issue' : 'Salesforce Configuration Issue';
    case 'Integration mapping defect': return 'Integration Issue';
    case 'Data persistence / automation defect': return 'Salesforce Automation Issue';
    case 'Performance (SLA breach)': return 'Performance Issue';
    case 'Contract violation': case 'Error contract mismatch': return 'API Contract Issue';
    case 'Server-side defect':
      if ([502, 503, 504].includes(status) || /CalloutException|callout|timed out|Read timed out|Unauthorized endpoint/i.test(msg)) return /SERVER_UNAVAILABLE|maintenance/i.test(msg + (code || '')) ? 'Environment Issue' : 'External Dependency Issue';
      if (/REQUEST_LIMIT_EXCEEDED|UNABLE_TO_LOCK_ROW|Apex CPU|governor/i.test(msg + (code || ''))) return 'Salesforce Configuration Issue';
      return 'Application Defect';
    case 'Access / configuration':
      if (AUTH_CODES.includes(code)) return 'Authentication Issue';
      if (AUTHZ_CODES.includes(code)) return 'Authorization Issue';
      return 'Salesforce Configuration Issue';
    case 'Test data or org configuration':
      return DATA_CODES.includes(code) ? 'Test Data Issue' : 'Salesforce Configuration Issue';
    case 'Missing validation (functional defect)':
      if (tags.includes('authentication')) return 'Authentication Issue';
      if (tags.includes('authorization')) return 'Authorization Issue';
      return 'Application Defect';
    case 'Functional defect':
      if (AUTH_CODES.includes(code)) return 'Authentication Issue';
      if (AUTHZ_CODES.includes(code)) return 'Authorization Issue';
      if (DATA_CODES.includes(code)) return 'Test Data Issue';
      if (CONFIG_CODES.includes(code)) return 'Salesforce Configuration Issue';
      return 'Application Defect';
    default: return 'API Contract Issue'; // plain assertion mismatch: expectation vs response, undecided until reviewed
  }
}

const IMPACT = {
  'Test Data Issue': 'The test cannot prove or disprove the behaviour until its data/dependencies are fixed. No product defect is established yet.',
  'Authentication Issue': 'Callers cannot authenticate, or unauthenticated/invalid credentials are being accepted — an availability or security risk for every consumer of this API.',
  'Authorization Issue': 'Users may reach data or operations beyond their permissions, or legitimate users are blocked — a data-exposure or access risk.',
  'API Contract Issue': 'Consumers built against the documented contract (status codes, error codes, schema) may break or mis-handle responses.',
  'Salesforce Configuration Issue': 'Org setup (permissions, API access, validation rules, limits) prevents the operation; behaviour will differ between environments.',
  'Salesforce Automation Issue': 'Flows, triggers or field updates change data after save, so stored records differ from what API consumers submitted — downstream reports and integrations see wrong values.',
  'Integration Issue': 'Data from the external/middleware system is not stored or mapped correctly in Salesforce; dependent business processes and reporting are affected.',
  'Application Defect': 'The operation returns wrong or failing results for users and integrations that depend on it.',
  'Environment Issue': 'No product conclusion can be drawn until the environment (sandbox availability, connectivity) is healthy; results from this run are unreliable.',
  'Performance Issue': 'Responses beyond the SLA risk consumer timeouts and will degrade further under concurrent load or larger data volumes.',
  'External Dependency Issue': 'A dependent external system or callout is failing, so end-to-end processing that relies on it is interrupted.',
};

function retestFor(cls, result, testCase) {
  const id = (testCase && testCase.id) || result.testCaseId;
  const obj = (testCase && testCase.object) || result.object;
  const first = `Re-run ${id ? id + ' — ' : ''}${result.title}.`;
  const regress = obj ? ` Then re-run the regression-tagged tests for ${obj} and the other tests on ${String(result.method || '')} ${String(result.endpoint || '').split('?')[0]}.` : ' Then re-run the regression-tagged tests that share this endpoint.';
  switch (cls) {
    case 'Test Data Issue': return `${first} Re-run the full suite so upstream setup tests provide the data this test needs.`;
    case 'Authentication Issue': case 'Authorization Issue': return `${first} Also re-run every authentication/authorization test for this API, using both a valid and a restricted user.`;
    case 'Performance Issue': return `${first} Compare response time with the previous baseline over at least 3 runs and re-check with production-like data volume.`;
    case 'Environment Issue': case 'External Dependency Issue': return `${first} Verify the environment/dependency is healthy first, then run the complete suite to confirm no other test was affected.`;
    case 'Salesforce Automation Issue': return `${first} Also verify the record in Salesforce after save (Salesforce data validation) and re-run tests for other fields on the same object.`;
    default: return first + regress;
  }
}

function failureSummary(result, core) {
  const first = (result.assertions || []).find((a) => a.result === 'FAIL');
  const what = first ? (first.message || `${first.check} failed`) : (core.rootCause || 'Test did not complete');
  return `${result.title}${result.method ? ` (${result.method} ${String(result.endpoint || '').split('?')[0]})` : ''}: ${what}`.slice(0, 500);
}

/** Analyse a non-passing result into the plan's RCA shape: Failure / Evidence / Root Cause / Impact / Recommendation / Retest + classification. */
function analyse(result, testCase) {
  const core = analyseCore(result, testCase);
  if (!core) return null;
  const classification = classify(core, result, testCase);
  const urgency = testCase && ['P0', 'P1'].includes(testCase.priority || result.priority) ? ` Priority ${(testCase && testCase.priority) || result.priority}: treat as release-relevant.` : '';
  return {
    ...core,
    classification,
    failure: failureSummary(result, core),
    impact: classification ? IMPACT[classification] + urgency : 'No functional impact — execution was blocked by the production safety policy.',
    recommendation: core.action,
    retest: retestFor(classification, result, testCase),
  };
}

/** Run-level insights for the Analyze mode. */
function summarise(results) {
  const failed = results.filter((r) => r.status === 'failed');
  const byCategory = {};
  for (const r of failed) {
    const c = (r.analysis && r.analysis.category) || 'Unclassified';
    (byCategory[c] = byCategory[c] || []).push(r);
  }
  const endpoints = {};
  for (const r of results) {
    const key = `${r.method} ${String(r.endpoint || '').replace(/\/[a-zA-Z0-9]{15,18}(?=\/|$)/g, '/{id}').split('?')[0]}`;
    endpoints[key] = endpoints[key] || { endpoint: key, total: 0, failed: 0 };
    endpoints[key].total++;
    if (r.status === 'failed') endpoints[key].failed++;
  }
  return {
    categories: Object.entries(byCategory).map(([category, rs]) => ({ category, count: rs.length, tests: rs.map((r) => r.title) })),
    classifications: Object.entries(failed.reduce((m, r) => { const c = (r.analysis && r.analysis.classification) || 'Unclassified'; (m[c] = m[c] || []).push(r.title); return m; }, {})).map(([classification, tests]) => ({ classification, count: tests.length, tests })),
    defectCandidates: failed.filter((r) => r.analysis && r.analysis.defectCandidate).map((r) => ({ resultId: r.id, title: r.title, rootCause: r.analysis.rootCause })),
    hotspots: Object.values(endpoints).filter((e) => e.failed).sort((a, b) => b.failed / b.total - a.failed / a.total),
  };
}

module.exports = { analyse, summarise, CLASSIFICATIONS, classify };
