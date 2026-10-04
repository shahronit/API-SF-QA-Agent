'use strict';
/**
 * Jira Cloud REST v3 connector (API token auth). Descriptions/comments use
 * Atlassian Document Format (ADF). All outbound text is masked first.
 */
const { jiraCredentials, config } = require('../config');
const { maskText } = require('../lib/mask');
const { explainResponse, explainNetworkError } = require('../lib/errors');
const { ConnectorError } = require('./salesforce');

/** Convert lightweight markdown (headings, bullets, code fences) to ADF. */
function toAdf(text) {
  const content = [];
  const lines = maskText(String(text || '')).split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      content.push({ type: 'codeBlock', attrs: { language: 'json' }, content: buf.length ? [{ type: 'text', text: buf.join('\n').slice(0, 30000) }] : [] });
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { content.push({ type: 'heading', attrs: { level: h[1].length + 1 }, content: [{ type: 'text', text: h[2] }] }); i++; continue; }
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: lines[i].replace(/^[-*]\s+/, '') }] }] });
        i++;
      }
      content.push({ type: 'bulletList', content: items });
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: lines[i].replace(/^\d+\.\s+/, '') }] }] });
        i++;
      }
      content.push({ type: 'orderedList', content: items });
      continue;
    }
    if (line.trim()) content.push({ type: 'paragraph', content: [{ type: 'text', text: line }] });
    i++;
  }
  return { type: 'doc', version: 1, content };
}

/** Flatten ADF to plain text (for story descriptions). */
function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  const inner = (node.content || []).map(adfToText).join(node.type === 'doc' || node.type === 'bulletList' || node.type === 'orderedList' ? '\n' : '');
  if (node.type === 'listItem') return '- ' + inner;
  if (['paragraph', 'heading', 'codeBlock'].includes(node.type)) return inner + '\n';
  return inner;
}

function splitAcceptance(description) {
  const text = description || '';
  const m = text.match(/(acceptance criteria|a\/c|ac)\s*[:\n]([\s\S]*)/i);
  return m ? m[2].trim() : '';
}

class JiraConnector {
  constructor(project) {
    this.project = project;
    this.kind = 'live';
    this.creds = jiraCredentials(project.jiraCredentialRef);
    this.baseUrl = String(project.jiraUrl || '').replace(/\/$/, '');
  }

  get available() { return Boolean(this.creds && this.baseUrl); }

  unavailableExplanation() {
    return {
      code: 'JIRA_NOT_CONFIGURED', title: 'Jira connection is unavailable for this project',
      cause: !this.baseUrl ? 'The project has no Jira URL configured.' : 'No Jira API credentials found (JIRA_EMAIL / JIRA_API_TOKEN or a project-specific prefix).',
      action: 'Set the Jira URL in project configuration and add JIRA_EMAIL / JIRA_API_TOKEN to .env, then restart.', category: 'configuration', evidence: [],
    };
  }

  async call(method, path, body) {
    if (!this.available) throw new ConnectorError(this.unavailableExplanation());
    const url = `${this.baseUrl}${path}`;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${this.creds.email}:${this.creds.token}`).toString('base64'),
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      throw new ConnectorError(explainNetworkError(e, url));
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 500) }; }
    if (!res.ok) {
      const msgs = json && (json.errorMessages || []).concat(Object.entries(json.errors || {}).map(([k, v]) => `${k}: ${v}`));
      const ex = explainResponse({ status: res.status, body: msgs && msgs.length ? [{ errorCode: `JIRA_${res.status}`, message: msgs.join('; ') }] : json, method, url });
      if (res.status === 401) ex.cause = 'The Jira email/API token pair was rejected.';
      if (res.status === 403) ex.cause = 'The Jira user lacks permission in this project (Browse/Create/Edit/Link issues).';
      throw new ConnectorError({ ...ex, title: `Jira ${method} ${path.split('?')[0]} failed: ${ex.title}` });
    }
    return json;
  }

  mapIssue(i) {
    const f = i.fields || {};
    const description = typeof f.description === 'object' ? adfToText(f.description) : (f.description || '');
    const sprintField = f[config.jira.sprintField];
    const sprint = Array.isArray(sprintField) && sprintField.length ? sprintField[sprintField.length - 1].name : null;
    return {
      key: i.key, summary: f.summary, description, acceptanceCriteria: splitAcceptance(description),
      issueType: f.issuetype && f.issuetype.name, status: f.status && f.status.name, priority: f.priority && f.priority.name,
      labels: f.labels || [], components: (f.components || []).map((c) => c.name), assignee: f.assignee && f.assignee.displayName,
      sprint, url: `${this.baseUrl}/browse/${i.key}`,
    };
  }

  async searchStories({ jql, maxResults = 50 } = {}) {
    const q = jql || `project = "${this.project.jiraProjectKey}" AND issuetype in (Story, Task, Bug) ORDER BY updated DESC`;
    const fields = ['summary', 'description', 'issuetype', 'status', 'priority', 'labels', 'components', 'assignee', config.jira.sprintField].join(',');
    const data = await this.call('GET', `/rest/api/3/search/jql?jql=${encodeURIComponent(q)}&maxResults=${maxResults}&fields=${encodeURIComponent(fields)}`);
    return (data.issues || []).map((i) => this.mapIssue(i));
  }

  async getIssue(key) {
    if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) throw new ConnectorError({ code: 'INVALID_KEY', title: `"${key}" is not a valid Jira issue key`, cause: 'Issue keys look like PROJ-123.', action: 'Correct the issue key.', category: 'test design', evidence: [] });
    const data = await this.call('GET', `/rest/api/3/issue/${key}?fields=summary,description,issuetype,status,priority,labels,components,assignee,${config.jira.sprintField}`);
    return this.mapIssue(data);
  }

  async createDefect(d) {
    const fields = {
      project: { key: this.project.jiraProjectKey },
      issuetype: { name: config.jira.defectIssueType },
      summary: maskText(d.summary).slice(0, 250),
      description: toAdf(d.description),
      labels: (d.labels || []).map((l) => String(l).replace(/\s+/g, '-')),
    };
    if (d.priority) fields.priority = { name: d.priority };
    if (d.components && d.components.length) fields.components = d.components.map((name) => ({ name }));
    if (d.assigneeAccountId) fields.assignee = { accountId: d.assigneeAccountId };
    const created = await this.call('POST', '/rest/api/3/issue', { fields });
    return { key: created.key, url: `${this.baseUrl}/browse/${created.key}` };
  }

  async updateIssue(key, { summary, description, labels, priority }) {
    const fields = {};
    if (summary) fields.summary = maskText(summary);
    if (description) fields.description = toAdf(description);
    if (labels) fields.labels = labels;
    if (priority) fields.priority = { name: priority };
    await this.call('PUT', `/rest/api/3/issue/${key}`, { fields });
    return { key };
  }

  async addComment(key, text) {
    await this.call('POST', `/rest/api/3/issue/${key}/comment`, { body: toAdf(text) });
    return { key };
  }

  async linkIssues(inwardKey, outwardKey, type = config.jira.linkType) {
    await this.call('POST', '/rest/api/3/issueLink', { type: { name: type }, inwardIssue: { key: inwardKey }, outwardIssue: { key: outwardKey } });
    return { linked: true };
  }

  async addLabels(key, labels) {
    await this.call('PUT', `/rest/api/3/issue/${key}`, { update: { labels: labels.map((l) => ({ add: l })) } });
  }

  async getStatus(key) {
    const data = await this.call('GET', `/rest/api/3/issue/${key}?fields=status,resolutiondate`);
    return { status: data.fields.status && data.fields.status.name, category: data.fields.status && data.fields.status.statusCategory && data.fields.status.statusCategory.key, resolvedAt: data.fields.resolutiondate || null };
  }

  async testConnection() {
    const me = await this.call('GET', '/rest/api/3/myself');
    const proj = this.project.jiraProjectKey ? await this.call('GET', `/rest/api/3/project/${this.project.jiraProjectKey}`) : null;
    return { ok: true, user: me.displayName, project: proj && proj.name };
  }
}

module.exports = { JiraConnector, toAdf, adfToText, splitAcceptance };
