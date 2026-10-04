# config/

Per-project, per-environment settings exported from the platform (`npm run export`).
These files contain **no secrets** — only identifiers such as the API version, instance URL,
credential **prefix** (e.g. `SF_ACME_QA_`) and SLA. Credentials are supplied at runtime from
environment variables or CI secrets.
