# Backup and restore runbook

This runbook is a production release gate for each customer's dedicated
Supabase project. A backup is not considered valid until it has been restored
into an isolated project and the checks below pass.

## Ownership and recovery objectives

Before go-live, record customer-approved values for:

- recovery point objective (RPO), recovery time objective (RTO), retention and
  restore-drill frequency;
- primary incident commander, database operator and customer approver;
- Supabase organization/project, region, Postgres major version and support
  escalation route.

The production default is a quarterly restore drill and an additional drill
before a destructive or high-risk schema change. Tighter contractual targets
override that default. Keep evidence in the protected release/incident system,
not in this repository.

## Non-negotiable safeguards

- Never test a restore against production and never overwrite the only known
  good backup.
- Use a new, isolated restore project with outbound email, webhooks, scheduled
  jobs, push delivery and Edge Function secrets disabled.
- Retrieve database credentials and encryption keys from the approved secret
  manager. Do not paste them into tickets, shell history or repository files.
- Preserve the source recovery point and backup identifier before changing the
  source project. Escalate rather than guessing when a backup status is unclear.
- Managed Supabase backup/PITR is the authoritative full recovery path. A
  logical SQL dump is supplemental evidence and does not replace Auth, Storage
  object and platform-configuration recovery procedures.

## Pre-release backup gate

1. In the Supabase dashboard, verify the production project reports a healthy
   current backup or PITR recovery point inside the agreed RPO.
2. Record the project ref, UTC recovery timestamp, backup/PITR identifier,
   Postgres version, deployed commit and current migration head.
3. Confirm retention, region and encryption meet the customer contract.
4. For a high-risk migration, create a supplemental encrypted logical dump in
   an approved backup location outside the checkout. With the repository's
   pinned CLI, the reviewed operator command is:

   ```bash
   SUPABASE_TELEMETRY_DISABLED=1 bunx supabase@2.117.0 db dump \
     --linked --role-only --file "<protected-backup-directory>/roles.sql"
   SUPABASE_TELEMETRY_DISABLED=1 bunx supabase@2.117.0 db dump \
     --linked --file "<protected-backup-directory>/schema.sql"
   SUPABASE_TELEMETRY_DISABLED=1 bunx supabase@2.117.0 db dump \
     --linked --data-only --use-copy --file "<protected-backup-directory>/data.sql"
   ```

   Run `... db dump --help` again before use and attach the CLI version, file
   size and a SHA-256 checksum to the evidence record. Never commit the dump.
5. A second operator checks the evidence. Promotion is blocked if any required
   field is missing or the recovery point is outside the RPO.

## Restore drill or incident restore

1. Declare the target recovery point and obtain incident/change approval.
2. Provision an isolated Supabase project in the required region and compatible
   Postgres version. Label it clearly as a restore target.
3. Disable external side effects before loading data: SMTP, webhooks, push
   workers, cron/maintenance jobs and production OAuth redirects.
4. Restore the selected managed backup or PITR point using the Supabase recovery
   workflow. If the dashboard reports an ambiguous or failed state, stop and
   escalate to Supabase Support; do not retry against production.
5. Apply only migrations that belong after the selected recovery point, in
   timestamp order and from the exact recorded commit. Never mark a migration
   applied without executing it.
6. Run the verification matrix below with read-only credentials first. Run
   transactional smoke tests only after the read-only checks pass.
7. For a real incident, cut traffic over only after customer approval, secret
   rotation and a written rollback decision. For a drill, destroy the isolated
   project after evidence is approved and its required retention period ends.

## Verification matrix

Record query output and timestamps for every check.

### Schema and migration integrity

```sql
select version
from supabase_migrations.schema_migrations
order by version desc
limit 10;

select conrelid::regclass as relation, conname
from pg_constraint
where contype = 'f' and not convalidated;
```

The latest migration must match the intended recovery state and there must be no
unexpected unvalidated foreign keys. Run `supabase/tests/final_security_state.sql`
against the restore target to re-verify RLS, RPC/table grants, Storage policies,
dedicated-project onboarding and append-only audit enforcement.

### Critical row counts

Compare these counts with the source evidence at the selected recovery point;
investigate every unexplained difference.

```sql
select 'organizations' as relation, count(*) from public.organizations
union all select 'employees', count(*) from public.employees
union all select 'timesheets', count(*) from public.timesheets
union all select 'attendance_events', count(*) from public.attendance_events
union all select 'attendance_requests', count(*) from public.attendance_requests
union all select 'audit_logs', count(*) from public.audit_logs
union all select 'workforce_receipts', count(*) from public.workforce_receipts
union all select 'storage.objects', count(*) from storage.objects;
```

Also record `max(occurred_at)` for attendance events, `max(created_at)` for
requests, receipts and audit logs, plus the latest business date. Counts alone
are not proof of freshness.

### Referential and identity checks

```sql
select count(*) as active_employees_without_auth
from public.employees employee
left join auth.users account on account.id = employee.auth_user_id
where employee.status = 'Active' and account.id is null;

select count(*) as attendance_without_employee
from public.attendance_events event
left join public.employees employee
  on employee.employee_id = event.employee_id
 and employee.organization_id = event.organization_id
where employee.employee_id is null;

select count(*) as requests_without_employee
from public.attendance_requests request
left join public.employees employee
  on employee.employee_id = request.employee_id
 and employee.organization_id = request.organization_id
where employee.employee_id is null;
```

All three results must be zero unless a documented historical exception was
already present at the selected recovery point.

The restored commercial project must also contain no more than one row in
`public.organizations`. More than one organization indicates a legacy shared-
customer deployment; block promotion and complete an approved customer split
instead of waiving the dedicated-project boundary.

### Security and product smoke tests

- Run Supabase Security Advisor and database lint with no unresolved critical
  finding.
- Verify an anonymous REST/GraphQL caller cannot enumerate application objects.
- Verify Staff, Manager/Leader, HR/Director, Admin and Kiosk accounts see only
  their allowed tenant/scope and that an effective capability deny wins.
- Verify an audit row can be appended through an approved workflow, while
  UPDATE, DELETE and TRUNCATE remain blocked even for the runtime service role.
- Verify Auth login/refresh, avatar read/upload, QR issue/scan, check-in,
  pause/resume, check-out, explanation/request approval and payroll close in a
  disposable transaction or dedicated test identities.
- Confirm no notification, email, push, webhook or maintenance job reached a
  production destination.

## Required evidence record

The release or incident record must contain:

| Field | Required evidence |
| --- | --- |
| Source | Customer, project ref, region and environment |
| Recovery point | UTC timestamp and backup/PITR identifier |
| Build | Git commit, app build ID and migration head |
| Objectives | Contractual RPO/RTO and measured restore duration/data loss |
| Integrity | Critical counts/freshness, FK/orphan checks and Storage count |
| Security | Final-state SQL result, lint/advisor result and role matrix |
| Product | Named smoke scenarios and pass/fail result |
| Operators | Executor, independent reviewer and customer approver |
| Disposal/cutover | Restore-project disposal evidence or approved cutover plan |

Any failed or missing item blocks production promotion. Document remediation and
repeat the failed section; do not waive the gate verbally.
