'use strict';
/**
 * Opt-in Jira *result* comment after a run completes.
 * Pass/fail counts only. Never creates defects.
 */
const { repo, now, audit } = require('../db');
const { jiraFor } = require('../connectors');

function wantsResultComment(project, run) {
  const opts = (run && run.options) || {};
  if (opts.postResultToJira) return true;
  const ic = (project && project.integrationConfig) || {};
  const nc = (project && project.notificationConfig) || {};
  return Boolean(ic.postResultToJira || nc.postResultToJira);
}

function commentBody(run, { reportPath }) {
  const lines = [
    `API test run ${run.id} ${run.status}.`,
    '',
    `- Passed: ${run.passed || 0}`,
    `- Failed: ${run.failed || 0}`,
    `- Blocked: ${run.blocked || 0}`,
    `- Skipped: ${run.skipped || 0}`,
    `- Total: ${run.total || 0}`,
  ];
  if (reportPath) lines.push('', `Report: ${reportPath}`);
  lines.push('', 'This is a result comment only. No Jira defect was created automatically.');
  return lines.join('\n');
}

async function maybeComment(runId) {
  const run = repo.get('runs', runId);
  if (!run || run.status === 'running') return null;
  const project = repo.get('projects', run.projectId);
  if (!project || !wantsResultComment(project, run)) return null;
  if ((run.jiraActivity || []).some((a) => a.action === 'run.result-commented')) return { skipped: 'already-posted' };
  const fromOpts = ((run.options && run.options.storyKeys) || []).filter(Boolean);
  const fromResults = repo.find('run_results', 'runId = $r', { r: run.id }).map((r) => r.storyKey).filter(Boolean);
  const storyKeys = [...new Set([...fromOpts, ...fromResults])].slice(0, 20);
  if (!storyKeys.length) return { skipped: 'no-story' };
  const conn = jiraFor(project);
  const reportPath = `/execution/${run.id}`;
  const activity = [...(run.jiraActivity || [])];
  if (!conn.available) {
    activity.push({ ts: now(), user: run.user, action: 'run.result-comment-skipped', detail: conn.unavailableExplanation() });
    repo.update('runs', run.id, { jiraActivity: activity });
    return { ok: false, ...conn.unavailableExplanation() };
  }
  const posted = [];
  for (const key of storyKeys) {
    try {
      await conn.addComment(key, commentBody(run, { reportPath }));
      posted.push(key);
      activity.push({ ts: now(), user: run.user, action: 'run.result-commented', detail: { key, runId: run.id } });
      audit('jira', 'run.result-commented', { user: run.user, projectId: project.id, detail: { key, runId: run.id } });
    } catch (e) {
      activity.push({
        ts: now(), user: run.user, action: 'run.result-comment-failed',
        detail: { key, title: (e.explanation && e.explanation.title) || e.message },
      });
    }
  }
  repo.update('runs', run.id, { jiraActivity: activity });
  return { ok: posted.length > 0, posted };
}

module.exports = { maybeComment, wantsResultComment, commentBody };
