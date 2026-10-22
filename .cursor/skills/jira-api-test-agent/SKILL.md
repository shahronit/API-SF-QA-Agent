---
name: jira-api-test-agent
description: Turns a Jira story plus an integration document into API tests in this Salesforce QA platform — generate, approve, run, verify responses. Use when the user mentions Jira stories, integration docs, generating API tests, Cursor/Gemini CLI generation, or reducing manual API test authoring.
---

# Jira story + doc → in-app API tests

Drive **this application** (`API Testing Agent/`). Do not create a parallel Postman-only test world. Another agent may be editing Postman feature-gap files; do not touch those.

## When to use

User wants an agent to: take a Jira issue + spec/doc, generate API tests, run them, and verify responses.

## Topology (do not substitute)

| Layer | Use for |
|---|---|
| In-app `generateSuite` + runner | Executable baseline and pass/fail |
| In-app Cursor CLI (`agent`) | Extra scenarios from story + `context_docs` |
| In-app Gemini CLI | Fallback overlay if Cursor is not logged in |
| Cursor IDE Agent (you) | Config, ingest docs, call HTTP APIs, implement glue tickets |
| Gemini Cursor subagent | Planning only — not runtime generation |
| Anthropic `ANTHROPIC_API_KEY` | Optional RECOMMENDED coverage strings |

The app **rejects** Cursor/Gemini API keys. Login: `agent login` / Gemini “Sign in with Google”.

## Operator sequence

1. Confirm project on `http://127.0.0.1:4317` (Jira URL/key, SF or demo, `scriptGenerator=auto`).
2. Sync or fetch the story: `POST /api/stories/sync` or `GET /api/stories/:key?refresh=true`.
3. Add the integration doc: `POST /api/projects/:id/context-docs` with `{ name, body }` or `{ name, filePath }` (local path only; no `https://`).
4. Optional: upload OpenAPI to contracts / `POST /api/projects/:id/endpoints/from-openapi`.
5. Generate: `POST /api/generate` `{ "storyKey": "PROJ-123", "inputSource": "jira" | "docs" | "jira+docs", "docIds": [] }`. `docs` uses integration documents only (`storyKey` optional — stored on `DOC` if omitted). `jira` ignores docs. `jira+docs` combines both. Or `POST /api/stories/plan-from-docs`. Uses Cursor CLI if enabled+logged in, else Gemini CLI, else engine. Response includes `analysis.generator`, `analysis.inputSource` and `analysis.traceability`.
   Delete tests: `DELETE /api/testcases/:id`, bulk `{ ids, delete: true }`, or `DELETE /api/stories/:key/tests?projectId=`. Delete a project: `DELETE /api/projects/:id` (purge). Archive: `DELETE /api/projects/:id?archive=true`.
6. **Stop for human approve:** `POST /api/proposals/:id/approve` with optional `selected`, `postToJira`, `runNow`, `postResultToJira`. Never auto-approve.
7. Run: `POST /api/runs` (or agent `Run only P0 and P1`). Optional `postResultToJira` posts a pass/fail comment after the run — not a defect. Executor: platform / Postman MCP / Playwright MCP.
8. Verify: assertions + `sfValidation`. Report: `/api/reports/:runId` (includes traceability for single-story runs). Defects: preview then create — never auto-file.
9. Regressions: `GET /api/runs/:id/compare` (newly failing / fixed / slower / flaky vs the previous run) and `GET /api/runs/:id/gate?minPassRate=95&maxNewFailures=0` for CI exit criteria. Treat failures of flaky tests as unconfirmed. Unmapped AC are listed in `analysis.traceability.acUnmapped` — add tests for them before approving.

## Output contract

CLI/LLM must return JSON only. Parsed by `unwrapCliJson` / `normalizeTestCase` in `server/engine/cli-generator.js`.

Required per test case: `title`, `method`, `endpoint` (path starting `/` after Salesforce normalize), `assertions` with `type` in `status | jsonpath | header | responseTime | sfError | schema | bodyContains`. Optional: `body`, `query`, `extract`, `sfValidation`, `cleanup`, `auth` (`default|none|invalid|lowpriv`), `object`, `testType`, `priority`.

Unknown sObjects are **dropped**. Unknown `__c` body fields → label **RECOMMENDED**. Do not emit secrets.

## Labels

- **VERIFIED** — live describe or live org check
- **ASSUMED** — heuristics, demo, CLI, chat parse
- **RECOMMENDED** — AI extras

## Guardrails

- Production: `checkOperation` requires confirmations; generated prod suites are read-only.
- `sync-and-generate` `approve` flag is a documented no-op (`approveIgnored`). GitHub workflow `sync-and-generate.yml` is generate-only.
- Ad-hoc chat tests (`Test creating a Contact without a LastName`) skip proposal; story suites must not.

## Phase 0 config (no code)

`.env`: `JIRA_EMAIL`, `JIRA_API_TOKEN`, optional `CURSOR_CLI_ENABLED=true` / `GEMINI_CLI_ENABLED=true`. Not `GEMINI_API_KEY` in this app.
