# Commercial release runbook

This repository supports two managed commercial deployment boundaries: a dedicated Supabase project per customer, or multiple organizations in one reviewed Supabase project. Separate development, staging and production environments remain mandatory in both models.

## Automated release gates

Run the same command locally and in CI:

```bash
bun run check:release
```

The gate verifies repository invariants, dead code, unit tests, TypeScript, production bundling and high/critical dependency advisories. CI installs from the frozen Bun lockfile using the pinned toolchain version. A separate CI job builds the migration chain from an empty Postgres database, runs cross-tenant negative tests, then runs database lint and advisors.

## Environment promotion

1. Create separate Supabase projects for development, staging and production.
2. Configure each Vercel environment with its own publishable key and project URL. Never expose a secret/service-role key through a `VITE_*` variable.
3. Apply every migration to staging in timestamp order and run acceptance tests with Staff, Manager, HR, Admin and Kiosk accounts.
4. Review Supabase Security Advisor and Performance Advisor with no unresolved critical finding.
5. Export a recoverable backup or enable PITR before production schema changes.
6. Promote the exact tested commit to production; do not rebuild from a different revision.
7. Verify login, QR issue/scan, check-in, pause/resume, check-out, request approval, payroll close and audit export.
8. Record the deployed app version, build ID, migration head and rollback owner in the release ticket.

The `pg_net` relocation migration refuses to recreate the extension while its
request queue or response table contains rows. Drain and record those rows on
staging before promotion; never bypass the guard on production.

## Required platform controls

- Enforce MFA for Supabase and source-control administrators.
- Enable SSL enforcement and database network restrictions where the selected Supabase plan supports them.
- Configure custom SMTP, verified sender domains and appropriate authentication rate limits.
- Keep at least two organization owners and test recovery access quarterly.
- Configure production monitoring for frontend error metrics, attendance failure codes, unavailable Kiosks and scheduled maintenance failures.
- Define retention periods for audit logs, attendance evidence and employee profile data with the customer.
- Run load tests against staging using the expected peak check-in window, not production.

### Dashboard load gate

Run the built-in smoke load test only against a staging project populated with
representative tenant sizes and short-lived test accounts. The values below are
placeholders; inject real credentials from a CI secret manager or protected
environment file rather than pasting them into shell history. A secret/service-
role key is rejected.

```bash
TMS_LOAD_TEST_URL="https://staging-project.supabase.co" \
TMS_LOAD_TEST_API_KEY="<publishable-key>" \
TMS_LOAD_TEST_ACCESS_TOKENS="<test-user-token-1>,<test-user-token-2>" \
TMS_LOAD_TEST_ALLOW_REMOTE=true \
TMS_LOAD_TEST_ENVIRONMENT=staging \
TMS_LOAD_TEST_CONFIRM_HOST="staging-project.supabase.co" \
TMS_LOAD_TEST_CONCURRENCY=50 \
TMS_LOAD_TEST_DURATION_SECONDS=120 \
bun run test:load
```

The command fails when the dashboard p95 exceeds 1.5 seconds or the error rate
exceeds 1% by default. `TMS_LOAD_TEST_MAX_ERROR_RATE` is a ratio, so `0.01`
means 1%. Configure tighter customer SLOs with `TMS_LOAD_TEST_P95_BUDGET_MS`,
`TMS_LOAD_TEST_MAX_ERROR_RATE` and `TMS_LOAD_TEST_MAX_RPS`. The runner redacts
credentials, caps concurrency/duration/request rate and requires both an
explicit staging declaration and an exact hostname confirmation for remote
targets. Run separate scenarios for shift-start bursts, normal dashboard polling
and the maintenance window; never load-test production.

## Tenant data boundary

The browser uses only the Supabase publishable key. Authorization comes from the authenticated employee record and database RLS/capability checks; it never trusts `user_metadata`. Administrative account operations run through tenant-scoped Edge Functions.

Directory records are not persisted in browser `localStorage`. User preferences that could leak state between sessions are scoped by `organization_id` and `employee_id`. Attendance commands are server-authorized and receipt-backed. Attendance retries reuse the original `command_id`; proposal and explanation forms keep one `client_request_id` for the lifetime of the form, so an ambiguous network retry returns the original workflow row instead of creating a duplicate. Durable offline reconciliation across a browser restart remains a general-availability requirement.

### Employee spreadsheet recovery

Interactive employee imports are capped at 100 rows. The browser validates the
complete file before the first write, then records only rows confirmed by the
`admin-users` Edge Function. Auth and Postgres are separate systems, so this is
not an atomic batch: a connection failure can leave the current row uncertain,
and a server failure can report a partial `commit_state`. The Control Center
reloads authoritative employee data on either case and shows the confirmed row
count. Re-select the same source file to reconcile already-created rows through
the guarded `upsert` path and continue; do not edit IDs or substitute emails to
work around a partial-state warning. If the same row repeatedly reports an
Auth-only state, stop the import and reconcile that Auth user before proceeding.

For larger onboarding batches, use a reviewed server-side import job with
durable per-row status and an Auth/Postgres reconciliation queue. Do not raise
the browser batch limit and describe it as transactional.

## Shared-database SaaS boundary

`config_shifts`, `config_system`, `holidays`, `locations` and `attendance_policies` are tenant-owned. Their write policies require the caller's effective `settings.manage` capability and the matching `organization_id`, so an employee-level deny remains authoritative even for an Admin role. Guarded migrations tenant-scope the reviewed Workforce query/command fragments, and schedule/staffing references use composite tenant foreign keys. The SQL suite exercises cross-tenant writes and direct-table writes after a capability deny; a complete negative matrix for every remaining table and Edge Function remains a release task.

Organization creation is a service-role-only provisioning operation. A newly provisioned organization receives a default attendance policy plus copies of the default shift templates, system settings and role capabilities. Holidays are intentionally not copied because they are tenant-specific operational data. Review those defaults before activating the tenant.

The current product boundary is one Vietnam timezone
(`Asia/Ho_Chi_Minh`). Although organizations store a timezone field, attendance,
scheduling and maintenance calculations do not yet consume it consistently.
Do not contract multi-country or per-tenant timezone support until that behavior
has server-side rollover/DST tests.

Employee-facing request references are issued atomically per organization as `REQ-000001`, never derived from database UUIDs. Browser payloads cannot select or overwrite the sequence.

Before onboarding multiple customers into one production project, run `supabase/tests/tenant_configuration_isolation.sql` against staging after a clean migration reset, review the Security and Performance Advisors, and complete Staff/Admin acceptance tests for every tenant. Customer self-service billing and automated plan enforcement remain outside this repository; provisioning is managed through the trusted service-role control plane.

## Rollback

- Application: promote the previous known-good Vercel deployment.
- Database: prefer a forward corrective migration. Restore from PITR only for a confirmed destructive incident and follow the customer's recovery procedure.
- PWA: keep `/sw.js` revalidated and increment its cache version when changing shell assets. Users receive an update prompt that waits for any attendance operation to finish.
