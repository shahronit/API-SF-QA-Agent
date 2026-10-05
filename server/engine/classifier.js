'use strict';
/**
 * Ticket relevance classifier: decides whether a Jira ticket plausibly needs
 * Salesforce API testing at all, before any test generation happens.
 *
 * This is a heuristic gate, not a verified fact about the ticket's intent —
 * the result is always labelled ASSUMED. It is deliberately conservative in
 * one direction only: low/medium confidence never blocks generation, it only
 * adds a note. Generation is paused for review solely when the signal that
 * API testing is NOT needed is strong (confidence 'high'), and even then the
 * user can override with a single word ("anyway").
 */

// Signals that the ticket is about an API, integration or record-level operation.
const API_SIGNALS = [
  [/\b(api|rest|soap|graphql|endpoint|webhook|callout)\b/i, 'mentions an API, webhook or callout'],
  [/\b(apex\s*rest|apexrest|apex\s*soap|platform\s*event(s)?|change\s*data\s*capture|\bcdc\b|bulk\s*api|bulk\s*2\.0|composite\s*api|composite\s*graph|connect\s*rest|tooling\s*api|metadata\s*api)\b/i, 'names a specific Salesforce API'],
  [/\b(oauth|access\s*token|client\s*credentials|jwt\s*bearer|session\s*id|refresh\s*token)\b/i, 'involves authentication/authorization mechanics'],
  [/\b(sync|synchroni[sz]e|upsert|external\s*id|data\s*migration|batch\s*load|csv\s*load|bulk\s*load)\b/i, 'describes data synchronization or migration'],
  [/\b(integration|middleware|mulesoft|boomi|informatica|inbound|outbound)\b/i, 'describes a system integration'],
  [/\b(third[- ]party|external\s*system|erp|sap\b|payment\s*gateway|stripe|subscription\s*billing|shipping\s*provider)\b/i, 'integrates with an external system'],
  [/\b(create|update|delete|insert|upsert|query|retrieve|fetch)\w*\b.{0,30}\b(record|account|contact|lead|opportunity|case|order|contract|invoice|quote|asset|subscription)\b/i, 'describes record-level CRUD operations'],
  [/\b(trigger|flow)\b.{0,30}\b(callout|http|rest|api)\b/i, 'describes automation making an HTTP callout'],
];

// Signals that the ticket is purely cosmetic/content and unlikely to need API testing.
const UI_ONLY_SIGNALS = [
  [/\b(css|stylesheet|font(\s*size)?|colou?r\s*scheme|icon|button\s*style|spacing|padding|margin|alignment)\b/i, 'only visual/styling changes'],
  [/\b(page\s*layout|lightning\s*page|record\s*page\s*layout|list\s*view\s*columns?|related\s*list\s*order|compact\s*layout)\b/i, 'only layout/arrangement changes'],
  [/\b(label|translation|wording|copy\s*change|help\s*text|tooltip\s*text|placeholder\s*text)\b/i, 'only label/copy wording changes'],
  [/\b(training|documentation|runbook|release\s*notes?)\s*(only|update)\b/i, 'documentation/training only'],
  [/\b(report\s*folder|dashboard\s*(layout|theme)|report\s*chart\s*(colou?r|style))\b/i, 'reporting cosmetics only'],
  [/\b(sharing\s*rule|permission\s*set)\s*(label|description)\s*(only|update)\b/i, 'metadata label change only'],
];

function storyText(story) {
  const parts = [
    story.summary, story.description, story.acceptanceCriteria,
    Array.isArray(story.components) ? story.components.join(' ') : story.components,
    Array.isArray(story.labels) ? story.labels.join(' ') : story.labels,
  ];
  return parts.filter(Boolean).join('\n');
}

/**
 * @param {object} story { summary, description, acceptanceCriteria, components, labels }
 * @returns {{needsApiTesting: boolean, confidence: 'high'|'medium'|'low', reasons: string[], signals: {api: string[], uiOnly: string[]}, label: 'ASSUMED'}}
 */
function classifyStory(story) {
  const text = storyText(story || {});
  const apiHits = API_SIGNALS.filter(([rx]) => rx.test(text)).map(([, why]) => why);
  const uiHits = UI_ONLY_SIGNALS.filter(([rx]) => rx.test(text)).map(([, why]) => why);
  const hasWords = /\w{4,}/.test(text);

  let needsApiTesting;
  let confidence;
  const reasons = [];

  if (apiHits.length) {
    needsApiTesting = true;
    confidence = apiHits.length >= 2 ? 'high' : 'medium';
    reasons.push(`The ticket ${apiHits.slice(0, 3).join('; ')}.`);
  } else if (uiHits.length && hasWords) {
    needsApiTesting = false;
    confidence = uiHits.length >= 2 ? 'high' : 'medium';
    reasons.push(`The ticket appears to involve ${uiHits.slice(0, 3).join('; ')}, with no API, integration or record-operation language detected.`);
  } else if (!hasWords) {
    needsApiTesting = true;
    confidence = 'low';
    reasons.push('The ticket has little or no description text to classify; defaulting to proposing API coverage for review.');
  } else {
    needsApiTesting = true;
    confidence = 'low';
    reasons.push('No clear API, integration or UI-only signal was found in the ticket text; defaulting to proposing API coverage for review.');
  }

  return {
    needsApiTesting,
    confidence,
    reasons,
    signals: { api: apiHits, uiOnly: uiHits },
    label: 'ASSUMED',
  };
}

module.exports = { classifyStory, API_SIGNALS, UI_ONLY_SIGNALS };
