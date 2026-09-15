begin;

create extension if not exists pgtap with schema extensions;
select plan(1);

-- Mutating the original customer must not mutate the frozen provisioning
-- template used by organizations created afterwards.
update public.workforce_role_capabilities
set enabled=false
where organization_id=wf_private.default_organization()
  and role='Manager'
  and capability='attendance.review';

insert into public.organizations (id, code, name)
values
  ('10000000-0000-0000-0000-000000000001', 'tenant-test-a', 'Tenant Test A'),
  ('10000000-0000-0000-0000-000000000002', 'tenant-test-b', 'Tenant Test B');

do $$
begin
  if (
    select count(*)
    from public.attendance_policies
    where organization_id in (
      '10000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000002'
    ) and active
  )<>2 then
    raise exception 'New organizations did not receive an active attendance policy';
  end if;
  if exists(
    select 1 from public.workforce_role_capabilities
    where organization_id in (
      '10000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000002'
    )
      and role='Manager'
      and capability='attendance.review'
      and not enabled
  ) then
    raise exception 'Mutable default-tenant capability leaked into new tenants';
  end if;
end;
$$;

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
values
  (
    '20000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'tenant-a-admin@example.test', '',
    clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
    clock_timestamp(), clock_timestamp()
  ),
  (
    '20000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'tenant-b-admin@example.test', '',
    clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
    clock_timestamp(), clock_timestamp()
  ),
  (
    '20000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'tenant-a-manager@example.test', '',
    clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
    clock_timestamp(), clock_timestamp()
  ),
  (
    '20000000-0000-0000-0000-000000000004',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'tenant-a-kiosk@example.test', '',
    clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
    clock_timestamp(), clock_timestamp()
  ),
  (
    '20000000-0000-0000-0000-000000000005',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'tenant-a-worker@example.test', '',
    clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
    clock_timestamp(), clock_timestamp()
  );

insert into public.employees (
  employee_id, employee_code, auth_user_id, organization_id, name, email, role,
  center_id, status, employment_start_date
)
values
  (
    'TENANT-A-ADMIN', 'TENANT-A-ADMIN',
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'Tenant A Admin', 'tenant-a-admin@example.test', 'Admin',
    'TENANT-A-HQ', 'Active', current_date
  ),
  (
    'TENANT-B-ADMIN', 'TENANT-B-ADMIN',
    '20000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000002',
    'Tenant B Admin', 'tenant-b-admin@example.test', 'Admin',
    'TENANT-B-HQ', 'Active', current_date
  ),
  (
    'TENANT-A-MANAGER', 'TENANT-A-MANAGER',
    '20000000-0000-0000-0000-000000000003',
    '10000000-0000-0000-0000-000000000001',
    'Tenant A Manager', 'tenant-a-manager@example.test', 'Manager',
    'TENANT-A-HQ', 'Active', current_date
  ),
  (
    'TENANT-A-WORKER', 'TENANT-A-WORKER',
    '20000000-0000-0000-0000-000000000005',
    '10000000-0000-0000-0000-000000000001',
    'Tenant A Worker', 'tenant-a-worker@example.test', 'Staff',
    'TENANT-A-HQ', 'Active', current_date
  ),
  (
    'TENANT-A-KIOSK', 'TENANT-A-KIOSK',
    '20000000-0000-0000-0000-000000000004',
    '10000000-0000-0000-0000-000000000001',
    'Tenant A Kiosk', 'tenant-a-kiosk@example.test', 'Kiosk',
    'TENANT-A-HQ', 'Active', current_date
  );

insert into public.employees(
  employee_id,employee_code,organization_id,name,email,role,center_id,status,employment_start_date
)
select
  'TENANT-A-SCALE-'||lpad(scale_id::text,3,'0'),
  'TENANT-A-SCALE-'||lpad(scale_id::text,3,'0'),
  '10000000-0000-0000-0000-000000000001',
  'Scale Employee '||lpad(scale_id::text,3,'0'),
  'scale-'||scale_id::text||'@example.test',
  'Staff','TENANT-A-HQ','Active',current_date
from generate_series(1,101) scale_id;

update public.employees
set direct_manager_id='TENANT-A-MANAGER'
where employee_id='TENANT-A-WORKER';

insert into public.config_system (organization_id, key, value)
values (
  '10000000-0000-0000-0000-000000000001',
  'APPROVAL_ROLES',
  '{"leave":[],"attendance":[]}'
)
on conflict (organization_id,key)
do update set value=excluded.value;

insert into public.attendance_requests (
  id,organization_id,employee_id,request_type,reason,status,
  from_date,to_date,assigned_to
)
values (
  '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'TENANT-A-WORKER','REMOTE_WORK','Approval role boundary test','PENDING',
  current_date+10,current_date+10,'TENANT-A-MANAGER'
);

-- Submit through the public command: the configured direct Manager has no Auth
-- identity, so it must not receive the request; eligible Admin does.
update public.config_system
set value='{"leave":["Manager"],"attendance":[]}'
where organization_id='10000000-0000-0000-0000-000000000001'
  and key='APPROVAL_ROLES';
update public.employees
set auth_user_id=null
where employee_id='TENANT-A-MANAGER';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '20000000-0000-0000-0000-000000000005',
  true
);
select public.workforce_command('request.submit',jsonb_build_object(
  'request_type','ANNUAL_LEAVE',
  'from_date',current_date+40,
  'to_date',current_date+40,
  'reason','End-to-end approval routing test',
  'client_request_id','40000000-0000-0000-0000-000000000001'
));
-- A transport retry with the same client command must return the original row,
-- without a second notification, audit event or workflow item.
select public.workforce_command('request.submit',jsonb_build_object(
  'request_type','ANNUAL_LEAVE',
  'from_date',current_date+40,
  'to_date',current_date+40,
  'reason','End-to-end approval routing test',
  'client_request_id','40000000-0000-0000-0000-000000000001'
));
reset role;
select set_config('request.jwt.claim.sub','',true);

update public.employees
set auth_user_id='20000000-0000-0000-0000-000000000003'
where employee_id='TENANT-A-MANAGER';
update public.config_system
set value='{"leave":[],"attendance":[]}'
where organization_id='10000000-0000-0000-0000-000000000001'
  and key='APPROVAL_ROLES';

do $$
begin
  if (select count(*) from public.attendance_requests
      where employee_id='TENANT-A-WORKER'
        and client_request_id='40000000-0000-0000-0000-000000000001')<>1 then
    raise exception 'request.submit replay created a duplicate workflow item';
  end if;
  if not exists(
    select 1 from public.attendance_requests
    where employee_id='TENANT-A-WORKER'
      and reason='End-to-end approval routing test'
      and assigned_to='TENANT-A-ADMIN'
      and fallback_to is null
  ) then
    raise exception 'request.submit assigned an ineligible or non-login approver';
  end if;
end;
$$;

-- Customer-owned uniqueness must allow two organizations to use the same
-- policy name and close the same calendar period without colliding.
insert into public.attendance_policies (organization_id, name)
values
  ('10000000-0000-0000-0000-000000000001', 'Shared Policy Name'),
  ('10000000-0000-0000-0000-000000000002', 'Shared Policy Name');

insert into public.attendance_periods (
  organization_id, period_start, period_end, status, closed_by, note
)
values
  (
    '10000000-0000-0000-0000-000000000001',
    '2020-11-01', '2020-11-30', 'CLOSED', 'TENANT-A-ADMIN',
    'Tenant A close'
  ),
  (
    '10000000-0000-0000-0000-000000000002',
    '2020-11-01', '2020-11-30', 'CLOSED', 'TENANT-B-ADMIN',
    'Tenant B close'
  );

insert into public.audit_logs (
  organization_id, actor_employee_id, action, entity_type, entity_id, metadata
)
values
  (
    '10000000-0000-0000-0000-000000000001',
    'TENANT-A-ADMIN', 'TENANT_BOUNDARY_TEST', 'organization',
    '10000000-0000-0000-0000-000000000001',
    '{"organization_id":"10000000-0000-0000-0000-000000000001"}'
  ),
  (
    '10000000-0000-0000-0000-000000000002',
    'TENANT-B-ADMIN', 'TENANT_BOUNDARY_TEST', 'organization',
    '10000000-0000-0000-0000-000000000002',
    '{"organization_id":"10000000-0000-0000-0000-000000000002"}'
  );

-- The trigger derives a missing tenant from the actor and rejects conflicting
-- actor/target evidence instead of silently reclassifying an audit record.
insert into public.audit_logs (
  actor_employee_id,action,entity_type,entity_id,metadata
)
values (
  'TENANT-A-ADMIN','TENANT_DERIVATION_TEST','employee','TENANT-A-ADMIN','{}'
);

do $$
begin
  if not exists(
    select 1 from public.audit_logs
    where action='TENANT_DERIVATION_TEST'
      and organization_id='10000000-0000-0000-0000-000000000001'
  ) then
    raise exception 'Audit organization was not derived from its actor';
  end if;
  begin
    insert into public.audit_logs(
      actor_employee_id,target_employee_id,action,entity_type,entity_id,metadata
    ) values (
      'TENANT-A-ADMIN','TENANT-B-ADMIN','TENANT_CONFLICT_TEST',
      'employee','TENANT-B-ADMIN','{}'
    );
    raise exception 'Cross-tenant audit evidence was accepted';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;

insert into public.holidays (
  organization_id, name, from_date, to_date, paid, active
)
values
  ('10000000-0000-0000-0000-000000000001', 'Tenant A Holiday', '2026-12-01', '2026-12-01', true, true),
  ('10000000-0000-0000-0000-000000000002', 'Tenant B Holiday', '2026-12-02', '2026-12-02', true, true);

insert into public.config_system(organization_id,key,value)
values(
  '10000000-0000-0000-0000-000000000001',
  'PRIVATE_SENTINEL','must-not-reach-browser'
);

insert into public.work_sessions(
  id,organization_id,employee_internal_id,employee_id,
  business_date,session_sequence,status
)
select
  ('31000000-0000-0000-0000-'||lpad(scale_id::text,12,'0'))::uuid,
  employee.organization_id,employee.internal_id,employee.employee_id,
  current_date,1,'SCHEDULED'
from generate_series(1,3) scale_id
join public.employees employee
  on employee.employee_id='TENANT-A-SCALE-'||lpad(scale_id::text,3,'0')
 and employee.organization_id='10000000-0000-0000-0000-000000000001';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '20000000-0000-0000-0000-000000000001',
  true
);

do $$
declare
  directory jsonb;
  metadata jsonb;
  first_page jsonb;
  second_page jsonb;
begin
  directory:=public.workforce_query('directory',jsonb_build_object('size',100));
  if jsonb_array_length(coalesce(directory->'rows','[]'::jsonb))<>100 then
    raise exception 'Directory RPC is not bounded to its 100-row page';
  end if;
  if exists(
    select 1 from jsonb_array_elements(directory->'rows') row
    where row->>'employee_id' like 'TENANT-B-%'
  ) then
    raise exception 'Directory RPC leaked another tenant';
  end if;
  metadata:=public.workforce_query('metadata','{}'::jsonb);
  if exists(
    select 1
    from jsonb_array_elements(coalesce(metadata->'system_settings','[]'::jsonb)) setting
    where setting->>'key'='PRIVATE_SENTINEL'
       or setting ? 'organization_id'
       or setting ? 'updated_at'
  ) then
    raise exception 'Metadata exposed a private setting or tenant internals';
  end if;
  first_page:=public.workforce_query(
    'sessions',jsonb_build_object('size',2,'team',true)
  );
  second_page:=public.workforce_query(
    'sessions',jsonb_build_object(
      'size',2,'team',true,'cursor',first_page->'next_cursor'
    )
  );
  if jsonb_array_length(first_page->'rows')<>2
    or coalesce((first_page->>'has_more')::boolean,false) is not true
    or jsonb_array_length(second_page->'rows')<>1
    or exists(
      select 1
      from jsonb_array_elements(first_page->'rows') first_row
      join jsonb_array_elements(second_page->'rows') second_row
        on first_row->>'id'=second_row->>'id'
    ) then
    raise exception 'Session keyset cursor skipped or duplicated equal date/sequence rows';
  end if;
  if has_table_privilege('authenticated','public.config_shifts','SELECT')
    or has_table_privilege('authenticated','public.config_system','SELECT')
    or has_table_privilege('authenticated','public.holidays','SELECT')
    or has_table_privilege('authenticated','public.attendance_policies','SELECT')
    or has_table_privilege('authenticated','public.attendance_periods','SELECT')
    or has_table_privilege('authenticated','public.audit_logs','SELECT') then
    raise exception 'Authenticated retained a legacy Data API table grant';
  end if;
  begin
    perform public.tms_directory_context_v1();
    raise exception 'Retired directory RPC remained executable';
  exception
    when insufficient_privilege then null;
  end;
  begin
    insert into public.config_system(key,value)
    values('LEGACY_DATA_API_WRITE','blocked');
    raise exception 'Authenticated retained legacy Data API write access';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;

reset role;

-- A role label must not bypass an explicit effective-capability deny. Exercise
-- every browser-writable configuration table directly so UI gating cannot hide
-- a permissive RLS regression.
insert into public.locations(
  center_id,location_code,organization_id,center_name,
  latitude,longitude,radius_meters,active
) values (
  'TENANT-A-SETTINGS','TENANT-A-SETTINGS',
  '10000000-0000-0000-0000-000000000001',
  'Tenant A Settings Test',10,106,200,true
);

-- QR station reachability is capability-based as well. An Admin with an
-- explicit deny is rejected, a Manager with an explicit grant is accepted,
-- and the dedicated Kiosk account remains the documented role exception.
update public.employees
set allowed_locations=array['TENANT-A-SETTINGS']::text[]
where employee_id in ('TENANT-A-MANAGER','TENANT-A-KIOSK');

insert into public.workforce_employee_capabilities(
  organization_id,employee_id,capability,enabled
) values
  (
    '10000000-0000-0000-0000-000000000001',
    'TENANT-A-ADMIN','kiosk.manage',false
  ),
  (
    '10000000-0000-0000-0000-000000000001',
    'TENANT-A-MANAGER','kiosk.manage',true
  );

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '20000000-0000-0000-0000-000000000001',
  true
);

do $$
begin
  begin
    perform public.create_attendance_qr('TENANT-A-SETTINGS');
    raise exception 'Admin kiosk.manage deny was ignored';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '20000000-0000-0000-0000-000000000003',
  true
);

do $$
declare
  response jsonb;
begin
  response := public.create_attendance_qr('TENANT-A-SETTINGS');
  if coalesce(response->>'payload','')='' then
    raise exception 'Manager kiosk.manage grant could not create QR';
  end if;
end;
$$;

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '20000000-0000-0000-0000-000000000004',
  true
);

do $$
declare
  response jsonb;
begin
  response := public.create_attendance_qr('TENANT-A-SETTINGS');
  if coalesce(response->>'payload','')='' then
    raise exception 'Dedicated Kiosk account could not create QR';
  end if;
end;
$$;

reset role;

delete from public.workforce_employee_capabilities
where organization_id='10000000-0000-0000-0000-000000000001'
  and employee_id in ('TENANT-A-ADMIN','TENANT-A-MANAGER')
  and capability='kiosk.manage';

insert into public.workforce_employee_capabilities(
  organization_id,employee_id,capability,enabled
) values (
  '10000000-0000-0000-0000-000000000001',
  'TENANT-A-ADMIN','settings.manage',false
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '20000000-0000-0000-0000-000000000001',
  true
);

do $$
begin
  begin
    perform public.workforce_command('config.patch',jsonb_build_object(
      'command_id','33000000-0000-4000-8000-000000000001',
      'expected_revision',1,
      'operations',jsonb_build_array(jsonb_build_object(
        'resource','system','op','upsert','key','LATE_TOLERANCE','value','15'
      ))
    ));
    raise exception 'settings.manage deny allowed config.patch';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.config_shifts(name,start_time,end_time,break_point,sort_order)
    values('Denied settings shift','09:00','17:00','12:00',999);
    raise exception 'settings.manage deny allowed config_shifts insert';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.config_system(key,value)
    values('DENIED_SETTINGS_INSERT','blocked');
    raise exception 'settings.manage deny allowed config_system insert';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.holidays(name,from_date,to_date,paid,active)
    values('Denied settings holiday','2026-12-20','2026-12-20',true,true);
    raise exception 'settings.manage deny allowed holidays insert';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.locations(
      center_id,center_name,latitude,longitude,radius_meters,active
    ) values ('DENIED-SETTINGS-LOCATION','Denied settings location',10,106,200,true);
    raise exception 'settings.manage deny allowed locations insert';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.attendance_policies(name)
    values('Denied settings policy');
    raise exception 'settings.manage deny allowed attendance_policies insert';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;

delete from public.workforce_employee_capabilities
where organization_id='10000000-0000-0000-0000-000000000001'
  and employee_id='TENANT-A-ADMIN'
  and capability='settings.manage';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '20000000-0000-0000-0000-000000000001',
  true
);

do $$
declare
  revision bigint;
begin
  revision:=(public.workforce_query('metadata','{}'::jsonb)->>'config_revision')::bigint;
  begin
    perform public.workforce_command('config.patch',jsonb_build_object(
      'command_id','32000000-0000-4000-8000-000000000001',
      'expected_revision',revision,
      'operations',jsonb_build_array(jsonb_build_object(
        'resource','system','op','upsert','key','PRIVATE_BROWSER_KEY','value','no'
      ))
    ));
    raise exception 'config.patch accepted an unknown browser setting';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.workforce_command('config.patch',jsonb_build_object(
      'command_id','32000000-0000-4000-8000-000000000002',
      'expected_revision',revision,
      'operations',jsonb_build_array(jsonb_build_object(
        'resource','policy','op','upsert','work_days',jsonb_build_array(1,1),
        'gps_good_accuracy_m',50,'gps_max_accuracy_m',150
      ))
    ));
    raise exception 'config.patch accepted duplicate policy work days';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.workforce_command('config.patch',jsonb_build_object(
      'command_id','32000000-0000-4000-8000-000000000003',
      'expected_revision',revision,
      'operations',jsonb_build_array(jsonb_build_object(
        'resource','policy','op','upsert','work_days',jsonb_build_array(1,2),
        'gps_good_accuracy_m',200,'gps_max_accuracy_m',100
      ))
    ));
    raise exception 'config.patch accepted inverted GPS thresholds';
  exception when sqlstate '22023' then null;
  end;
end;
$$;

reset role;

insert into public.workforce_employee_capabilities(
  organization_id,employee_id,capability,enabled
) values (
  '10000000-0000-0000-0000-000000000001',
  'TENANT-A-ADMIN','audit.view',false
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '20000000-0000-0000-0000-000000000001',
  true
);

do $$
begin
  begin
    perform public.workforce_query('audit',jsonb_build_object('page',1,'size',10));
    raise exception 'User without audit.view could read the audit RPC';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;

delete from public.workforce_employee_capabilities
where organization_id='10000000-0000-0000-0000-000000000001'
  and employee_id='TENANT-A-ADMIN'
  and capability='audit.view';

insert into public.workforce_employee_capabilities(
  organization_id,employee_id,capability,enabled
) values (
  '10000000-0000-0000-0000-000000000001',
  'TENANT-A-ADMIN','team.read_all',false
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '20000000-0000-0000-0000-000000000001',
  true
);

do $$
begin
  begin
    perform public.workforce_query('admin.sessions',jsonb_build_object(
      'from',current_date-7,'to',current_date,'size',10
    ));
    raise exception 'team.read_all deny allowed organization attendance query';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;

delete from public.workforce_employee_capabilities
where organization_id='10000000-0000-0000-0000-000000000001'
  and employee_id='TENANT-A-ADMIN'
  and capability='team.read_all';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '20000000-0000-0000-0000-000000000004',
  true
);

do $$
begin
  begin
    perform public.tms_directory_context_v1();
    raise exception 'Retired directory RPC remained executable by Kiosk';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;

do $$
begin
  begin
    update public.config_system
    set value='{}'
    where organization_id='10000000-0000-0000-0000-000000000001'
      and key='APPROVAL_ROLES';
    raise exception 'Malformed approval-role configuration was accepted';
  exception
    when invalid_parameter_value then null;
  end;
end;
$$;

-- A Manager still has the generic attendance.review capability, but this
-- tenant explicitly removed Manager from the leave approver list. The database
-- must hide the queue and reject a direct RPC call if the UI is bypassed.
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '20000000-0000-0000-0000-000000000003',
  true
);

do $$
declare
  queue jsonb;
  denied_message text;
begin
  queue := public.workforce_query('requests',jsonb_build_object(
    'team',true,'state','all','from',current_date,'to',current_date+30,
    'size',100
  ));
  if jsonb_array_length(coalesce(queue->'rows','[]'::jsonb))<>0 then
    raise exception 'Role excluded by APPROVAL_ROLES could read the reviewer RPC queue';
  end if;

  begin
    perform public.workforce_command('request.review',jsonb_build_object(
      'id','30000000-0000-0000-0000-000000000001',
      'revision',1,
      'decision','APPROVED',
      'note',''
    ));
    raise exception 'A role excluded by APPROVAL_ROLES was allowed to review';
  exception
    when insufficient_privilege then
      get stacked diagnostics denied_message=message_text;
      if denied_message not like 'Vai trò hiện tại%' then raise; end if;
  end;
end;
$$;

reset role;

do $$
begin
  if not exists(
    select 1
    from public.attendance_requests
    where employee_id='TENANT-A-WORKER'
      and reason='Approval role boundary test'
      and status='PENDING'
  ) then
    raise exception 'Rejected cross-policy review mutated the request';
  end if;
end;
$$;

update public.config_system
set value='{"leave":["Manager"],"attendance":[]}'
where organization_id='10000000-0000-0000-0000-000000000001'
  and key='APPROVAL_ROLES';

-- Being listed as an approver is not enough when the per-employee capability
-- override explicitly removes attendance.review.
insert into public.workforce_employee_capabilities(
  organization_id,employee_id,capability,enabled
) values (
  '10000000-0000-0000-0000-000000000001',
  'TENANT-A-MANAGER','attendance.review',false
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '20000000-0000-0000-0000-000000000003',
  true
);

do $$
declare
  queue jsonb;
  denied_message text;
begin
  queue := public.workforce_query('requests',jsonb_build_object(
    'team',true,'state','all','from',current_date,'to',current_date+30,
    'size',100
  ));
  if jsonb_array_length(coalesce(queue->'rows','[]'::jsonb))<>0 then
    raise exception 'User without attendance.review could read the reviewer RPC queue';
  end if;
  begin
    perform public.workforce_command('request.review',jsonb_build_object(
      'id','30000000-0000-0000-0000-000000000001',
      'revision',1,'decision','APPROVED','note',''
    ));
    raise exception 'User without attendance.review was allowed to review';
  exception
    when insufficient_privilege then
      get stacked diagnostics denied_message=message_text;
      if denied_message not like 'Không có quyền%' then raise; end if;
  end;
end;
$$;

reset role;

delete from public.workforce_employee_capabilities
where organization_id='10000000-0000-0000-0000-000000000001'
  and employee_id='TENANT-A-MANAGER'
  and capability='attendance.review';

-- team.read is also authoritative for every direct team-data policy, not just
-- the reviewer RPC. A deny override must hide the employee and request rows.
insert into public.workforce_employee_capabilities(
  organization_id,employee_id,capability,enabled
) values (
  '10000000-0000-0000-0000-000000000001',
  'TENANT-A-MANAGER','team.read',false
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '20000000-0000-0000-0000-000000000003',
  true
);

do $$
declare
  queue jsonb;
begin
  queue:=public.workforce_query('requests',jsonb_build_object(
    'team',true,'state','all','from',current_date,'to',current_date+30,
    'size',100
  ));
  if jsonb_array_length(coalesce(queue->'rows','[]'::jsonb))<>0 then
    raise exception 'User without team.read received a team queue';
  end if;
  begin
    perform public.workforce_command('request.review',jsonb_build_object(
      'id','30000000-0000-0000-0000-000000000001',
      'revision',1,'decision','APPROVED','note',''
    ));
    raise exception 'User without team.read was allowed to review';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;

delete from public.workforce_employee_capabilities
where organization_id='10000000-0000-0000-0000-000000000001'
  and employee_id='TENANT-A-MANAGER'
  and capability='team.read';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '20000000-0000-0000-0000-000000000003',
  true
);

do $$
declare
  queue jsonb;
begin
  queue := public.workforce_query('requests',jsonb_build_object(
    'team',true,'state','all','from',current_date,'to',current_date+30,
    'size',100
  ));
  if jsonb_array_length(coalesce(queue->'rows','[]'::jsonb))<>1 then
    raise exception 'Configured approver did not receive the reviewer RPC queue';
  end if;
  perform public.workforce_command('request.review',jsonb_build_object(
    'id','30000000-0000-0000-0000-000000000001',
    'revision',1,
    'decision','APPROVED',
    'note',''
  ));
end;
$$;

reset role;

do $$
begin
  if not exists(
    select 1 from public.attendance_requests
    where id='30000000-0000-0000-0000-000000000001'
      and status='APPROVED'
  ) then
    raise exception 'Configured approver could not approve the request';
  end if;
end;
$$;

do $$
declare
  tenant_b_shift bigint;
  tenant_b_policy uuid;
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

  select id into tenant_b_policy
  from public.attendance_policies
  where organization_id='10000000-0000-0000-0000-000000000002'
  order by created_at,id
  limit 1;
  begin
    update public.employees
    set attendance_policy_id=tenant_b_policy
    where employee_id='TENANT-A-WORKER';
    raise exception 'Cross-tenant attendance policy foreign key was not enforced';
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

-- Payroll close uses exclusive month locks. Every business path that can add or
-- mutate period data must join the same protocol with a shared lock, and request
-- replay must remain ahead of mutable CLOSED-period validation.
do $$
declare
  attendance_definition text:=pg_catalog.pg_get_functiondef(
    'wf_private.attendance(jsonb)'::regprocedure
  );
  submit_definition text:=pg_catalog.pg_get_functiondef(
    'wf_private.submit_request(jsonb)'::regprocedure
  );
  review_definition text:=pg_catalog.pg_get_functiondef(
    'wf_private.review_request(jsonb)'::regprocedure
  );
begin
  if position('workforce-config:' in attendance_definition)=0
    or position('workforce-config:' in attendance_definition)
      >=position('select * into policy from public.attendance_policies' in attendance_definition)
    or position('select stale.id,stale.business_date' in attendance_definition)=0
    or position('select stale.id,stale.business_date' in attendance_definition)
      >=position('perform wf_private.period_lock(' in attendance_definition)
    or position('perform wf_private.period_lock(' in attendance_definition)
      >=position(
        'v_business_date between period.period_start and period.period_end'
        in attendance_definition
      )
    or position(
      'v_business_date between period.period_start and period.period_end'
      in attendance_definition
    )>=position('select stale.* into work_session' in attendance_definition) then
    raise exception 'Attendance config/period/session lock order regressed';
  end if;
  if position('''replayed'',true' in submit_definition)=0
    or position('''replayed'',true' in submit_definition)
      >=position('period_lock(a.organization_id,first_day,last_day,false)' in submit_definition)
    or position('period_lock(a.organization_id,first_day,last_day,false)' in submit_definition)
      >=position(
        'daterange(period_start,period_end,''[]'') && daterange(first_day,last_day,''[]'')'
        in submit_definition
      ) then
    raise exception 'Request replay/period serialization order regressed';
  end if;
  if position(
      'period_lock(a.organization_id,r.from_date,r.to_date,false)'
      in review_definition
    )=0
    or position(
      'period_lock(a.organization_id,r.from_date,r.to_date,false)'
      in review_definition
    )>=position(
      'daterange(period_start,period_end,''[]'')&&daterange(r.from_date,r.to_date,''[]'')'
      in review_definition
    ) then
    raise exception 'Request review is not serialized against payroll close';
  end if;
end;
$$;

select pass('tenant, capability, cursor and lock-order invariants hold');
select * from finish();
rollback;
