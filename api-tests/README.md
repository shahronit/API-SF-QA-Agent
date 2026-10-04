# api-tests — CI-ready Salesforce API automation

This folder holds automation assets exported from the QA platform and the scripts that run them locally or in CI.

```
api-tests/
├── collections/    Postman v2.1 collections (one per project)
├── environments/   Postman environments — secret values are always empty
├── test-data/      Datasets exported from the Test Data manager
├── schemas/        OpenAPI / Swagger / JSON Schema contracts
├── scripts/
│   ├── run-suite.js      Run tests through the platform API → JUnit + JSON summary
│   ├── run-newman.js     Run a collection with Newman, credentials injected from env vars
│   └── export-assets.js  Refresh collections, environments, data and schemas from the platform
├── reports/        JUnit, JSON and HTML reports (git-ignored)
└── config/         Per-project settings without secrets
```

## Two ways to run

**1. Through the platform (recommended for CI).** The platform holds the approved tests, executes them with dependency resolution, Salesforce data validation, contract checks and automatic cleanup, and keeps history and traceability.

```bash
npm start                                   # in the repository root
node api-tests/scripts/run-suite.js --project PRJ-001 --priority P0,P1 --junit api-tests/reports/junit.xml
```

Exit codes: `0` all passed, `1` failures, `2` bad arguments, `3` platform rejected the run (the message includes cause and recommended action), `4` timeout.

**2. Standalone with Newman.** Useful for teams that already use Postman.

```bash
cd api-tests && npm install
export SF_BASE_URL=https://your-org--qa.sandbox.my.salesforce.com
export SF_CLIENT_ID=…  SF_CLIENT_SECRET=…    # from your secret manager, never committed
npm run test:qa
```

The collection's pre-request script exchanges `{{clientId}}` / `{{clientSecret}}` for `{{accessToken}}` (OAuth client credentials). Requests use `{{baseUrl}}`, `{{accessToken}}` and `{{recordId}}`-style variables only — no hardcoded secrets. `run-newman.js` writes the secrets to a temporary environment file (mode 600) that is deleted after the run; the HTML report is generated with sensitive data and the `Authorization` header skipped.

## Production

The platform treats Production as read-only. `run-suite.js --read-only` runs only non-modifying tests; the script never confirms production writes on your behalf. Cleanup of test data never runs in Production.

## Refreshing assets

```bash
QA_PLATFORM_URL=http://127.0.0.1:4317 node api-tests/scripts/export-assets.js --project PRJ-001
```
