'use strict';
/**
 * Experience Cloud / B2B Commerce (on Core) scenarios. Only uses objects that
 * already appeared in describeGlobal — no invented API names.
 */

function catalogHas(analysis, name) {
  return (analysis.catalogNames || []).includes(name) || analysis.objects.includes(name);
}

function experienceEnabled(project) {
  const ic = (project && project.integrationConfig) || {};
  if (ic.experience && ic.experience.enabled) return true;
  const types = (ic.salesforceDetection && ic.salesforceDetection.types) || [];
  return types.some((t) => /Experience|B2B/i.test(t));
}

function firstSite(project) {
  const sites = ((project.integrationConfig || {}).experience || {}).sites || [];
  return sites.find((s) => s && s.id) || null;
}

function firstStore(project) {
  const stores = ((project.integrationConfig || {}).experience || {}).stores || [];
  return stores.find((s) => s && s.id) || null;
}

function experienceScenarios(b, analysis) {
  const want = experienceEnabled(b.project) || (analysis.apiTypes || []).some((t) => /Experience|B2B Commerce/i.test(t));
  if (!want && !catalogHas(analysis, 'Network') && !catalogHas(analysis, 'WebStore') && !catalogHas(analysis, 'ccrz__E_Product__c') && !catalogHas(analysis, 'WebCart')) return;

  const site = firstSite(b.project);
  const store = firstStore(b.project);

  if (catalogHas(analysis, 'Network')) {
    const s = b.scenario('Experience Cloud — networks and Connect REST', 'Functional', 'Connect REST API', 'Network', 'Read-only Experience Cloud Network list plus Connect communities. Object names come from org describe.');
    b.add(s, {
      apiType: 'Connect REST API', title: 'Query Experience Cloud networks', method: 'GET', endpoint: `${b.v}/query`,
      query: { q: 'SELECT Id, Name, Status, UrlPathPrefix FROM Network LIMIT 10' },
      assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.records', op: 'type', expected: 'array' }],
      extract: [{ var: 'experienceNetworkId', path: '$.records[0].Id' }],
      tags: ['experience-cloud'],
    });
    b.add(s, {
      apiType: 'Connect REST API', title: 'Connect REST: list communities', method: 'GET', endpoint: `${b.v}/connect/communities`,
      assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.communities', op: 'type', expected: 'array' }],
      extract: [{ var: 'experienceCommunityId', path: '$.communities[0].id' }],
      tags: ['experience-cloud', 'connect-rest'],
    });
    b.add(s, {
      apiType: 'Connect REST API', title: 'Connect REST: current community (from list)', method: 'GET',
      endpoint: `${b.v}/connect/communities/{{experienceCommunityId}}`,
      assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.id', op: 'eq', expected: '{{experienceCommunityId}}' }],
      tags: ['experience-cloud', 'connect-rest'],
    });
    if (site && site.id) {
      b.add(s, {
        apiType: 'Connect REST API', title: `Connect REST: detected site ${site.name || site.id}`, method: 'GET',
        endpoint: `${b.v}/connect/communities/${site.id}`,
        assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.id', op: 'eq', expected: site.id }],
        tags: ['experience-cloud', 'org-fixture'],
      });
    }
    b.add(s, {
      apiType: 'Connect REST API', testType: 'Security', title: 'Communities without an access token is rejected', method: 'GET',
      endpoint: `${b.v}/connect/communities`,
      auth: 'none', assertions: [{ type: 'status', op: 'in', expected: [401, 403] }], tags: ['experience-cloud', 'authentication'],
    });
  }

  if (catalogHas(analysis, 'WebStore')) {
    const s = b.scenario('B2B Commerce — WebStore and Commerce API (Core)', 'Functional', 'REST API', 'WebStore', 'B2B Lightning / D2C storefront on Core. Paths come from org describe / detected store ids.');
    b.add(s, {
      title: 'Query WebStore records', method: 'GET', endpoint: `${b.v}/query`,
      query: { q: 'SELECT Id, Name FROM WebStore LIMIT 10' },
      assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.records', op: 'type', expected: 'array' }],
      extract: [{ var: 'webStoreId', path: '$.records[0].Id' }],
      tags: ['b2b-commerce'],
    });
    b.add(s, {
      title: 'Describe WebStore metadata', method: 'GET', endpoint: `${b.v}/sobjects/WebStore/describe`,
      assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.name', op: 'eq', expected: 'WebStore' }],
      tags: ['b2b-commerce'],
    });
    b.add(s, {
      title: 'Commerce API: list web stores', method: 'GET', endpoint: `${b.v}/commerce/webstores`,
      assertions: [{ type: 'status', op: 'in', expected: [200, 404] }, { type: 'responseTime', op: 'lt', expected: b.sla }],
      tags: ['b2b-commerce', 'commerce-api'],
      description: 'HTTP 404 means the Commerce API is not enabled on this org — still a real result, not an invented path.',
    });
    const storeId = (store && store.id) || '{{webStoreId}}';
    b.add(s, {
      title: 'Commerce API: web store record', method: 'GET',
      endpoint: `${b.v}/commerce/webstores/${storeId}`,
      assertions: [{ type: 'status', op: 'in', expected: [200, 404] }],
      tags: ['b2b-commerce', 'commerce-api'],
    });
    b.add(s, {
      title: 'Commerce API: search products in the first web store', method: 'GET',
      endpoint: `${b.v}/commerce/webstores/${storeId}/search/products`,
      query: { searchTerm: 'a', pageSize: 8 },
      assertions: [{ type: 'status', op: 'in', expected: [200, 400, 404] }],
      tags: ['b2b-commerce', 'commerce-api'],
    });
  }

  if (catalogHas(analysis, 'WebCart')) {
    const s = b.scenario('B2B Commerce — WebCart (Core)', 'Functional', 'REST API', 'WebCart', 'B2B cart object present in this org’s describe.');
    b.add(s, {
      title: 'Query WebCart records', method: 'GET', endpoint: `${b.v}/query`,
      query: { q: 'SELECT Id FROM WebCart LIMIT 5' },
      assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.records', op: 'type', expected: 'array' }],
      tags: ['b2b-commerce'],
    });
  }

  if (catalogHas(analysis, 'ProductCatalog')) {
    const s = b.scenario('B2B Commerce — ProductCatalog (Core)', 'Functional', 'REST API', 'ProductCatalog', 'B2B catalog object from org describe.');
    b.add(s, {
      title: 'Query ProductCatalog', method: 'GET', endpoint: `${b.v}/query`,
      query: { q: 'SELECT Id, Name FROM ProductCatalog LIMIT 5' },
      assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.records', op: 'type', expected: 'array' }],
      tags: ['b2b-commerce'],
    });
  }

  if (catalogHas(analysis, 'ccrz__E_Product__c')) {
    const s = b.scenario('B2B Commerce — CloudCraze product', 'Functional', 'REST API', 'ccrz__E_Product__c', 'CloudCraze product object present in this org’s describe.');
    b.add(s, {
      title: 'Query ccrz__E_Product__c', method: 'GET', endpoint: `${b.v}/query`,
      query: { q: 'SELECT Id FROM ccrz__E_Product__c LIMIT 5' },
      assertions: [{ type: 'status', op: 'eq', expected: 200 }, { type: 'jsonpath', path: '$.records', op: 'type', expected: 'array' }],
      tags: ['b2b-commerce', 'cloudcraze'],
    });
  }
}

module.exports = { experienceScenarios, experienceEnabled };
