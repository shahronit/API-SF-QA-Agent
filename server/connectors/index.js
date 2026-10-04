'use strict';
const { SalesforceConnector, ConnectorError } = require('./salesforce');
const { DemoSalesforce } = require('./demo-salesforce');
const { JiraConnector } = require('./jira');
const { DemoJira } = require('./demo-jira');

function salesforceFor(project) {
  return project.mode === 'demo' ? new DemoSalesforce(project) : new SalesforceConnector(project);
}

function jiraFor(project) {
  return project.mode === 'demo' ? new DemoJira(project) : new JiraConnector(project);
}

/**
 * Metadata provenance label. Live describe results are VERIFIED; demo
 * simulator metadata is ASSUMED (sample org, not the customer's org).
 */
function metadataLabel(project) {
  return project.mode === 'demo' ? 'ASSUMED' : 'VERIFIED';
}

module.exports = { salesforceFor, jiraFor, metadataLabel, ConnectorError };
