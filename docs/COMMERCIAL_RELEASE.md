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

## Required platform controls

- Enforce MFA for Supabase and source-control administrators.
- Enable SSL enforcement and database network restrictions where the selected Supabase plan supports them.
- Configure custom SMTP, verified sender domains and appropriate authentication rate limits.
- Keep at least two organization owners and test recovery access quarterly.
- Configure production monitoring for frontend error metrics, attendance failure codes, unavailable Kiosks and scheduled maintenance failures.
- Define retention periods for audit logs, attendance evidence and employee profile data with the customer.
- Run load tests against staging using the expected peak check-in window, not production.

## Tenant data boundary

The browser uses only the Supabase publishable key. Authorization comes from the authenticated employee record and database RLS/capability checks; it never trusts `user_metadata`. Administrative account operations run through tenant-scoped Edge Functions.

Directory records are not persisted in browser `localStorage`. User preferences that could leak state between sessions are scoped by `organization_id` and `employee_id`. Attendance writes remain idempotent, server-authorized and receipt-backed.

## Shared-database SaaS boundary

`config_shifts`, `config_system` and `holidays` are tenant-owned. Their unique keys, indexes, RLS policies and all active Workforce query/command paths include `organization_id`; schedule and staffing references use composite tenant foreign keys. Authenticated callers cannot choose or cross an organization boundary.

Organization creation is a service-role-only provisioning operation. A newly provisioned organization receives a copy of the default shift templates, system settings and role capabilities. Holidays are intentionally not copied because they are tenant-specific operational data. Review those defaults before activating the tenant.

Employee-facing request references are issued atomically per organization as `REQ-000001`, never derived from database UUIDs. Browser payloads cannot select or overwrite the sequence.

Before onboarding multiple customers into one production project, run `supabase/tests/tenant_configuration_isolation.sql` against staging after a clean migration reset, review the Security and Performance Advisors, and complete Staff/Admin acceptance tests for every tenant. Customer self-service billing and automated plan enforcement remain outside this repository; provisioning is managed through the trusted service-role control plane.

## Rollback

- Application: promote the previous known-good Vercel deployment.
- Database: prefer a forward corrective migration. Restore from PITR only for a confirmed destructive incident and follow the customer's recovery procedure.
- PWA: keep `/sw.js` revalidated and increment its cache version when changing shell assets. Users receive an update prompt that waits for any attendance operation to finish.
