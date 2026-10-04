'use strict';
/**
 * Turns raw Salesforce / Jira / network failures into actionable explanations:
 * { title, cause, evidence, action, code, category }.
 * Never returns "Something went wrong".
 */

const SF_CODES = {
  INVALID_SESSION_ID: {
    title: 'Salesforce rejected the session (INVALID_SESSION_ID)',
    cause: 'The access token is missing, expired, revoked, or was issued for a different org/instance.',
    action: 'Re-authenticate the connected app for this project and confirm the instance URL matches the org that issued the token.',
    category: 'authentication',
  },
  INSUFFICIENT_ACCESS_OR_READONLY: {
    title: 'The connected user lacks access to this record or operation',
    cause: 'Object CRUD permission, record sharing or field-level security prevents the operation for the running user.',
    action: 'Check the integration user profile / permission sets for object and field access, and the sharing model for the record.',
    category: 'authorization',
  },
  INSUFFICIENT_ACCESS: {
    title: 'The connected user lacks the required permission',
    cause: 'A system or object permission required by this API is not granted.',
    action: 'Review the profile and permission sets assigned to the integration user.',
    category: 'authorization',
  },
  API_DISABLED_FOR_ORG: {
    title: 'API access is disabled for this org or user',
    cause: 'The org edition or the user profile does not have "API Enabled".',
    action: 'Enable the "API Enabled" permission on the integration user profile or permission set.',
    category: 'authorization',
  },
  REQUIRED_FIELD_MISSING: {
    title: 'A required field was not supplied',
    cause: 'The payload omits a field that is required by the object definition, page layout rule or a validation rule.',
    action: 'Add the field named in the error to the request payload, or update the test data.',
    category: 'data',
  },
  FIELD_CUSTOM_VALIDATION_EXCEPTION: {
    title: 'A Salesforce validation rule blocked the save',
    cause: 'The record violates an active validation rule on the object.',
    action: 'Read the validation message; confirm whether the rule is expected for this scenario (test data issue) or incorrect (defect).',
    category: 'data',
  },
  STRING_TOO_LONG: {
    title: 'A text value exceeds the field length',
    cause: 'The payload contains a value longer than the field definition allows.',
    action: 'Compare the value length with the field length from describe metadata.',
    category: 'data',
  },
  INVALID_FIELD: {
    title: 'The request references a field that does not exist or is not accessible',
    cause: 'The field API name is wrong, belongs to a different object, or is hidden by field-level security for the running user.',
    action: 'Verify the field API name with a describe call and check FLS for the integration user.',
    category: 'data',
  },
  INVALID_FIELD_FOR_INSERT_UPDATE: {
    title: 'The field cannot be written',
    cause: 'The field is read-only (formula, roll-up, system field) or not createable/updateable for the running user.',
    action: 'Remove the field from the payload or grant edit access via field-level security.',
    category: 'data',
  },
  MALFORMED_ID: {
    title: 'The record id is malformed',
    cause: 'The id is not a valid 15/18-character Salesforce id or has the wrong key prefix for the object.',
    action: 'Capture the id from the create response rather than hard-coding it.',
    category: 'data',
  },
  NOT_FOUND: {
    title: 'The requested resource was not found',
    cause: 'The record id does not exist, was deleted, or the endpoint path / API version is wrong.',
    action: 'Verify the id with a SOQL query and confirm the endpoint and API version for this org.',
    category: 'data',
  },
  ENTITY_IS_DELETED: {
    title: 'The record has been deleted',
    cause: 'The record is in the recycle bin or was hard-deleted.',
    action: 'Recreate the test record or undelete it before re-running dependent tests.',
    category: 'data',
  },
  JSON_PARSER_ERROR: {
    title: 'Salesforce could not parse the JSON body',
    cause: 'The request body is not valid JSON or uses an unexpected type for a field.',
    action: 'Validate the payload JSON and field types.',
    category: 'data',
  },
  INVALID_EMAIL_ADDRESS: {
    title: 'The email address is not valid',
    cause: 'An email field contains a value that Salesforce does not accept as an email address.',
    action: 'Use a correctly formatted address in the test data.',
    category: 'data',
  },
  INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: {
    title: 'The picklist value is not allowed',
    cause: 'The value is not active for the restricted picklist (or record type).',
    action: 'Use a value returned by the field describe for the relevant record type.',
    category: 'data',
  },
  DUPLICATES_DETECTED: {
    title: 'A duplicate rule blocked the record',
    cause: 'An active duplicate rule matched an existing record.',
    action: 'Use unique test data, or confirm the duplicate rule is expected for this scenario.',
    category: 'data',
  },
  DUPLICATE_VALUE: {
    title: 'A unique field already holds this value',
    cause: 'A unique or external id field already contains this value on another record.',
    action: 'Generate unique values (e.g. {{$uuid}}) for unique fields in test data.',
    category: 'data',
  },
  CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: {
    title: 'Automation (trigger or flow) failed while saving the record',
    cause: 'An Apex trigger, flow or process threw an exception during the save.',
    action: 'Inspect the error text for the trigger/flow name and review debug logs for the integration user.',
    category: 'automation',
  },
  UNABLE_TO_LOCK_ROW: {
    title: 'Record lock contention',
    cause: 'Another transaction held a lock on the same record (often parallel tests or integrations).',
    action: 'Run dependent tests sequentially, or retry with back-off.',
    category: 'environment',
  },
  REQUEST_LIMIT_EXCEEDED: {
    title: 'API request limit exceeded',
    cause: 'The org has exhausted its rolling 24-hour API request allocation, or a concurrency limit was hit.',
    action: 'Check /limits, reduce run frequency, or schedule the suite outside integration peaks.',
    category: 'environment',
  },
  INVALID_TYPE: {
    title: 'The sObject type is not valid or not accessible',
    cause: 'The object API name is wrong or the user has no access to it.',
    action: 'Verify the object name with describeGlobal and check object permissions.',
    category: 'data',
  },
  INVALID_CROSS_REFERENCE_KEY: {
    title: 'A lookup references an invalid record',
    cause: 'A lookup/master-detail id points to a record that does not exist or is not visible.',
    action: 'Create the parent record first and pass its id.',
    category: 'data',
  },
  FIELD_INTEGRITY_EXCEPTION: {
    title: 'A field value violates data integrity',
    cause: 'A lookup filter, record type or field dependency rejected the value.',
    action: 'Check lookup filters and dependent picklist rules for the field named in the error.',
    category: 'data',
  },
  INVALID_QUERY_FILTER_OPERATOR: { title: 'Invalid SOQL filter', cause: 'The SOQL WHERE clause uses an operator not valid for the field type.', action: 'Correct the SOQL query.', category: 'test design' },
  MALFORMED_QUERY: { title: 'Malformed SOQL query', cause: 'The SOQL syntax is invalid.', action: 'Validate the query in the Developer Console or the SOQL panel.', category: 'test design' },
  INVALID_GRANT: { title: 'OAuth token request rejected (invalid_grant)', cause: 'Wrong credentials, user not pre-authorised for the connected app, IP restrictions, or expired refresh token.', action: 'Check the connected app policies, user pre-authorisation and the credential values in the secret store.', category: 'authentication' },
};

const HTTP_DEFAULTS = {
  400: ['Bad request', 'The request was rejected by the server as invalid.', 'Inspect the response body for the error code and fix the payload or parameters.', 'data'],
  401: ['Not authenticated', 'No valid credentials were presented.', 'Re-authenticate and confirm the token is being sent in the Authorization header.', 'authentication'],
  403: ['Forbidden', 'The authenticated user is not permitted to perform this operation.', 'Review profile, permission sets and connected app scopes.', 'authorization'],
  404: ['Not found', 'The endpoint or record does not exist.', 'Verify the URL, API version and record id.', 'data'],
  405: ['Method not allowed', 'This HTTP method is not supported on this resource.', 'Use the method documented for the endpoint.', 'test design'],
  409: ['Conflict', 'The request conflicts with the current state of the resource.', 'Check for concurrent updates or duplicate keys.', 'data'],
  415: ['Unsupported media type', 'The Content-Type header does not match what the endpoint expects.', 'Send application/json (REST) or text/xml (SOAP).', 'test design'],
  429: ['Too many requests', 'A rate or concurrency limit was reached.', 'Back off and retry; review API limits.', 'environment'],
  500: ['Server error', 'The server failed while processing the request — often an unhandled Apex exception.', 'Check debug logs for the integration user around the timestamp.', 'product'],
  502: ['Bad gateway', 'An upstream system (middleware or external service) returned an invalid response.', 'Check middleware logs using the correlation id.', 'environment'],
  503: ['Service unavailable', 'The service is down or in maintenance.', 'Check trust.salesforce.com / middleware status and retry later.', 'environment'],
  504: ['Gateway timeout', 'An upstream system did not respond in time.', 'Check middleware/external system latency and timeouts.', 'environment'],
};

/** Extract Salesforce-style error entries from a response body. */
function sfErrors(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body.filter((e) => e && (e.errorCode || e.statusCode || e.message));
  if (body.error && typeof body.error === 'string') return [{ errorCode: String(body.error).toUpperCase(), message: body.error_description || body.error }];
  if (Array.isArray(body.errors)) {
    return body.errors.map((e) => (typeof e === 'string' ? { message: e } : { errorCode: e.statusCode || e.errorCode, message: e.message, fields: e.fields }));
  }
  if (body.errorCode) return [body];
  return [];
}

function explainResponse({ status, body, method, url }) {
  if (status >= 200 && status < 400) return null;
  const errs = sfErrors(body);
  const first = errs[0] || {};
  const code = first.errorCode || first.statusCode;
  const known = code && SF_CODES[String(code).toUpperCase()];
  const def = HTTP_DEFAULTS[status] || HTTP_DEFAULTS[Math.floor(status / 100) * 100] || ['Unexpected status', 'The server returned an unexpected status.', 'Inspect the response body.', 'unknown'];
  const evidence = [`HTTP ${status} from ${method || ''} ${url || ''}`.trim()];
  if (code) evidence.push(`errorCode: ${code}`);
  if (first.message) evidence.push(`message: ${String(first.message).slice(0, 400)}`);
  if (first.fields && first.fields.length) evidence.push(`fields: ${first.fields.join(', ')}`);
  return {
    code: code || `HTTP_${status}`,
    title: known ? known.title : `${def[0]} (HTTP ${status})`,
    cause: known ? known.cause : def[1],
    action: known ? known.action : def[2],
    category: known ? known.category : def[3],
    evidence,
    message: first.message || null,
  };
}

function explainNetworkError(err, url) {
  const code = err && (err.cause && err.cause.code ? err.cause.code : err.code);
  const map = {
    ENOTFOUND: ['DNS lookup failed', 'The host name could not be resolved.', 'Check the instance URL for typos and your network/VPN.'],
    ECONNREFUSED: ['Connection refused', 'Nothing is listening at the target host/port.', 'Verify the URL and that the target service is running.'],
    ECONNRESET: ['Connection reset', 'The remote host closed the connection unexpectedly.', 'Retry; check proxies and TLS inspection.'],
    ETIMEDOUT: ['Connection timed out', 'The host did not respond in time.', 'Check network reachability and firewall rules.'],
    UND_ERR_CONNECT_TIMEOUT: ['Connection timed out', 'The host did not accept the connection in time.', 'Check network reachability, proxies and firewall rules.'],
    CERT_HAS_EXPIRED: ['TLS certificate expired', 'The server certificate has expired.', 'Contact the endpoint owner.'],
    TIMEOUT: ['Request timed out', 'No response was received within the configured timeout.', 'Increase the timeout for this test or investigate the endpoint latency.'],
  };
  const m = map[code] || ['Network error', err && err.message ? err.message : 'The request could not be completed.', 'Check connectivity, proxy settings and the target URL.'];
  return { code: code || 'NETWORK_ERROR', title: m[0], cause: m[1], action: m[2], category: 'environment', evidence: [`${url || ''} — ${err && err.message ? err.message : code}`] };
}

module.exports = { explainResponse, explainNetworkError, sfErrors, SF_CODES };
