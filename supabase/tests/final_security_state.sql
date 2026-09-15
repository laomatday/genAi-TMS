\set ON_ERROR_STOP on

-- This suite verifies the effective state after every migration, rather than
-- trusting an earlier migration's intermediate GRANT/REVOKE statements.
begin;

create extension if not exists pgtap with schema extensions;
select plan(1);

do $test$
declare
  relation record;
  routine record;
  privilege_name text;
  expected_authenticated boolean;
  expected_client_definer boolean;
  expected_service boolean;
begin
  if exists (
    select 1
    from pg_catalog.pg_class class
    join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'public'
      and class.relkind in ('r', 'p')
      and not class.relrowsecurity
  ) then
    raise exception 'Every public table must have RLS enabled';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_class class
    join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
    where namespace.nspname in ('tms_private', 'wf_private')
      and class.relkind in ('r', 'p')
      and not class.relrowsecurity
  ) then
    raise exception 'Every private implementation table must have RLS enabled';
  end if;

  if has_schema_privilege('anon', 'public', 'usage') then
    raise exception 'anon unexpectedly has public schema usage';
  end if;
  if not has_schema_privilege('authenticated', 'public', 'usage')
    or not has_schema_privilege('service_role', 'public', 'usage') then
    raise exception 'Required public schema usage is missing';
  end if;
  if has_schema_privilege('anon', 'public', 'create')
    or has_schema_privilege('authenticated', 'public', 'create')
    or has_schema_privilege('service_role', 'public', 'create') then
    raise exception 'An API role can create objects in the public schema';
  end if;
  if has_schema_privilege('anon', 'tms_private', 'usage')
    or has_schema_privilege('anon', 'wf_private', 'usage')
    or has_schema_privilege('service_role', 'tms_private', 'usage')
    or not has_schema_privilege('service_role', 'wf_private', 'usage')
    or not has_schema_privilege('authenticated', 'tms_private', 'usage')
    or has_schema_privilege('authenticated', 'wf_private', 'usage') then
    raise exception 'Private schema USAGE differs from the invoker-bridge allow-list';
  end if;
  if has_schema_privilege('anon', 'tms_private', 'create')
    or has_schema_privilege('anon', 'wf_private', 'create')
    or has_schema_privilege('authenticated', 'tms_private', 'create')
    or has_schema_privilege('authenticated', 'wf_private', 'create')
    or has_schema_privilege('service_role', 'tms_private', 'create')
    or has_schema_privilege('service_role', 'wf_private', 'create') then
    raise exception 'An API role can create objects in a private schema';
  end if;

  for relation in
    select class.oid, class.relname
    from pg_catalog.pg_class class
    join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'public'
      and class.relkind in ('r', 'p', 'v', 'm', 'f')
    order by class.relname
  loop
    foreach privilege_name in array array[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ] loop
      if has_table_privilege('anon', relation.oid, privilege_name) then
        raise exception 'Unexpected anon %.% privilege', relation.relname, privilege_name;
      end if;

      expected_authenticated := false;
      if has_table_privilege('authenticated', relation.oid, privilege_name)
        is distinct from expected_authenticated then
        raise exception 'RPC-only authenticated role unexpectedly has %.%',
          relation.relname, privilege_name;
      end if;

      expected_service := (relation.relname || ':' || privilege_name) = any(array[
        'attendance_policies:SELECT',
        'audit_logs:INSERT',
        'employees:SELECT',
        'employees:INSERT',
        'employees:UPDATE',
        'locations:SELECT',
        'trusted_device_challenges:SELECT',
        'trusted_device_grants:SELECT',
        'trusted_devices:SELECT',
        'workforce_employee_capabilities:SELECT',
        'workforce_role_capabilities:SELECT'
      ]);
      if has_table_privilege('service_role', relation.oid, privilege_name)
        is distinct from expected_service then
        raise exception 'service_role %.% differs from the Edge Function allow-list',
          relation.relname, privilege_name;
      end if;
    end loop;
  end loop;

  for relation in
    select class.oid, class.relname
    from pg_catalog.pg_class class
    join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'public' and class.relkind = 'S'
    order by class.relname
  loop
    foreach privilege_name in array array['USAGE', 'SELECT', 'UPDATE'] loop
      if has_sequence_privilege('anon', relation.oid, privilege_name)
        or has_sequence_privilege('service_role', relation.oid, privilege_name) then
        raise exception 'Unexpected API privilege on sequence %.%',
          relation.relname, privilege_name;
      end if;
      expected_authenticated := false;
      if has_sequence_privilege('authenticated', relation.oid, privilege_name)
        is distinct from expected_authenticated then
        raise exception 'RPC-only authenticated role unexpectedly has sequence %.%',
          relation.relname, privilege_name;
      end if;
    end loop;
  end loop;

  for routine in
    select procedure.oid, procedure.proname, procedure.prosecdef,
      procedure.proconfig
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.prokind in ('f', 'p')
    order by procedure.proname, procedure.oid
  loop
    if has_function_privilege('anon', routine.oid, 'execute') then
      raise exception 'Unexpected anon execute on public function %',
        routine.oid::regprocedure;
    end if;

    expected_authenticated := routine.oid = any(array[
      'public.create_attendance_qr(text)'::regprocedure::oid,
      'public.set_my_avatar(text)'::regprocedure::oid,
      'public.workforce_command(text,jsonb)'::regprocedure::oid,
      'public.workforce_query(text,jsonb)'::regprocedure::oid
    ]);
    if has_function_privilege('authenticated', routine.oid, 'execute')
      is distinct from expected_authenticated then
      raise exception 'authenticated execute on % differs from the runtime allow-list',
        routine.oid::regprocedure;
    end if;

    expected_service := routine.oid = any(array[
      'public.activate_trusted_device_v1(text,text,jsonb,text,text)'::regprocedure::oid,
      'public.create_trusted_device_challenge_v1(text,text,integer)'::regprocedure::oid,
      'public.consume_trusted_device_challenge_v1(uuid,text,text,integer)'::regprocedure::oid,
      'public.reset_trusted_device_v1(text,text,text)'::regprocedure::oid,
      'public.workforce_hris_worker_v1(text,jsonb)'::regprocedure::oid,
      'public.workforce_maintenance_worker_v1(integer)'::regprocedure::oid,
      'public.workforce_push_worker_v1(text,jsonb)'::regprocedure::oid
    ]);
    if has_function_privilege('service_role', routine.oid, 'execute')
      is distinct from expected_service then
      raise exception 'service_role execute on % differs from the worker allow-list',
        routine.oid::regprocedure;
    end if;

    expected_client_definer := routine.oid = any(array[
      'public.workforce_command(text,jsonb)'::regprocedure::oid,
      'public.workforce_query(text,jsonb)'::regprocedure::oid
    ]);
    if has_function_privilege('authenticated', routine.oid, 'execute')
      and routine.prosecdef is distinct from expected_client_definer then
      raise exception 'Authenticated RPC definer mode differs from the reviewed allow-list: %',
        routine.oid::regprocedure;
    end if;
    if routine.prosecdef
      and (
        has_function_privilege('authenticated', routine.oid, 'execute')
        or has_function_privilege('service_role', routine.oid, 'execute')
      )
      and not exists (
        select 1
        from unnest(coalesce(routine.proconfig, '{}'::text[])) setting
        where setting like 'search_path=%'
      ) then
      raise exception 'API SECURITY DEFINER function has no fixed search_path: %',
        routine.oid::regprocedure;
    end if;
  end loop;

  -- Private schemas are implementation details. Browser users retain only the
  -- explicit invoker bridges required by public RPCs. The service role needs
  -- exactly one private invoker bridge for push delivery; service-only public
  -- SECURITY DEFINER RPCs execute their private work as the function owner.
  for routine in
    select procedure.oid, namespace.nspname
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname in ('tms_private', 'wf_private')
      and procedure.prokind in ('f', 'p')
  loop
    if has_function_privilege('anon', routine.oid, 'execute') then
      raise exception 'Unexpected anon execute on private function %',
        routine.oid::regprocedure;
    end if;
    expected_authenticated := routine.oid = any(array[
      'tms_private.create_attendance_qr_v1(text)'::regprocedure::oid,
      'tms_private.set_my_avatar_v1(text)'::regprocedure::oid
    ]);
    if has_function_privilege('authenticated', routine.oid, 'execute')
      is distinct from expected_authenticated then
      raise exception 'authenticated execute on private function % differs from the invoker allow-list',
        routine.oid::regprocedure;
    end if;
    expected_service := routine.oid =
      'wf_private.push_worker(text,jsonb)'::regprocedure::oid;
    if has_function_privilege('service_role', routine.oid, 'execute')
      is distinct from expected_service then
      raise exception 'service_role execute on private function % differs from the worker allow-list',
        routine.oid::regprocedure;
    end if;
  end loop;

  -- Private implementation tables never receive direct API privileges.
  for relation in
    select class.oid, namespace.nspname, class.relname
    from pg_catalog.pg_class class
    join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
    where namespace.nspname in ('tms_private', 'wf_private')
      and class.relkind in ('r', 'p', 'v', 'm', 'f')
  loop
    foreach privilege_name in array array[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ] loop
      if has_table_privilege('anon', relation.oid, privilege_name)
        or has_table_privilege('authenticated', relation.oid, privilege_name)
        or has_table_privilege('service_role', relation.oid, privilege_name) then
        raise exception 'Private relation %.% exposes % to an API role',
          relation.nspname, relation.relname, privilege_name;
      end if;
    end loop;
  end loop;
  for relation in
    select class.oid, namespace.nspname, class.relname
    from pg_catalog.pg_class class
    join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
    where namespace.nspname in ('tms_private', 'wf_private')
      and class.relkind = 'S'
  loop
    if has_sequence_privilege('anon', relation.oid, 'usage')
      or has_sequence_privilege('authenticated', relation.oid, 'usage')
      or has_sequence_privilege('service_role', relation.oid, 'usage') then
      raise exception 'Private sequence %.% is directly usable by an API role',
        relation.nspname, relation.relname;
    end if;
  end loop;

  -- Any API-readable view must be invoker-safe. The exact table allow-list above
  -- currently permits no views, but keep this invariant explicit for future APIs.
  if exists (
    select 1
    from pg_catalog.pg_class class
    join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'public'
      and class.relkind = 'v'
      and (
        has_table_privilege('anon', class.oid, 'select')
        or has_table_privilege('authenticated', class.oid, 'select')
        or has_table_privilege('service_role', class.oid, 'select')
      )
      and not coalesce(class.reloptions, '{}'::text[]) @> array['security_invoker=true']
  ) then
    raise exception 'API-readable view is not security_invoker';
  end if;

  -- Default ACLs are part of the final state: adding a table or RPC must require
  -- a deliberate grant in its migration.
  if exists (
    select 1
    from pg_catalog.pg_default_acl defaults
    join pg_catalog.pg_roles owner_role on owner_role.oid = defaults.defaclrole
    left join pg_catalog.pg_namespace namespace
      on namespace.oid = defaults.defaclnamespace
    cross join lateral aclexplode(defaults.defaclacl) acl
    left join pg_catalog.pg_roles granted_role on granted_role.oid = acl.grantee
    where owner_role.rolname = 'postgres'
      and (defaults.defaclnamespace = 0
        or namespace.nspname in ('public', 'tms_private', 'wf_private'))
      and (acl.grantee = 0
        or granted_role.rolname in ('anon', 'authenticated', 'service_role'))
  ) then
    raise exception 'A permissive API-role default ACL remains';
  end if;
end;
$test$;

-- Every relationship between tenant-owned commercial rows must carry the
-- organization key.  UUID uniqueness is not accepted as a substitute for a
-- database-enforced tenant boundary.
do $test$
declare
  candidate_key record;
  tenant_fk record;
begin
  for candidate_key in
    select expected.parent_name::regclass as parent_table,
      expected.parent_columns
    from (values
      ('public.attendance_requests', array['organization_id','id']::text[]),
      ('public.workflow_definitions', array['organization_id','id']::text[]),
      ('public.workflow_instances', array['organization_id','id']::text[]),
      ('public.workflow_steps', array['organization_id','id']::text[]),
      ('public.workforce_integrations', array['organization_id','id']::text[]),
      ('public.workforce_payroll_exports', array['organization_id','id']::text[])
    ) expected(parent_name,parent_columns)
  loop
    if not exists (
      select 1
      from pg_catalog.pg_constraint constraint_row
      where constraint_row.conrelid = candidate_key.parent_table
        and constraint_row.contype in ('p','u')
        and constraint_row.convalidated
        and (
          select array_agg(attribute.attname::text order by key_column.position)
          from unnest(constraint_row.conkey) with ordinality
            key_column(attribute_number,position)
          join pg_catalog.pg_attribute attribute
            on attribute.attrelid = constraint_row.conrelid
           and attribute.attnum = key_column.attribute_number
        ) = candidate_key.parent_columns
    ) then
      raise exception 'Tenant candidate key missing on %(%)',
        candidate_key.parent_table,
        array_to_string(candidate_key.parent_columns,',');
    end if;
  end loop;

  for tenant_fk in
    select expected.constraint_name,
      expected.child_name::regclass as child_table,
      expected.child_columns,
      expected.parent_name::regclass as parent_table,
      expected.parent_columns
    from (values
      ('workflow_instances_definition_tenant_fk',
        'public.workflow_instances', array['organization_id','definition_id']::text[],
        'public.workflow_definitions', array['organization_id','id']::text[]),
      ('workflow_instances_request_tenant_fk',
        'public.workflow_instances', array['organization_id','request_id']::text[],
        'public.attendance_requests', array['organization_id','id']::text[]),
      ('workflow_steps_instance_tenant_fk',
        'public.workflow_steps', array['organization_id','instance_id']::text[],
        'public.workflow_instances', array['organization_id','id']::text[]),
      ('workflow_decisions_instance_tenant_fk',
        'public.workflow_decisions', array['organization_id','instance_id']::text[],
        'public.workflow_instances', array['organization_id','id']::text[]),
      ('workflow_decisions_step_tenant_fk',
        'public.workflow_decisions', array['organization_id','step_id']::text[],
        'public.workflow_steps', array['organization_id','id']::text[]),
      ('attendance_requests_workflow_instance_tenant_fk',
        'public.attendance_requests', array['organization_id','workflow_instance_id']::text[],
        'public.workflow_instances', array['organization_id','id']::text[]),
      ('workforce_overtime_ledger_request_tenant_fk',
        'public.workforce_overtime_ledger', array['organization_id','request_id']::text[],
        'public.attendance_requests', array['organization_id','id']::text[]),
      ('hris_export_outbox_integration_tenant_fk',
        'public.hris_export_outbox', array['organization_id','integration_id']::text[],
        'public.workforce_integrations', array['organization_id','id']::text[]),
      ('hris_export_outbox_payroll_export_tenant_fk',
        'public.hris_export_outbox', array['organization_id','payroll_export_id']::text[],
        'public.workforce_payroll_exports', array['organization_id','id']::text[])
    ) expected(
      constraint_name,child_name,child_columns,parent_name,parent_columns
    )
  loop
    if not exists (
      select 1
      from pg_catalog.pg_constraint constraint_row
      where constraint_row.conname = tenant_fk.constraint_name
        and constraint_row.contype = 'f'
        and constraint_row.convalidated
        and constraint_row.conrelid = tenant_fk.child_table
        and constraint_row.confrelid = tenant_fk.parent_table
        and (
          select array_agg(attribute.attname::text order by key_column.position)
          from unnest(constraint_row.conkey) with ordinality
            key_column(attribute_number,position)
          join pg_catalog.pg_attribute attribute
            on attribute.attrelid = constraint_row.conrelid
           and attribute.attnum = key_column.attribute_number
        ) = tenant_fk.child_columns
        and (
          select array_agg(attribute.attname::text order by key_column.position)
          from unnest(constraint_row.confkey) with ordinality
            key_column(attribute_number,position)
          join pg_catalog.pg_attribute attribute
            on attribute.attrelid = constraint_row.confrelid
           and attribute.attnum = key_column.attribute_number
        ) = tenant_fk.parent_columns
    ) then
      raise exception 'Tenant FK % is missing or targets the wrong columns',
        tenant_fk.constraint_name;
    end if;
  end loop;
end;
$test$;

-- Approval decisions are immutable commercial evidence as well. Exercise the
-- statement-level backstop without depending on seeded workflow rows.
do $test$
declare
  blocked boolean;
begin
  blocked := false;
  begin
    update public.workflow_decisions set reason = reason where false;
  exception when sqlstate '42501' then
    blocked := true;
  end;
  if not blocked then raise exception 'Workflow decision UPDATE was not blocked'; end if;

  blocked := false;
  begin
    delete from public.workflow_decisions where false;
  exception when sqlstate '42501' then
    blocked := true;
  end;
  if not blocked then raise exception 'Workflow decision DELETE was not blocked'; end if;

  blocked := false;
  begin
    truncate table public.workflow_decisions;
  exception when sqlstate '42501' then
    blocked := true;
  end;
  if not blocked then raise exception 'Workflow decision TRUNCATE was not blocked'; end if;
end;
$test$;

do $test$
begin
  if (select count(*) from public.organizations) > 1 then
    raise exception 'Dedicated customer project contains multiple organizations';
  end if;
  if has_table_privilege('service_role', 'public.organizations', 'insert')
    or has_table_privilege('service_role', 'public.organizations', 'update')
    or has_table_privilege('service_role', 'public.organizations', 'delete')
    or has_table_privilege('service_role', 'public.organizations', 'truncate') then
    raise exception 'Shared-project service-role onboarding is still possible';
  end if;
  if not has_table_privilege('service_role', 'public.audit_logs', 'insert')
    or has_table_privilege('service_role', 'public.audit_logs', 'update')
    or has_table_privilege('service_role', 'public.audit_logs', 'delete')
    or has_table_privilege('service_role', 'public.audit_logs', 'truncate') then
    raise exception 'Audit service-role grants are not append-only';
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_trigger trigger
    where trigger.tgrelid = 'public.audit_logs'::regclass
      and trigger.tgname = 'audit_logs_append_only'
      and trigger.tgenabled = 'O'
  ) then
    raise exception 'Audit append-only trigger is missing or disabled';
  end if;
end;
$test$;

-- Exercise the owner-level backstop. Statement triggers fire even when the
-- predicate matches no rows, avoiding any fixture dependency.
do $test$
declare
  blocked boolean;
begin
  blocked := false;
  begin
    update public.audit_logs set reason = reason where false;
  exception when sqlstate '55000' then
    blocked := true;
  end;
  if not blocked then raise exception 'Audit UPDATE was not blocked'; end if;

  blocked := false;
  begin
    delete from public.audit_logs where false;
  exception when sqlstate '55000' then
    blocked := true;
  end;
  if not blocked then raise exception 'Audit DELETE was not blocked'; end if;

  blocked := false;
  begin
    truncate table public.audit_logs;
  exception when sqlstate '55000' then
    blocked := true;
  end;
  if not blocked then raise exception 'Audit TRUNCATE was not blocked'; end if;
end;
$test$;

do $test$
begin
  if not exists (
    select 1
    from storage.buckets bucket
    where bucket.id = 'avatars'
      and bucket.name = 'avatars'
      and bucket.public
      and bucket.file_size_limit = 2097152
      and bucket.allowed_mime_types @> array['image/jpeg', 'image/png', 'image/webp']::text[]
      and cardinality(bucket.allowed_mime_types) = 3
  ) then
    raise exception 'Avatar bucket contract changed';
  end if;
  if not (
    select class.relrowsecurity
    from pg_catalog.pg_class class
    join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'storage' and class.relname = 'objects'
  ) then
    raise exception 'storage.objects RLS is disabled';
  end if;
  if (
    select count(*)
    from pg_catalog.pg_policies policy
    where policy.schemaname = 'storage'
      and policy.tablename = 'objects'
      and policy.policyname in (
        'avatar_owner_select', 'avatar_owner_insert',
        'avatar_owner_update', 'avatar_owner_delete'
      )
      and (
        (policy.policyname = 'avatar_owner_select' and policy.cmd = 'SELECT')
        or (policy.policyname = 'avatar_owner_insert' and policy.cmd = 'INSERT')
        or (policy.policyname = 'avatar_owner_update' and policy.cmd = 'UPDATE')
        or (policy.policyname = 'avatar_owner_delete' and policy.cmd = 'DELETE')
      )
      and policy.roles = array['authenticated']::name[]
      and (
        coalesce(policy.qual, '') like '%avatars%'
        or coalesce(policy.with_check, '') like '%avatars%'
      )
      and concat_ws(' ', policy.qual, policy.with_check) like '%auth.uid()%'
      and concat_ws(' ', policy.qual, policy.with_check) like '%/avatar.jpg%'
  ) <> 4 then
    raise exception 'Avatar owner policy matrix is incomplete';
  end if;
  -- Policies for other buckets may coexist on storage.objects. Their removal
  -- would be a cross-product outage, so this test owns only the avatar policy
  -- names and validates their complete authenticated-only matrix above.
end;
$test$;

-- The avatars bucket is intentionally public for image delivery; the checks
-- above freeze that explicit product decision while writes remain owner-only.
select pass('final RPC-only security and storage state is exact');
select * from finish();
rollback;
