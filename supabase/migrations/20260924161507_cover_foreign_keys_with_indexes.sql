-- Covers 55 foreign keys that had no usable index, per Supabase's own
-- unindexed_foreign_keys advisor (checked directly against pg_constraint/
-- pg_index on 24/09, not just the advisor's cached finding).
--
-- At today's scale (43 employees, ~22MB database) this is not why anything is
-- slow — a delete/update that has to seq-scan a 43-row child table to check
-- the FK is still fast in absolute terms. It matters because every one of
-- these tables grows with tenant count and time (attendance_events,
-- work_sessions, shift_assignments, the workflow_* approval chain), and an
-- unindexed FK check is a seq scan on the referencing table on every write to
-- the table it points at — the kind of cost that is invisible at 43 rows and
-- shows up as lock time once a tenant has real history.
--
-- Where a table already carries an unrelated index (e.g. a single-column
-- lookup index), that index is left alone: it was not made redundant by
-- adding the composite the FK actually needs, since the two serve different
-- query shapes. Cleaning up genuinely unused indexes is a separate decision —
-- this project has been live under a month, so a handful of weeks with zero
-- recorded scans is not yet good evidence that an index is dead weight
-- (a monthly export or a DSAR request can go that long between uses on its
-- own). Left for a later pass once pg_stat_user_indexes has more history.

create index if not exists attendance_events_work_session_id_idx on public.attendance_events(organization_id, work_session_id);

create index if not exists attendance_requests_work_session_id_idx on public.attendance_requests(organization_id, work_session_id);
create index if not exists attendance_requests_workflow_instance_id_idx on public.attendance_requests(organization_id, workflow_instance_id);

create index if not exists dsar_requests_subject_employee_internal_id_idx on public.dsar_requests(organization_id, subject_employee_internal_id);

create index if not exists employees_attendance_policy_id_idx on public.employees(organization_id, attendance_policy_id);

create index if not exists hris_export_outbox_integration_id_idx on public.hris_export_outbox(organization_id, integration_id);

create index if not exists legal_holds_created_by_internal_id_idx on public.legal_holds(organization_id, created_by_internal_id);
create index if not exists legal_holds_organization_id_idx on public.legal_holds(organization_id);
create index if not exists legal_holds_subject_employee_internal_id_idx on public.legal_holds(organization_id, subject_employee_internal_id);

create index if not exists organization_config_versions_updated_by_idx on public.organization_config_versions(updated_by);
create index if not exists organization_security_settings_updated_by_idx on public.organization_security_settings(updated_by);
create index if not exists retention_policies_updated_by_idx on public.retention_policies(updated_by);

-- shift_assignments carries the "identity" pattern used across this schema:
-- an internal id FK for integrity plus a business-key FK for lookups, kept as
-- separate constraints (see e.g. shift_assignments_shift_identity_fk vs
-- shift_assignments_organization_shift_fk) — each needs its own index.
create index if not exists shift_assignments_employee_id_idx on public.shift_assignments(employee_id);
create index if not exists shift_assignments_employee_internal_id_employee_id_idx on public.shift_assignments(organization_id, employee_internal_id, employee_id);
create index if not exists shift_assignments_location_internal_id_location_id_idx on public.shift_assignments(organization_id, location_internal_id, location_id);
create index if not exists shift_assignments_location_internal_id_idx on public.shift_assignments(organization_id, location_internal_id);
create index if not exists shift_assignments_org_shift_id_idx on public.shift_assignments(organization_id, shift_id);
create index if not exists shift_assignments_shift_internal_id_shift_id_idx on public.shift_assignments(organization_id, shift_internal_id, shift_id);
create index if not exists shift_assignments_shift_internal_id_idx on public.shift_assignments(organization_id, shift_internal_id);

create index if not exists timesheets_policy_id_idx on public.timesheets(organization_id, policy_id);

create index if not exists push_deliveries_notification_id_idx on wf_private.push_deliveries(notification_id);
create index if not exists push_deliveries_organization_id_idx on wf_private.push_deliveries(organization_id);
create index if not exists push_subscriptions_organization_id_idx on wf_private.push_subscriptions(organization_id);

create index if not exists work_sessions_employee_internal_id_employee_id_idx on public.work_sessions(organization_id, employee_internal_id, employee_id);
create index if not exists work_sessions_location_internal_id_location_id_idx on public.work_sessions(organization_id, location_internal_id, location_id);
create index if not exists work_sessions_location_internal_id_idx on public.work_sessions(organization_id, location_internal_id);
create index if not exists work_sessions_policy_id_idx on public.work_sessions(organization_id, policy_id);

create index if not exists workflow_decisions_instance_id_idx on public.workflow_decisions(organization_id, instance_id);
create index if not exists workflow_decisions_actor_employee_internal_id_idx on public.workflow_decisions(organization_id, actor_employee_internal_id);
create index if not exists workflow_decisions_delegated_from_internal_id_idx on public.workflow_decisions(organization_id, delegated_from_internal_id);
create index if not exists workflow_decisions_organization_id_idx on public.workflow_decisions(organization_id);
create index if not exists workflow_decisions_step_id_idx on public.workflow_decisions(organization_id, step_id);

create index if not exists workflow_definitions_created_by_idx on public.workflow_definitions(created_by);

create index if not exists workflow_delegations_created_by_internal_id_idx on public.workflow_delegations(organization_id, created_by_internal_id);
create index if not exists workflow_delegations_from_employee_internal_id_idx on public.workflow_delegations(organization_id, from_employee_internal_id);

create index if not exists workflow_instances_definition_id_idx on public.workflow_instances(organization_id, definition_id);
create index if not exists workflow_instances_request_id_idx on public.workflow_instances(organization_id, request_id);

create index if not exists workflow_steps_instance_id_idx on public.workflow_steps(organization_id, instance_id);
create index if not exists workflow_steps_assigned_employee_internal_id_idx on public.workflow_steps(organization_id, assigned_employee_internal_id);

create index if not exists workforce_employee_capabilities_organization_id_idx on public.workforce_employee_capabilities(organization_id);

create index if not exists workforce_leave_ledger_employee_id_idx on public.workforce_leave_ledger(employee_id);
create index if not exists workforce_leave_ledger_organization_id_idx on public.workforce_leave_ledger(organization_id);

create index if not exists workforce_metrics_employee_id_idx on public.workforce_metrics(employee_id);

create index if not exists workforce_notifications_organization_id_idx on public.workforce_notifications(organization_id);

create index if not exists workforce_overtime_ledger_employee_internal_id_idx on public.workforce_overtime_ledger(organization_id, employee_internal_id);
create index if not exists workforce_overtime_ledger_organization_id_idx on public.workforce_overtime_ledger(organization_id);
create index if not exists workforce_overtime_ledger_request_id_idx on public.workforce_overtime_ledger(organization_id, request_id);

create index if not exists workforce_payroll_exports_created_by_idx on public.workforce_payroll_exports(created_by);

create index if not exists workforce_receipts_event_id_idx on public.workforce_receipts(event_id);
create index if not exists workforce_receipts_organization_id_idx on public.workforce_receipts(organization_id);
create index if not exists workforce_receipts_work_session_id_idx on public.workforce_receipts(organization_id, work_session_id);

create index if not exists workforce_schedule_templates_created_by_idx on public.workforce_schedule_templates(created_by);

-- Same identity pattern as shift_assignments above: shift_id is both an
-- internal-only FK on its own and part of a tenant-scoped composite FK.
create index if not exists workforce_staffing_rules_location_id_idx on public.workforce_staffing_rules(location_id);
create index if not exists workforce_staffing_rules_org_shift_id_idx on public.workforce_staffing_rules(organization_id, shift_id);
create index if not exists workforce_staffing_rules_shift_id_idx on public.workforce_staffing_rules(shift_id);
