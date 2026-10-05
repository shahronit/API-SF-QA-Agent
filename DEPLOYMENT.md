# Deployment Guide

## Repository Setup

The complete Salesforce API QA Platform is ready to be pushed to GitHub.

**Repository:** `https://github.com/roshah-stack/API-Testing-Agent.git`

### Current Status
- **Commit SHA:** 46863ae
- **Branch:** master (ready to rename to main if preferred)
- **Files:** 110 total (server, frontend, tests, docs, automation framework)
- **Build:** Complete and tested

### Files Committed

```
Core Application:
  server/              — Node.js backend (zero dependencies)
  public/              — Vanilla JS SPA with SVG charts
  package.json         — Node 22.5+ required

Testing Framework:
  api-tests/           — Postman/Newman automation
  server/tests/        — 20 unit + API tests

Documentation:
  README.md            — Quick start guide
  docs/API.md          — Full endpoint reference
  WORKFLOW_GUIDE.md    — User documentation
  UI_IMPROVEMENTS.md   — Design notes
  docs/snapshots/      — Static HTML page previews

Configuration:
  .env.example         — Environment variable template
  .github/workflows/   — CI/CD pipeline (GitHub Actions)
  .gitignore           — Standard Node.js excludes
```

## Pushing to GitHub

### Option 1: Using HTTPS with Personal Access Token

```bash
cd /tmp/API-Testing-Agent  # or your local clone
git push -u origin master
# When prompted for password, use your GitHub Personal Access Token
# (Settings → Developer settings → Personal access tokens)
```

### Option 2: Using SSH Key

```bash
# Set up SSH key on GitHub first
cd /tmp/API-Testing-Agent
git remote set-url origin git@github.com:roshah-stack/API-Testing-Agent.git
git push -u origin master
```

### Option 3: Rename to `main` Branch (GitHub Recommended)

```bash
cd /tmp/API-Testing-Agent
git branch -M main
git push -u origin main
```

## What's Included

### Backend Features
- ✅ Zero-dependency Node.js server (node:http, node:sqlite, fetch, crypto)
- ✅ OAuth 2.0, REST, SOAP, Bulk API, Composite, GraphQL, Tooling, Metadata
- ✅ Test generation from Jira stories
- ✅ Test execution with live status (Server-Sent Events)
- ✅ Salesforce data validation (field-by-field comparison)
- ✅ Jira defect creation with masking
- ✅ PDF/Excel/CSV/HTML reporting
- ✅ Contract validation (OpenAPI 3.0, Swagger 2.0, JSON Schema)
- ✅ Postman collection export
- ✅ Demo mode with seeded data

### Frontend Features
- ✅ Single-page app (vanilla JS, no framework dependencies)
- ✅ SVG charts (line, bar, donut, horizontal bars, ribbon)
- ✅ Light and dark themes
- ✅ Responsive design
- ✅ Command palette (⌘K search)
- ✅ Production safety confirmations
- ✅ Real-time test execution
- ✅ Request/response viewer with tabs

### Testing & Quality
- ✅ 20 unit tests + 3 API integration tests
- ✅ 30-route headless UI smoke test
- ✅ All tests passing
- ✅ Secret masking verified
- ✅ Production safety verified
- ✅ Defect confirmation workflow verified

### CI/CD Ready
- ✅ GitHub Actions workflow configured
- ✅ Newman test runner included
- ✅ Export assets script
- ✅ JUnit report generation
- ✅ Platform API integration

## Next Steps After Push

1. **On GitHub:**
   - Create the repository if it doesn't exist
   - Update repository description and tags
   - Set main branch protection rules (if using main)
   - Configure secrets for CI/CD if needed

2. **Local Setup (for users):**
   ```bash
   git clone https://github.com/roshah-stack/API-Testing-Agent.git
   cd API-Testing-Agent
   npm start
   ```

3. **First Run:**
   - Server will seed demo data (~20-40 seconds)
   - Demo projects: QA, UAT, Production, SIT (unconfigured)
   - Demo stories: 8 total
   - Demo tests: 173 test cases
   - Demo runs: 2 weeks of execution history

4. **Connect Real Org:**
   - Copy `.env.example` to `.env`
   - Add Salesforce credentials: `SF_<PREFIX>_CLIENT_ID`, etc.
   - Add Jira credentials: `JIRA_EMAIL`, `JIRA_API_TOKEN`
   - Create a "Live" project in the UI
   - Test connection in Projects → Connections

## Testing Checklist

Before marking ready for production use:

- [ ] Clone from GitHub fresh
- [ ] `npm install` (should be no-op)
- [ ] `npm start` starts cleanly
- [ ] `npm test` passes all 20 tests
- [ ] `npm run test:ui` passes all 30 routes
- [ ] Demo dashboard loads
- [ ] Can generate tests from a story
- [ ] Can execute a test run
- [ ] Can preview and create a Jira defect
- [ ] Can export a Postman collection
- [ ] Dark/light theme toggle works
- [ ] Command palette search works (⌘K)
- [ ] Production safety prompt appears

## Credentials & Security

All secrets are handled via environment variables. Never commit:
- Salesforce tokens
- Jira API tokens
- OAuth credentials
- Session IDs

The masking layer in `server/lib/mask.js` automatically redacts:
- Passwords, tokens, session IDs in requests/responses
- Authorization headers
- Salesforce and Jira credentials
- In all reports, logs, and UI

## Support & Documentation

- **README.md** — How to run and configure
- **docs/API.md** — All 29 REST endpoints documented
- **WORKFLOW_GUIDE.md** — How to use the platform
- **UI_IMPROVEMENTS.md** — UX design decisions

## Questions?

Refer to:
1. Root README.md for quick start
2. WORKFLOW_GUIDE.md for user guidance
3. docs/API.md for API specifications
4. server/tests/ for code examples
5. api-tests/README.md for CI integration

---

**Status:** Ready for GitHub push  
**Last Updated:** 2026-10-04  
**Node.js Required:** 22.5 or later
