# REST API reference

Base URL `http://127.0.0.1:4317`. All responses are JSON and pass through the masking layer. Requests that change state must send `Content-Type: application/json` (CSRF guard). Errors always have the shape:

```json
{ "error": "What happened", "status": 409, "cause": "Possible cause", "evidence": ["…"], "action": "Recommended action", "code": "OPTIONAL_CODE" }
```

List endpoints accept `page`, `pageSize` (≤ 200), `sort`, `dir` (`ASC|DESC`) and `q`, and return `{ items, page, pageSize, total, pages }`. Most project-scoped endpoints take `projectId` as a query parameter. The audit identity comes from `X-Forwarded-User` (falls back to `APP_USER`).

## Platform and projects

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | Liveness and version |
| GET | `/api/meta` | Environments, API types, test types, priorities, agent modes, workflow steps, current user |
| GET | `/api/projects/:id/workflow` | Persisted QA lifecycle (4 stages: Connect, Create tests, Run, Report) |
| PUT | `/api/projects/:id/workflow` | Restore/visit a stage `{ currentStep }`. Legacy 13-step ids still resolve. |
| GET | `/api/projects/:id/jira/options` | Epics, sprints, issue types and stories for requirement picking |
| GET | `/api/projects/:id/postman/collections` | Discover existing Postman collections (MCP, local files, generated) |
| POST | `/api/projects/:id/postman/analyze` | Compare workspace collections with required coverage (reuse before create) |
| POST | `/api/projects/:id/postman/proposals` | Queue a collection update for approval |
| POST | `/api/projects/:id/postman/proposals/:pid/approve` | Apply collection changes only after review |
| POST | `/api/projects/:id/postman/create` | Create a new collection when none is suitable |
| GET | `/api/projects` | Projects with stats and connection status (`includeArchived=true`) |
| POST | `/api/projects` | Create. Rejects secret-looking fields; credentials are referenced by `credentialRef` prefix |
| GET/PUT/DELETE | `/api/projects/:id` | Read, update, archive |
| GET | `/api/projects/:id/connection` | Connection config plus which credential variables are set (booleans only). Includes Salesforce MCP URL/command presence, Jira, Commerce Cloud, and `loopback` |
| PUT | `/api/projects/:id/connection` | Save non-secret connection config: Salesforce org (`instanceUrl`, `apiVersion`, `mode`, `credentialRef`), MCP (`salesforceMcp.url` / `command`), Jira site/project/JQL, Commerce Cloud (`enabled`, host, site/org/shortCode) |
| POST | `/api/projects/:id/connection/secrets` | Loopback-only: write Salesforce / Jira / Commerce Cloud secrets into local `.env` (never stored in the database or returned to the browser) |
| POST | `/api/projects/:id/connection/test` | Test Salesforce org or MCP, Jira (`/myself`), and Commerce Cloud (OCAPI/SCAPI product search when enabled) |
| GET | `/api/projects/:id/sobjects` | Describe global (labelled VERIFIED or ASSUMED) |
| GET | `/api/projects/:id/sobjects/:name` | Describe one object (10-minute cache, `refresh=true`) |
| POST | `/api/projects/:id/soql` | Read-only single `SELECT` |
| GET | `/api/search?q=` | Global search: stories, tests, runs, endpoints, defects, saved requests, objects |
| GET | `/api/audit` | Audit log (`category`, `q`) |

## Stories, generation and traceability

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/stories` | Stories with coverage (`sprint`, `status`, `q`). Each story includes a `classification` (`needsApiTesting`, `confidence`, `reasons`, label `ASSUMED`) — a heuristic, advisory read on whether the ticket plausibly needs API testing at all |
| POST | `/api/stories/sync` | Pull stories from Jira (`{ jql? }`). Read-only for Jira |
| POST | `/api/stories/sync-and-generate` | Sync from Jira then propose API test scripts for tickets that need coverage (`{ jql?, onlyNeedingApi? }`). Returns `{ synced, selected, skipped, proposals, errors }` — nothing is approved until review |
| POST | `/api/stories` | Add a story manually |
| GET | `/api/stories/:key` | Story with scenarios, tests, defects, proposals (`refresh=true` re-reads Jira) |
| POST | `/api/generate` | `{ storyKey }` → proposal with analysis (including `classification`) and scenarios. Generation always proceeds regardless of classification; nothing is saved as tests yet |
| GET | `/api/proposals`, `/api/proposals/:id` | Proposal history / detail |
| POST | `/api/proposals/:id/approve` | `{ selected?: {scenarioIndex: [testIndex]}, postToJira?: boolean }`. Jira is changed only when `postToJira` is true |
| POST | `/api/proposals/:id/reject` | Reject a proposal |
| GET | `/api/traceability` | Metrics and the story → scenario → test → execution → defect tree |
| POST | `/api/regression/impact` | `{ storyKey?, objects?, endpoints? }` → ranked impacted tests (RECOMMENDED) |

## Scenarios and test cases

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/scenarios` | Filter by `type`, `priority`, `storyKey`, `apiType`, `status` |
| PUT/DELETE | `/api/scenarios/:id` | Update priority/status/title, or delete with its tests |
| GET | `/api/testcases` | Filter by `priority`, `testType`, `apiType`, `status`, `label`, `lastResult`, `storyKey`, `scenarioId`, `method`, `tag`, `from`, `to` |
| POST | `/api/testcases` | Create. Priority is calculated when omitted. `Authorization` headers are rejected |
| GET/PUT/DELETE | `/api/testcases/:id` | Read (with history and defects), update, delete. Setting `label: VERIFIED` requires `confirmVerified: true` |
| POST | `/api/testcases/:id/duplicate` | Copy a test case |
| POST | `/api/testcases/bulk` | `{ ids, priority?, status?, testType?, delete? }` |
| POST | `/api/testcases/:id/automate` | Postman item and Newman / Node commands for one test |
| GET | `/api/insights` | Endpoints above a failure-rate threshold (`failureRate`), duplicates, coverage gaps |

## Execution

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/runs` | Start a run: `{ testCaseIds?, filter?: {priority, testType, storyKey, apiType, lastResult, tag}, mode?: "failed", fromRunId?, resolveDependencies?, label?, trigger?, executor?: "playwright"\|"postman"\|"platform"\|"auto", confirmProductionWrites?, confirmDelete?, skipWrites? }`. In Production, returns `409 PRODUCTION_CONFIRMATION_REQUIRED` / `PRODUCTION_DELETE_CONFIRMATION_REQUIRED` until confirmed, or use `skipWrites` for read-only |
| GET | `/api/runs` | Run history (`status`, `environment`, `from`, `to`, `q`) |
| GET | `/api/runs/:id` | Run with counts, summary, created records, Jira activity, `active` |
| GET | `/api/runs/:id/results` | Results (`status`, `priority`, `testType`, `q`) |
| GET | `/api/runs/:id/stream` | Server-sent events: `snapshot`, `run-start`, `test-start`, `test-result`, `notice`, `stopping`, `cleanup-start`, `run-end` |
| POST | `/api/runs/:id/stop` | Stop after the current test |
| GET | `/api/runs/:id/analysis` | Failure categories, defect candidates, hotspots, regression recommendation, AI summary |
| GET | `/api/runs/:id/compare` | Diff against `baseline` (run id, default `previous` = last finished run sharing tests): `newlyFailing`, `fixed`, `stillFailing`, `newTests`, `notRerun`, `slower` (≥50% and ≥200 ms), `flaky`, `verdict` |
| GET | `/api/runs/:id/gate` | CI quality gate: `minPassRate` (default 100), `requireP0` (default true), `maxBlocked`, `maxNewFailures`, `baseline` → `{ passed, passRate, checks[] }` |
| GET | `/api/flaky` | Tests that flipped pass↔fail at least twice across the last `window` (default 5) runs |
| GET | `/api/results/:id` | Full request, response, assertions, Salesforce validation, contract check, analysis |
| POST | `/api/explorer/execute` | Ad-hoc request `{ method, path, headers, query, body, variables, auth, apiType }` with the same production safety |
| POST | `/api/explorer/generate-test` | Draft a test case from an explorer exchange |
| GET | `/api/explorer/templates` | Request templates for every supported API type |

## Defects (Jira)

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/defects/preview` | `{ resultId }` → masked draft, existing-defect check, Jira availability. Never creates anything |
| POST | `/api/defects` | Create after review. Requires `confirmed: true`; links to the story unless `linkToStory: false` |
| GET | `/api/defects`, `/api/defects/:id` | List (`status`, `severity`, `storyKey`, `q`) / detail |
| PUT | `/api/defects/:id` | Update locally; `pushToJira: true` also requires `confirmed: true` |
| POST | `/api/defects/:id/sync` | Refresh status from Jira |

## Test data, contracts, saved requests

| Method | Path | Description |
| --- | --- | --- |
| GET/POST | `/api/testdata` | List (`category`, `object`, `storyKey`) / create |
| PUT/DELETE | `/api/testdata/:id` | Update / delete |
| POST | `/api/testdata/generate` | `{ object, category, count, storyKey? }` from the object describe |
| POST | `/api/testdata/import` | `{ format: csv|json, content, category, object? }` |
| POST | `/api/testdata/cleanup` | Preview tracked records; delete with `confirmed: true`. Disabled in Production |
| GET/POST | `/api/contracts` | List / upload OpenAPI 3, Swagger 2 (JSON or YAML) or JSON Schema |
| GET/DELETE | `/api/contracts/:id` | Operations and spec / delete |
| POST | `/api/contracts/:id/validate` | Validate a run's results (`runId`, default latest) |
| POST | `/api/contracts/:id/check` | Validate one sample response |
| GET/POST/DELETE | `/api/requests[/:id]` | Saved explorer requests |

## Reports, automation and agent

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/dashboard` | KPIs, trends, ribbon. Filters: `projectId`, `environment`, `apiType`, `testType`, `priority`, `status`, `sfOrg`, `jiraProjectKey`, `sprint`, `from`, `to` |
| GET | `/api/reports/:runId?format=json|csv|html|xlsx|pdf` | Execution report |
| GET | `/api/postman/collection` | Postman v2.1 collection (`priority`, `testType`, `ids`) |
| GET | `/api/postman/environment` | Postman environment with empty secret values |
| POST | `/api/postman/import` | `{ collection, preview?, storyKey? }` |
| POST | `/api/postman/newman` | Export and run Newman server-side in `api-tests/` |
| POST | `/api/agent/command` | `{ text, projectId, confirmProductionWrites?, confirmDelete? }` natural-language command → mode, message, data, navigation. Besides the Discover/Generate/Execute/Validate/Analyze/Defect/Regression/Report modes, a "test/try/check/verify/simulate" phrasing (e.g. "Test creating a Contact without a LastName") builds a single ad hoc test from the sentence, runs it immediately under the usual production-safety rules, saves it as a reusable test case tagged `chat-generated`, and returns the full masked `exchange` in the reply. "Analyze" requests are gated by `classification` — a story that looks like it doesn't need API testing is flagged with an explanation instead of silently generating tests; add "anyway"/"force"/"still" to the sentence to override |
