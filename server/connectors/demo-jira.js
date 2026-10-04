'use strict';
/**
 * Demo Jira — persists issues in the local `demo_jira` table so story
 * retrieval, defect creation, linking and comments work without a Jira site.
 */
const { repo, now, get } = require('../db');
const { maskText } = require('../lib/mask');
const { ConnectorError } = require('./salesforce');

class DemoJira {
  constructor(project) {
    this.project = project;
    this.kind = 'demo';
    this.available = true;
    this.baseUrl = 'https://demo-jira.local';
  }

  map(i) {
    return {
      key: i.key, summary: i.summary, description: i.description, acceptanceCriteria: i.acceptanceCriteria || '',
      issueType: i.issueType, status: i.status, priority: i.priority, labels: i.labels || [], components: i.components || [],
      assignee: i.assignee, sprint: i.sprint, url: `${this.baseUrl}/browse/${i.key}`, comments: i.comments || [], links: i.links || [],
    };
  }

  async searchStories({ jql } = {}) {
    let rows = repo.find('demo_jira', "projectKey = $k AND issueType IN ('Story','Task')", { k: this.project.jiraProjectKey }, 'ORDER BY key');
    const text = jql && (jql.match(/text\s*~\s*"([^"]+)"/i) || [])[1];
    if (text) rows = rows.filter((r) => `${r.summary} ${r.description}`.toLowerCase().includes(text.toLowerCase()));
    const sprint = jql && (jql.match(/sprint\s*=\s*"([^"]+)"/i) || [])[1];
    if (sprint) rows = rows.filter((r) => r.sprint === sprint);
    return rows.map((r) => this.map(r));
  }

  async getIssue(key) {
    const i = repo.get('demo_jira', key, 'key');
    if (!i) throw new ConnectorError({ code: 'JIRA_404', title: `Issue ${key} does not exist in demo Jira`, cause: 'The key is not in the demo dataset.', action: 'Pick a story from the Jira stories list.', category: 'data', evidence: [] });
    return this.map(i);
  }

  async createDefect(d) {
    const n = get("SELECT COUNT(*) AS n FROM demo_jira WHERE projectKey = $k", { k: this.project.jiraProjectKey }).n;
    const key = `${this.project.jiraProjectKey}-${200 + n + 1}`;
    repo.insert('demo_jira', {
      key, projectKey: this.project.jiraProjectKey, issueType: 'Bug', summary: maskText(d.summary), description: maskText(d.description),
      status: 'Open', priority: d.priority || 'Medium', labels: d.labels || [], components: d.components || [], assignee: d.assignee || null,
      sprint: d.sprint || null, comments: [], links: [], createdAt: now(), updatedAt: now(),
    });
    return { key, url: `${this.baseUrl}/browse/${key}` };
  }

  async updateIssue(key, patch) {
    const i = repo.get('demo_jira', key, 'key');
    if (!i) throw new ConnectorError({ code: 'JIRA_404', title: `Issue ${key} not found`, cause: 'Unknown key.', action: 'Refresh the defect list.', category: 'data', evidence: [] });
    repo.update('demo_jira', key, { ...(patch.summary ? { summary: maskText(patch.summary) } : {}), ...(patch.description ? { description: maskText(patch.description) } : {}), ...(patch.status ? { status: patch.status } : {}), ...(patch.labels ? { labels: patch.labels } : {}), ...(patch.priority ? { priority: patch.priority } : {}), updatedAt: now() }, 'key');
    return { key };
  }

  async addComment(key, text) {
    const i = repo.get('demo_jira', key, 'key');
    if (!i) throw new ConnectorError({ code: 'JIRA_404', title: `Issue ${key} not found`, cause: 'Unknown key.', action: 'Check the story key.', category: 'data', evidence: [] });
    repo.update('demo_jira', key, { comments: [...(i.comments || []), { at: now(), body: maskText(text) }], updatedAt: now() }, 'key');
    return { key };
  }

  async linkIssues(inwardKey, outwardKey, type = 'Relates') {
    for (const [a, b] of [[inwardKey, outwardKey], [outwardKey, inwardKey]]) {
      const i = repo.get('demo_jira', a, 'key');
      if (i) repo.update('demo_jira', a, { links: [...(i.links || []), { type, key: b }] }, 'key');
    }
    return { linked: true };
  }

  async addLabels(key, labels) {
    const i = repo.get('demo_jira', key, 'key');
    if (i) repo.update('demo_jira', key, { labels: [...new Set([...(i.labels || []), ...labels])] }, 'key');
  }

  async getStatus(key) {
    const i = repo.get('demo_jira', key, 'key');
    return { status: i ? i.status : 'Unknown', category: i && /done|closed|resolved/i.test(i.status) ? 'done' : 'indeterminate', resolvedAt: null };
  }

  async testConnection() { return { ok: true, user: 'Demo Jira user', project: this.project.jiraProjectKey, demo: true }; }
}

module.exports = { DemoJira };
