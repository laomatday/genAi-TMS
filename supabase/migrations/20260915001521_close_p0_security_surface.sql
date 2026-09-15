-- P0 commercial security boundary.
--
-- The supported deployment model is one dedicated Supabase project per
-- customer. organization_id remains a defence-in-depth boundary inside that
-- project, but the service role is not an organization provisioning API.
-- This migration also replaces inherited/default Data API privileges with the
-- smallest allow-list used by the checked-in browser and Edge Functions.

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 1. Make future objects closed by default. Supabase projects created before
-- auto_expose_new_tables=false can retain permissive default ACLs, so the
-- project setting alone is not a final-state security control.
-- ---------------------------------------------------------------------------
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

-- graphql_public is owned by the managed supabase_admin role, which project
-- migrations must not impersonate. It is removed from the API schema list in
-- config.toml instead of attempting an ineffective cross-owner REVOKE here.

-- ---------------------------------------------------------------------------
-- 2. Normalize existing objects, including objects left by an older project.
-- ---------------------------------------------------------------------------
revoke all on schema public from public, anon, authenticated, service_role;
grant usage on schema public to authenticated, service_role;

revoke all on schema tms_private, wf_private
from public, anon, authenticated, service_role;
grant usage on schema tms_private to authenticated;
grant usage on schema wf_private to authenticated, service_role;

revoke all on all tables in schema public
  from public, anon, authenticated, service_role;
revoke all on all sequences in schema public
  from public, anon, authenticated, service_role;
revoke all on all functions in schema public
  from public, anon, authenticated, service_role;

-- Legacy private helpers inherited EXECUTE through PostgreSQL's default
-- PUBLIC function privilege. Keep only the one invoker bridge used by the
-- checked-in push worker; SECURITY DEFINER functions execute as their owner
-- and do not need a service-role grant on their implementation helpers.
revoke all on all functions in schema tms_private
  from public, anon, service_role;
revoke all on all functions in schema wf_private
  from public, anon, service_role;
revoke all on all tables in schema tms_private, wf_private
  from public, anon, authenticated, service_role;
revoke all on all sequences in schema tms_private, wf_private
  from public, anon, authenticated, service_role;
grant execute on function wf_private.push_worker(text, jsonb)
to service_role;

-- Every ordinary public table must have RLS even when it is not currently in
-- the allow-list. This also closes legacy tables that may exist only on an
-- upgraded project and not in a clean migration replay.
do $migration$
declare
  relation record;
begin
  for relation in
    select namespace.nspname, class.relname
    from pg_catalog.pg_class class
    join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'public'
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

-- Private implementation tables are owner-only. SECURITY DEFINER functions
-- remain their sole access path; service_role does not bypass this ACL through
-- PostgREST.
do $migration$
declare
  relation record;
begin
  for relation in
    select namespace.nspname, class.relname
    from pg_catalog.pg_class class
    join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
    where namespace.nspname in ('tms_private', 'wf_private')
      and class.relkind in ('r', 'p')
  loop
    execute format(
      'alter table %I.%I enable row level security',
      relation.nspname,
      relation.relname
    );
    execute format(
      'revoke all on table %I.%I from public, anon, authenticated, service_role',
      relation.nspname,
      relation.relname
    );
  end loop;
end;
$migration$;

-- ---------------------------------------------------------------------------
-- 3. The browser is RPC-only. Authenticated users receive no direct public
-- table or sequence privilege; each supported RPC performs its own tenant,
-- scope and capability checks through the private implementation layer.
-- ---------------------------------------------------------------------------
-- Exact service-role table allow-list for the two checked-in Edge Functions.
-- In particular, organizations is read-only for browser users and has no
-- service-role write grant: shared-project tenant onboarding is stopped.
grant select, insert, update on table public.employees to service_role;
grant select on table
  public.attendance_policies,
  public.locations,
  public.workforce_employee_capabilities,
  public.workforce_role_capabilities
to service_role;
grant select, insert, update on table public.trusted_devices to service_role;
grant select, insert on table public.trusted_device_challenges to service_role;
grant insert on table public.audit_logs to service_role;

-- ---------------------------------------------------------------------------
-- 4. Keep the retired directory helper's privileged implementation out of the
-- exposed schema. The ungranted public invoker wrapper remains only as a
-- rollback-compatible object; current clients use workforce_query.
-- ---------------------------------------------------------------------------
create or replace function tms_private.directory_context_v1()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'locations', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'center_id', location.center_id,
          'center_name', location.center_name,
          'city', location.city,
          'active', location.active
        ) order by location.center_name
      ), '[]'::jsonb)
      from public.locations location
      where location.organization_id = me.organization_id
    ),
    'people', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'employee_id', directory_page.employee_id,
          'role', directory_page.role,
          'direct_manager_id', directory_page.direct_manager_id
        ) order by directory_page.name, directory_page.employee_id
      ), '[]'::jsonb)
      from (
        select employee.employee_id,
          employee.name,
          employee.role,
          employee.direct_manager_id
        from public.employees employee
        where employee.organization_id = me.organization_id
          and employee.status = 'Active'
          and employee.role <> 'Kiosk'
        order by employee.name, employee.employee_id
        limit 100
      ) directory_page
    )
  )
  from public.employees me
  where me.auth_user_id = (select auth.uid())
    and me.status = 'Active'
    and wf_private.capable('directory.read')
  limit 1;
$$;

revoke all on function tms_private.directory_context_v1()
from public, anon, authenticated, service_role;

create or replace function public.tms_directory_context_v1()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select tms_private.directory_context_v1();
$$;

-- Retire the superseded public SECURITY DEFINER avatar writer. The supported
-- owner-bound implementation is public.set_my_avatar(text).
drop function if exists public.update_my_avatar(text);

-- Exact public RPC allow-list used by the browser and notification worker.
grant execute on function
  public.create_attendance_qr(text),
  public.set_my_avatar(text),
  public.workforce_command(text, jsonb),
  public.workforce_query(text, jsonb)
to authenticated;

grant execute on function public.workforce_push_worker_v1(text, jsonb)
to service_role;

-- ---------------------------------------------------------------------------
-- 5. Normalize Storage to the one supported avatar surface. Public object
-- delivery is an explicit product choice; every mutation remains bound to the
-- authenticated user's fixed object path.
-- ---------------------------------------------------------------------------
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

-- Storage is shared by every bucket in the project. Replace only the policies
-- owned by this application so an unrelated bucket keeps its own RLS contract.
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

-- ---------------------------------------------------------------------------
-- 6. Audit is append-only even if a privileged runtime role is accidentally
-- granted UPDATE, DELETE or TRUNCATE later. Only the database owner can disable
-- the trigger as part of a reviewed recovery procedure.
-- ---------------------------------------------------------------------------
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

-- Fail the migration if a sensitive grant regresses inside this transaction.
do $migration$
begin
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
