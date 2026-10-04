'use strict';
/**
 * Production safety guard. Production projects are READ ONLY by default:
 * any modifying operation requires explicit confirmation; DELETE requires a
 * second, separate confirmation.
 */
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
// POST endpoints that do not modify org data.
const READ_ONLY_POSTS = [/\/graphql$/i, /\/services\/oauth2\/(token|introspect|userinfo)/i];

const PRODUCTION_WARNING = 'This operation will modify Salesforce production data.';

function isProduction(project) {
  return String(project.environment || '').toLowerCase() === 'production';
}

function isModifying({ method, endpoint, path, body }) {
  const m = String(method || 'GET').toUpperCase();
  const p = String(endpoint || path || '');
  if (!WRITE_METHODS.includes(m)) return false;
  if (m === 'POST' && READ_ONLY_POSTS.some((rx) => rx.test(p))) {
    // GraphQL mutations are writes; queries are reads.
    if (/\/graphql$/i.test(p) && body && /\bmutation\b/.test(JSON.stringify(body))) return true;
    return false;
  }
  return true;
}

/**
 * @returns {null | {code, title, cause, action, category:'safety', evidence, requires: 'confirmProductionWrites'|'confirmDelete'}}
 */
function checkOperation(project, req, confirmations = {}) {
  if (!isProduction(project) || !isModifying(req)) return null;
  const method = String(req.method).toUpperCase();
  if (!confirmations.confirmProductionWrites) {
    return {
      code: 'PRODUCTION_READ_ONLY', title: PRODUCTION_WARNING, category: 'safety', requires: 'confirmProductionWrites',
      cause: `${project.name} targets Production, which is read-only by default. ${method} ${req.endpoint || req.path} would change data.`,
      action: 'Confirm the production write explicitly to proceed, or run this test in a non-production environment.',
      evidence: [`Environment: ${project.environment}`, `Operation: ${method}`],
    };
  }
  if (method === 'DELETE' && !confirmations.confirmDelete) {
    return {
      code: 'PRODUCTION_DELETE_CONFIRMATION', title: `${PRODUCTION_WARNING} DELETE requires a second confirmation.`, category: 'safety', requires: 'confirmDelete',
      cause: 'Deleting production records is irreversible beyond the recycle-bin retention window.',
      action: 'Provide the second DELETE confirmation to proceed.',
      evidence: [`Environment: ${project.environment}`, `Operation: DELETE ${req.endpoint || req.path}`],
    };
  }
  return null;
}

module.exports = { checkOperation, isProduction, isModifying, PRODUCTION_WARNING };
