begin;

insert into public.organizations (id, code, name)
values
  ('10000000-0000-0000-0000-000000000001', 'tenant-test-a', 'Tenant Test A'),
  ('10000000-0000-0000-0000-000000000002', 'tenant-test-b', 'Tenant Test B');

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
values (
  '20000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'tenant-a-admin@example.test', '',
  clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
  clock_timestamp(), clock_timestamp()
);

insert into public.employees (
  employee_id, auth_user_id, organization_id, name, email, role,
  center_id, status, employment_start_date
)
values (
  'TENANT-A-ADMIN',
  '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'Tenant A Admin', 'tenant-a-admin@example.test', 'Admin',
  'TENANT-A-HQ', 'Active', current_date
);

insert into public.holidays (
  organization_id, name, from_date, to_date, paid, active
)
values
  ('10000000-0000-0000-0000-000000000001', 'Tenant A Holiday', '2026-12-01', '2026-12-01', true, true),
  ('10000000-0000-0000-0000-000000000002', 'Tenant B Holiday', '2026-12-02', '2026-12-02', true, true);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '20000000-0000-0000-0000-000000000001',
  true
);

do $$
begin
  if (select count(distinct organization_id) from public.config_shifts) <> 1
    or exists(
      select 1 from public.config_shifts
      where organization_id <> '10000000-0000-0000-0000-000000000001'
    ) then
    raise exception 'config_shifts RLS leaked another tenant';
  end if;
  if (select count(distinct organization_id) from public.config_system) <> 1
    or exists(
      select 1 from public.config_system
      where organization_id <> '10000000-0000-0000-0000-000000000001'
    ) then
    raise exception 'config_system RLS leaked another tenant';
  end if;
  if (select count(*) from public.holidays) <> 1
    or exists(
      select 1 from public.holidays
      where organization_id <> '10000000-0000-0000-0000-000000000001'
    ) then
    raise exception 'holidays RLS leaked another tenant';
  end if;
end;
$$;

-- Omitted organization_id is derived from the authenticated employee.
insert into public.config_system (key, value)
values ('TENANT_TEST_SETTING', 'enabled');

do $$
begin
  if not exists (
    select 1 from public.config_system
    where organization_id = '10000000-0000-0000-0000-000000000001'
      and key = 'TENANT_TEST_SETTING'
  ) then
    raise exception 'Tenant-derived configuration insert failed';
  end if;

  begin
    insert into public.config_system (organization_id, key, value)
    values (
      '10000000-0000-0000-0000-000000000002',
      'CROSS_TENANT_WRITE',
      'blocked'
    );
    raise exception 'Cross-tenant configuration insert was not blocked';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;

reset role;

do $$
declare
  tenant_b_shift bigint;
begin
  select id into tenant_b_shift
  from public.config_shifts
  where organization_id = '10000000-0000-0000-0000-000000000002'
  order by sort_order, id
  limit 1;

  begin
    insert into public.shift_assignments (
      organization_id, employee_id, work_date, shift_id,
      note, publication_status
    )
    values (
      '10000000-0000-0000-0000-000000000001',
      'TENANT-A-ADMIN', current_date + 7, tenant_b_shift,
      'must fail', 'DRAFT'
    );
    raise exception 'Cross-tenant shift foreign key was not enforced';
  exception
    when foreign_key_violation then null;
  end;
end;
$$;

insert into public.attendance_requests (
  organization_id, employee_id, request_type, reason, status,
  from_date, to_date
)
values
  (
    '10000000-0000-0000-0000-000000000001',
    'TENANT-A-ADMIN', 'REMOTE_WORK', 'Tenant request one', 'PENDING',
    current_date + 1, current_date + 1
  ),
  (
    '10000000-0000-0000-0000-000000000001',
    'TENANT-A-ADMIN', 'BUSINESS_TRIP', 'Tenant request two', 'PENDING',
    current_date + 2, current_date + 2
  );

do $$
begin
  if not exists (
    select 1
    from public.attendance_requests
    where organization_id = '10000000-0000-0000-0000-000000000001'
      and request_code = 'REQ-000001'
  ) or not exists (
    select 1
    from public.attendance_requests
    where organization_id = '10000000-0000-0000-0000-000000000001'
      and request_code = 'REQ-000002'
  ) then
    raise exception 'Tenant request codes were not issued in sequence';
  end if;
end;
$$;

rollback;
