'use strict';
/**
 * Load one existing record per object from the connected org so read tests
 * can use a real Id instead of only records created in the same run.
 * Only Id (and optionally Name) are kept — never extra PII.
 */

const SAFE = /^[A-Za-z0-9_.]+$/;

async function loadFixtures(sf, objects, describes) {
  const fixtures = {};
  if (!sf || typeof sf.query !== 'function') return fixtures;
  for (const obj of (objects || []).slice(0, 4)) {
    if (!SAFE.test(obj)) continue;
    const d = describes && describes[obj];
    const queryable = !d || d.queryable !== false;
    if (!queryable) continue;
    const hasName = d && Array.isArray(d.fields) && d.fields.some((f) => f.name === 'Name');
    const soql = `SELECT Id${hasName ? ', Name' : ''} FROM ${obj} ORDER BY LastModifiedDate DESC LIMIT 1`;
    try {
      const res = await sf.query(soql);
      const rec = res && res.records && res.records[0];
      if (rec && rec.Id) fixtures[obj] = { Id: rec.Id, Name: rec.Name || null, soql };
    } catch { /* org may deny the object — skip */ }
  }
  return fixtures;
}

function fixtureTests(b, obj, fixture) {
  if (!fixture || !fixture.Id) return;
  const v = b.v;
  const s = b.scenarios.find((x) => x.object === obj && x.type === 'Functional') || b.scenario(`${obj} — live org fixture`, 'Functional', 'REST API', obj, 'Read coverage against a record that already exists in the org.');
  b.add(s, {
    title: `Retrieve existing ${obj} ${fixture.Id} from the org`,
    method: 'GET',
    endpoint: `${v}/sobjects/${obj}/${fixture.Id}`,
    assertions: [
      { type: 'status', op: 'eq', expected: 200 },
      { type: 'jsonpath', path: '$.Id', op: 'eq', expected: fixture.Id },
    ],
    tags: ['org-fixture', 'regression'],
    label: b.label,
    description: 'Id came from a live SOQL query (ORDER BY LastModifiedDate DESC LIMIT 1).',
  });
}

module.exports = { loadFixtures, fixtureTests };
