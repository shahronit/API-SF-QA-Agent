# Salesforce API QA Platform

An enterprise QA automation platform for Salesforce APIs. It takes a Jira story, classifies on its own whether the ticket actually needs API testing, analyses it against Salesforce metadata, proposes functional, negative, boundary, security and integration API tests for human review, executes the approved tests in the background with live status, validates the persisted Salesforce data field by field, drafts Jira defects for review (never automatically), and produces PDF, Excel, CSV and HTML reports with full traceability from story to defect. An agent chat console also builds and runs one-off scenario tests from a plain-language prompt (e.g. "Test creating a Contact without a LastName") on demand, under the same safety and masking rules as everything else.

It runs on **Node.js 22.5+ with zero runtime dependencies** — no `npm install` needed for the platform itself.

## Quick start

```bash
cp .env.example .env        # optional for demo mode; required for real orgs
npm start                   # http://127.0.0.1:4317
```

On first start the server seeds five demo projects — Acme Sales Cloud (QA), Acme Service Cloud (UAT), Acme Production Smoke (read-only Production), Globex Commerce (an unconfigured live SIT project), and Northwind Retail — Order Management (Development) — with 13 realistic Jira stories (contact/lead/invoice sync, a Stripe payment webhook, duplicate-prevention rules, a Bulk API 2.0 migration job, Platform Event fan-out, wholesale onboarding), approved suites, 14 days of execution history and two defects. Demo mode uses a built-in Salesforce simulator and a local Jira simulator, so every workflow works without credentials. The demo deliberately contains four realistic defects (a flow overwriting `Account.Rating`, an Apex REST 500 on duplicate invoices, a slow Case SOQL breaching the SLA, and a lead endpoint that drops `LeadSource`) so failure analysis, data validation and defect drafting have something real to show.

| Command | Purpose |
| --- | --- |
| `npm start` | Start the platform |
| `npm run dev` | Start with auto-reload |
| `npm run seed` | Reset the database and re-seed demo data |
| `npm test` | Unit and API tests (`node:test`) |
| `npm run test:ui` | Headless UI smoke test of every page and key interactions |
| `npm run snapshot` | Build read-only single-file HTML snapshots in `docs/snapshots/` |

## Connecting a real Salesforce org and Jira

Credentials never go into the UI, the database, logs, reports or Jira. Each project stores only a **credential prefix**; the server reads secrets from environment variables (or whatever your secret manager injects into them):

```bash
SF_ACME_QA_AUTH_FLOW=client_credentials      # or jwt | refresh_token
SF_ACME_QA_LOGIN_URL=https://acme--qa.sandbox.my.salesforce.com
SF_ACME_QA_CLIENT_ID=…
SF_ACME_QA_CLIENT_SECRET=…
JIRA_EMAIL=…            JIRA_API_TOKEN=…
```

Create a project under **Projects → New project**, choose **Live** mode, set the environment, instance URL, API version and the prefix (`ACME_QA` above), then open **Connections → Test connections**. The Connections tab shows only whether each variable is set. An optional `_LOWPRIV_` credential set enables authorization, FLS and record-access tests.

When Salesforce is not reachable or not configured, the platform says so explicitly — *"Salesforce MCP is unavailable. API test design and automation generation are available, but live Salesforce validation is disabled."* — and keeps design and automation features working.

## How the workflow fits together

1. **Stories** — sync from Jira (JQL) or add manually. Every story is automatically classified (needs API testing: yes/no, with confidence and reasons) so you don't spend review time on UI-only or documentation tickets; the classification is always labelled ASSUMED and is advisory, not a hard block — "Analyze anyway" is one click away.
2. **Generate** — the engine detects objects, fields, operations and integrations, reads metadata (live describe = VERIFIED, simulator or heuristics = ASSUMED), and proposes scenarios with P0–P3 priorities scored on seven factors.
3. **Review and approve** — choose which tests to keep. Posting a coverage comment to Jira is a separate, explicit opt-in.
4. **Execute** — runs in the background; the run ribbon fills cell by cell over server-sent events. Upstream setup tests that produce required variables are pulled in automatically; created records are cleaned up afterwards (never in Production).
5. **Validate** — each write is re-read from Salesforce and compared field by field with what was sent.
6. **Analyse and raise defects** — failures are categorised with root cause, evidence and recommended action. A defect is created only after you review the masked preview and click **Create Jira defect**; it is then linked to the story and its key stored on the result.
7. **Report and automate** — export reports, Postman collections and environments, and run the suite in CI.

Outside that story-driven flow, the **Agent console** also takes a one-line, plain-language scenario — "Verify Account rejects a value over the maximum field length", "Test querying Account without an access token" — and builds, safely executes and reports back on exactly that single test on demand, reusing the same priority scoring, production-safety confirmations, masking and defect-preview flow as everything else. Every ad hoc test is saved as a reusable test case (tagged `chat-generated`) and labelled ASSUMED, since it comes from a heuristic parse of free text rather than a reviewed proposal.

## Safety model

Production projects are read-only by default. Any modifying request shows *"This operation will modify Salesforce production data."* and requires typing a confirmation; DELETE needs a second confirmation. Generated suites for Production contain read-only smoke tests only, and test data is never created or deleted automatically there. Mutating API calls must be JSON (CSRF guard), responses pass through a masking layer (passwords, access/refresh tokens, client secrets, session IDs, JWTs, Jira tokens), and the UI is served with a strict Content Security Policy. Provenance labels — VERIFIED, ASSUMED, RECOMMENDED — keep assumptions from being presented as verified Salesforce facts; marking a test VERIFIED requires explicit confirmation.

The server binds to `127.0.0.1` by default and trusts `X-Forwarded-User` for the audit identity. To share it with a team, put it behind an authenticating reverse proxy (SSO) rather than exposing the port directly.

## Project layout

```
server/            HTTP server, routes, engines and connectors (no dependencies)
  connectors/      Salesforce (OAuth, REST, SOQL, describe), Jira Cloud v3, demo simulators
  engine/          generator, priority, runner, assertions, validator, analyzer, defects,
                   contracts, postman, reports, safety, optional AI
  lib/             masking, error explanations, templating, JSON Schema, YAML, ZIP/XLSX/PDF writers
  routes/          REST API (see docs/API.md)
public/            Single-page app (vanilla JS, SVG charts, light and dark themes)
api-tests/         CI-ready automation: collections, environments, data, schemas, scripts, reports
scripts/           Snapshot builder and headless UI smoke test
.github/workflows/ GitHub Actions pipeline
docs/              API reference and UI snapshots
```

## Supported Salesforce APIs

REST, SOAP (partner/enterprise and Apex SOAP), Bulk API and Bulk API 2.0, Composite, Composite Graph, sObject Collections, GraphQL, Tooling, Metadata, Connect REST, Apex REST, Platform Events, Change Data Capture (via Pub/Sub API guidance), OAuth endpoints, and custom integration APIs configured per project. The API explorer has a template for each.

### Coverage by API family

Story text selects the API families to test; each generates executable cases (all labelled ASSUMED in demo mode, VERIFIED only from a live describe):

| Family | Generated coverage |
|---|---|
| REST / sObject | CRUD, negative, boundary, FLS/low-privilege, upsert insert/update idempotency, pagination (`nextRecordsUrl`, consumed locator) |
| Bulk API 2.0 | Job lifecycle (create, CSV upload, close, poll, `successfulResults` / `failedResults` / `unprocessedrecords`), partial-success CSV, wrong `Content-Type` (415), abort, upsert idempotency, per-record cleanup (`cleanup.fromBulkResults`) |
| Composite / Graph / Collections | `allOrNone` rollback with `PROCESSING_HALTED`, reference resolution, 25-subrequest limit, duplicate `referenceId`, 200/201-record collections |
| GraphQL | UI API query shape, filters, `first`/`after` paging, validation errors, FLS-hidden fields |
| SOAP / Tooling | login, query, `getServerTimestamp`, `INVALID_SESSION_ID` fault (HTTP 500), `INVALID_FIELD`, Tooling `INVALID_TYPE` / `MALFORMED_QUERY` |
| OAuth / Connect / Platform Events | grant-type and client validation, `userinfo`, Chatter current user, event publish with and without required fields (subscriber delivery is flagged as not verifiable over REST) |

Assertion types: `status`, `jsonpath`, `header`, `responseTime`, `sfError`, `schema`, `bodyContains` and `csv` (`rows`, `header`, `column:<name>`). Tests tagged `poll` are retried on live orgs until their assertions pass (async Bulk jobs). Run-scoped values (`{{runId}}`) get a per-generation suffix so two stories on one object never collide in a combined regression run. Cleanup supports `idVar`, `fromResponse`, `fromCompositeResponse` and `fromBulkResults`.

### Failure analysis

Every failure is classified into one of the plan's eleven classes — Test Data, Authentication, Authorization, API Contract, Salesforce Configuration, Salesforce Automation, Integration, Application Defect, Environment, Performance, External Dependency — and carries failure, evidence, root cause, impact, recommendation and retest steps. Policy blocks (for example production write protection) are not failures. Reports (JSON, CSV, HTML, XLSX, PDF) include a Risks section and the Postman/Newman automation assets.

### Test data categories

Positive, Negative, Boundary, Security (hostile string probes), Integration, Bulk (CSV template), Regression and Performance.

### Simulator fidelity

The demo simulator follows real Salesforce semantics for the families above (Bulk 2.0 per-record results, composite rollback, GraphQL validation, SOAP faults as HTTP 500). Intentional differences: Bulk `batchSize` is accepted from 1 to 2000 (real orgs clamp to 200–2000), and nothing here replaces a run against a real org.

## Notes and limits

The Express/React stack in the original brief was replaced by built-in Node modules and a framework-free front end because the package registry was not reachable from the build environment; the API surface and features are the same. Newman is the only optional dependency and lives in `api-tests/package.json`. The demo simulator implements a realistic subset of Salesforce behaviour; anything it reports is labelled ASSUMED until re-run against a live org.
