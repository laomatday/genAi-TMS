begin;

create extension if not exists pgtap with schema extensions;
select plan(6);

-- DEVICE_LOCK_ROLES decides two things that must agree: whether an employee ever
-- binds a device, and whether the attendance command asks them to prove one. When
-- they disagreed, an exempt role had no grant, could never obtain one, and could
-- never clock in.

select is(
  wf_private.device_lock_required('__khong_ton_tai__'),
  true,
  'An unknown employee is never waved through'
);

select is(
  wf_private.device_lock_required(employee_id),
  false,
  'A Kiosk station is never device locked'
) from public.employees where role='Kiosk' limit 1;

-- The tenant policy ships without Admin, so an Admin with no override is exempt.
select is(
  wf_private.device_lock_required(employee_id),
  false,
  'Admin follows the role policy and is exempt by default'
) from public.employees where role='Admin' and device_lock_required is null limit 1;

select is(
  wf_private.device_lock_required(employee_id),
  true,
  'An everyday role stays locked'
) from public.employees where role='Staff' and device_lock_required is null limit 1;

-- The per-employee override has to win in both directions.
do $$
declare target text;
begin
  select employee_id into target from public.employees where role='Staff' limit 1;
  update public.employees set device_lock_required=false where employee_id=target;
end $$;
select is(
  wf_private.device_lock_required(employee_id),
  false,
  'An explicit false unlocks a role the policy locks'
) from public.employees where role='Staff' and device_lock_required is false limit 1;

do $$
declare target text;
begin
  select employee_id into target from public.employees where role='Admin' limit 1;
  update public.employees set device_lock_required=true where employee_id=target;
end $$;
select is(
  wf_private.device_lock_required(employee_id),
  true,
  'An explicit true locks a role the policy exempts'
) from public.employees where role='Admin' and device_lock_required is true limit 1;

select * from finish();
rollback;
