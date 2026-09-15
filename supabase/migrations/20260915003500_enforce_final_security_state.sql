-- Final P0 security seal.
--
-- This migration intentionally follows every migration in the commercial
-- release. It makes upgraded databases converge even when an earlier draft of
-- 20260915001521 was already recorded, and prevents later domain migrations
-- from reopening direct Data API access.

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- Future objects created by the migration owner are closed until their own
-- migration deliberately grants a reviewed runtime entry point.
alter default privileges for role postgres
  revoke all on tables from public, anon, authenticated, service_role;
alter default privileges for role postgres
  revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges for role postgres
  revoke all on functions from public, anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke all on tables from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on functions from public, anon, authenticated, service_role;

alter default privileges for role postgres in schema tms_private
  revoke all on tables from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema tms_private
  revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema tms_private
  revoke all on functions from public, anon, authenticated, service_role;

alter default privileges for role postgres in schema wf_private
  revoke all on tables from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema wf_private
  revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema wf_private
  revoke all on functions from public, anon, authenticated, service_role;

-- Exact schema boundary. Private schema USAGE exists only for the two legacy
-- invoker bridges that remain public: avatar/QR for authenticated users and
-- push delivery for the service worker.
revoke all on schema public
from public, anon, authenticated, service_role;
grant usage on schema public to authenticated, service_role;

revoke all on schema tms_private, wf_private
from public, anon, authenticated, service_role;
grant usage on schema tms_private to authenticated;
grant usage on schema wf_private to service_role;

-- Normalize upgraded objects before regranting the exact runtime surface.
revoke all on all tables in schema public
from public, anon, authenticated, service_role;
revoke all on all sequences in schema public
from public, anon, authenticated, service_role;
revoke all on all functions in schema public
from public, anon, authenticated, service_role;

revoke all on all tables in schema tms_private, wf_private
from public, anon, authenticated, service_role;
revoke all on all sequences in schema tms_private, wf_private
from public, anon, authenticated, service_role;
revoke all on all functions in schema tms_private, wf_private
from public, anon, authenticated, service_role;

do $migration$
declare
  relation record;
begin
  for relation in
    select namespace.nspname, class.relname
    from pg_catalog.pg_class class
    join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
    where namespace.nspname in ('public', 'tms_private', 'wf_private')
      and class.relkind in ('r', 'p')
  loop
    execute format(
      'alter table %I.%I enable row level security',
      relation.nspname,
      relation.relname
    );
  end loop;
end;
$migration$;

-- The final browser contract is four public RPCs and no direct table/sequence
-- privileges. Workforce wrappers are SECURITY DEFINER so authenticated does
-- not need EXECUTE/USAGE on wf_private. Both delegate immediately to the
-- current, capability-checked implementation and use an empty search_path.
create or replace function public.workforce_query(
  p_resource text,
  p_args jsonb default '{}'
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select wf_private.query_ga(p_resource, p_args);
$$;

-- These read entry points include live server timestamps and operational
-- state. Mark the full call chain VOLATILE so PostgreSQL never folds multiple
-- calls into one stale result inside a statement.
alter function wf_private.query(text,jsonb) volatile;
alter function wf_private.query_v4(text,jsonb) volatile;
alter function wf_private.query_commercial(text,jsonb) volatile;
alter function wf_private.query_ga(text,jsonb) volatile;
alter function wf_private.payroll_checklist(date,date) volatile;

create or replace function public.workforce_command(
  p_action text,
  p_args jsonb default '{}'
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select wf_private.command_commercial(p_action, p_args);
$$;

drop function if exists public.update_my_avatar(text);

grant execute on function
  public.create_attendance_qr(text),
  public.set_my_avatar(text),
  public.workforce_command(text, jsonb),
  public.workforce_query(text, jsonb)
to authenticated;

grant execute on function
  tms_private.create_attendance_qr_v1(text),
  tms_private.set_my_avatar_v1(text)
to authenticated;

grant execute on function wf_private.push_worker(text, jsonb)
to service_role;

grant execute on function
  public.activate_trusted_device_v1(text, text, jsonb, text, text),
  public.create_trusted_device_challenge_v1(text, text, integer),
  public.consume_trusted_device_challenge_v1(uuid, text, text, integer),
  public.reset_trusted_device_v1(text, text, text),
  public.workforce_hris_worker_v1(text, jsonb),
  public.workforce_maintenance_worker_v1(integer),
  public.workforce_push_worker_v1(text, jsonb)
to service_role;

-- Exact direct table permissions used by the checked-in Edge Functions. All
-- commercial ledgers/config/workflow tables remain owner-only behind RPCs.
grant select, insert, update on table public.employees to service_role;
grant select on table
  public.attendance_policies,
  public.locations,
  public.workforce_employee_capabilities,
  public.workforce_role_capabilities
to service_role;
grant select on table
  public.trusted_devices,
  public.trusted_device_challenges,
  public.trusted_device_grants
to service_role;
grant insert on table public.audit_logs to service_role;

-- Reassert the one supported Storage contract and remove upgraded-project
-- policies that could otherwise widen object access.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values(
  'avatars',
  'avatars',
  true,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict(id) do update
set name = excluded.name,
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Storage policies are project-wide, not bucket-local objects. Recreate only
-- the four policies owned by the avatars feature and preserve other buckets.
drop policy if exists avatar_owner_select on storage.objects;
drop policy if exists avatar_owner_insert on storage.objects;
drop policy if exists avatar_owner_update on storage.objects;
drop policy if exists avatar_owner_delete on storage.objects;

create policy avatar_owner_select
on storage.objects for select to authenticated
using(
  bucket_id = 'avatars'
  and name = (select auth.uid())::text || '/avatar.jpg'
);

create policy avatar_owner_insert
on storage.objects for insert to authenticated
with check(
  bucket_id = 'avatars'
  and name = (select auth.uid())::text || '/avatar.jpg'
);

create policy avatar_owner_update
on storage.objects for update to authenticated
using(
  bucket_id = 'avatars'
  and name = (select auth.uid())::text || '/avatar.jpg'
)
with check(
  bucket_id = 'avatars'
  and name = (select auth.uid())::text || '/avatar.jpg'
);

create policy avatar_owner_delete
on storage.objects for delete to authenticated
using(
  bucket_id = 'avatars'
  and name = (select auth.uid())::text || '/avatar.jpg'
);

-- Audit history and approval decisions are evidence, not mutable state.
drop trigger if exists audit_logs_assign_organization on public.audit_logs;
create trigger audit_logs_assign_organization
before insert on public.audit_logs
for each row execute function tms_private.assign_audit_organization();

create or replace function tms_private.reject_audit_log_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_logs is append-only' using errcode = '55000';
  return null;
end;
$$;
revoke all on function tms_private.reject_audit_log_mutation()
from public, anon, authenticated, service_role;

drop trigger if exists audit_logs_append_only on public.audit_logs;
create trigger audit_logs_append_only
before update or delete or truncate on public.audit_logs
for each statement execute function tms_private.reject_audit_log_mutation();

drop trigger if exists workflow_decisions_immutable on public.workflow_decisions;
create trigger workflow_decisions_immutable
before update or delete or truncate on public.workflow_decisions
for each statement execute function wf_private.prevent_workflow_decision_mutation();

-- Refuse to record the seal unless its principal boundaries are already true.
do $migration$
begin
  if exists (
    select 1
    from pg_catalog.pg_class class
    join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'public'
      and class.relkind in ('r', 'p', 'v', 'm', 'f')
      and exists (
        select 1
        from unnest(array[
          'SELECT', 'INSERT', 'UPDATE', 'DELETE',
          'TRUNCATE', 'REFERENCES', 'TRIGGER'
        ]) privilege_name
        where has_table_privilege(
          'authenticated',
          class.oid,
          privilege_name
        )
      )
  ) then
    raise exception 'authenticated must remain RPC-only';
  end if;
  if has_table_privilege('service_role', 'public.organizations', 'insert')
    or has_table_privilege('service_role', 'public.organizations', 'update')
    or has_table_privilege('service_role', 'public.organizations', 'delete')
    or has_table_privilege('service_role', 'public.organizations', 'truncate') then
    raise exception 'service_role must not provision organizations';
  end if;
  if has_table_privilege('service_role', 'public.audit_logs', 'update')
    or has_table_privilege('service_role', 'public.audit_logs', 'delete')
    or has_table_privilege('service_role', 'public.audit_logs', 'truncate') then
    raise exception 'service_role must not mutate audit history';
  end if;
  if has_schema_privilege('anon', 'public', 'usage') then
    raise exception 'anon must not access the public Data API schema';
  end if;
end;
$migration$;

notify pgrst, 'reload schema';
