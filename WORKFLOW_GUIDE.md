# API Testing Workflow Guide

## The Main Workflow

This application guides you through a simple, linear workflow:

```
1. Add Stories              2. Generate Tests           3. Run Tests           4. Review & Fix
┌─────────────────┐       ┌──────────────────┐       ┌─────────────┐       ┌──────────────┐
│ Stories & Tests │  ──→  │ AI generates     │  ──→  │ Execute in  │  ──→  │ Click a      │
│ (Jira sync)     │       │ test cases       │       │ background  │       │ failed test  │
└─────────────────┘       │ for your review  │       └─────────────┘       │ to create    │
                          └──────────────────┘                             │ a Jira issue │
                                                                            └──────────────┘
```

## Navigation Guide

The sidebar organizes features by your workflow:

### **Core Workflow** (Start here)
- **Dashboard** — See overall quality and recent runs
- **Stories & Tests** — Add stories and generate API tests
- **Test Runs** — Execute tests and watch progress
- **Defects** — Review failed tests and create Jira issues

### **Testing** (Additional tools)
- **Test Cases** — Browse and edit individual test cases
- **API Explorer** — Manually test an endpoint
- **API Contracts** — Upload OpenAPI specs for validation

### **Resources** (Setup)
- **Test Data** — Create test payloads
- **CI/CD** — Export tests for your pipeline
- **Projects** — Configure Salesforce org and Jira connections

### **Insights** (Analysis)
- **Reports** — Download PDF/Excel execution reports
- **Traceability** — See which stories are covered
- **AI Assistant** — Chat in plain language: ask broad questions ("Discover all APIs related to Contact"), or describe a one-off scenario ("Test creating a Contact without a LastName") and it builds, runs and reports on that exact test immediately
- **Audit Log** — See who did what and when

## Quick Start

1. **Open the Dashboard** (home page)
   - Shows quality metrics and latest run
   - Has a quick workflow guide if you're just starting

2. **Go to Stories & Tests**
   - Sync stories from Jira, or add them manually
   - Each story shows whether it likely **needs API testing** (a quick heuristic read, not a hard rule) — use it to skip UI-only or documentation tickets, not as the final word
   - Click "Generate" on a story to create API tests

3. **Review the Generated Tests**
   - A modal shows all proposed tests
   - Check the ones you want to keep
   - Click "Approve"

4. **Run the Tests**
   - Click "Test Runs" in the sidebar
   - Click "Start new run" to execute
   - Watch the progress in real-time

5. **Review Results**
   - Click on a failed test to see details
   - Click "Preview Jira defect"
   - Review the masked summary
   - Click "Create Jira defect" to open an issue

## Key Concepts

### **Provenance Labels**
Every test case has a label showing where it came from:
- **VERIFIED** — Metadata from a live Salesforce org
- **ASSUMED** — Generated from heuristics (demo mode)
- **RECOMMENDED** — AI suggestion for additional coverage

### **Production Safety**
If testing Production:
- You must confirm any write operations
- DELETE requires a second confirmation
- Test data is never created or deleted automatically
- Run in "read-only" mode for smoke tests

### **Secrets are Always Masked**
- Tokens, passwords, and IDs are masked in reports
- Authorization headers are never stored
- Salesforce session IDs are redacted
- Jira credentials stay in environment variables

### **Ticket Classification**
- Every story is automatically checked for whether it plausibly needs API testing at all (API/webhook/integration language vs. pure UI/copy/documentation language)
- It's a heuristic suggestion labelled **ASSUMED**, shown as a badge on the story list and a callout on the generated proposal — it never blocks Generate, and in the Agent console an "Analyze" request on a low-relevance story explains why and offers "Analyze anyway"
- When in doubt, it defaults to assuming testing is needed rather than silently skipping a story

### **Ad Hoc Scenario Testing**
- The AI Assistant chat can build and run a single test from one sentence — no story, generation or approval step required
- It parses the sentence for the object, the condition (missing/invalid field, boundary, picklist, auth, not-found, etc.) and builds one HTTP call with assertions
- The test still goes through the same production-safety confirmation, priority scoring and masking as everything else, and is saved as a normal test case (tagged `chat-generated`) so it shows up in Test Cases for reuse

## Common Tasks

### Generate Tests from a Story
1. Go to **Stories & Tests**
2. Find a story
3. Click the **Generate** button
4. Review the proposal
5. Click **Approve**

### Execute a Specific Set of Tests
1. Go to **Test Cases**
2. Use filters to find your tests
3. Select them (click checkboxes)
4. Click **Run selected**

### Create a Jira Defect from a Failed Test
1. Go to **Test Runs**
2. Open a run
3. Click a **failed test**
4. Click **Preview Jira defect**
5. Review the masked summary
6. Click **Create Jira defect**

### Test a One-Off Scenario Without Writing a Story
1. Go to **AI Assistant**
2. Type a plain-language scenario, e.g. "Check what happens with an invalid email on Contact" or "Test deleting a non-existent Case"
3. Confirm the production-write prompt if the current project is Production
4. Read the inline result (status, response time, assertions) or click **View full request/response** for the masked details
5. Find it later in **Test Cases**, tagged `chat-generated`

### Export Tests for CI/CD
1. Go to **CI/CD**
2. Select filters (priority, environment, etc.)
3. Click **Export collection**
4. Save to your repo
5. Follow the README in `api-tests/`

## Troubleshooting

### No Salesforce Connection?
You'll see a yellow banner: *"Salesforce MCP is unavailable. API test design and automation generation are available, but live Salesforce validation is disabled."*

**Solution:** Add environment variables for your Salesforce org. See `.env.example`.

### Production Project is Read-Only?
**That's correct.** Production is intentionally read-only. To test writes:
- Create a non-production project (QA, SIT, etc.)
- Or explicitly confirm the write operation

### Test Not Running?
Check the **Audit Log** (Analyze → Audit log) to see errors or configuration issues.

## Tips & Tricks

- **Use filters** on Test Cases to find what you need
- **Search globally** with **⌘K** (or **/** on your keyboard)
- **Theme toggle** in the top-right corner (dark/light mode)
- **Notifications** bell shows run completions and defect updates
- **Traceability** page shows which stories are fully tested

## Keyboard Shortcuts

- **⌘K** or **/** — Open search palette
- **Tab** — Navigate between sections
- **Enter** — Confirm modals and dialogs
- **Escape** — Close modals and drawers
