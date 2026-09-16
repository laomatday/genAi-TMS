-- Removes the check-out reminder, the last of the two attendance nags.
--
-- 20260916050000 took out the check-in reminder and deliberately left this one,
-- asserting in its own verify block that CHECKOUT_REMINDER survived. The owner
-- has now asked for both to go, so that assertion is what this migration undoes.
--
-- The reminder fired from the maintenance batch for every open session past its
-- expected end, every run, until the person checked out. A late check-out is
-- already visible on the home screen and already raises MISSING_CHECKOUT on the
-- timesheet a few statements further down, which is the part that actually
-- matters and is left alone. The notification only added noise on top of it.
--
-- Same fragment-patch approach as before: the helper refuses to run unless the
-- text it is replacing appears exactly once, so a body that has drifted since
-- this file was written fails loudly instead of being half-edited.
--
-- Rows already sent are deleted too. They are reminders to do something that
-- was either done hours ago or is now moot, and leaving them would mean the
-- feature is gone but the inbox still shows it.

begin;

create or replace function wf_private.patch_day_maintenance(source text, target text)
returns void language plpgsql as $patch$
declare body text; occurrences integer;
begin
  select pg_get_functiondef(p.oid) into body
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='wf_private' and p.proname='maintain_day_set_based' and p.prokind='f';
  if body is null then raise exception 'maintain_day_set_based not found'; end if;
  occurrences:=(length(body)-length(replace(body,source,'')))/length(source);
  if occurrences<>1 then
    raise exception 'expected exactly one occurrence to patch, found %', occurrences;
  end if;
  execute replace(body,source,target);
end;
$patch$;

select wf_private.patch_day_maintenance(
$old$  insert into public.workforce_notifications(
    organization_id,employee_id,dedupe_key,kind,title,body,context
  )
  select session.organization_id,session.employee_id,
    left('checkout:'||session.id::text,200),'CHECKOUT_REMINDER',
    'Ca làm đã kết thúc','Bạn còn ca chưa check-out.',
    jsonb_build_object('date',session.business_date,'work_session_id',session.id)
  from public.work_sessions session
  where session.organization_id=p_organization_id
    and session.business_date=p_work_date and session.status='OPEN'
    and session.actual_checkout is null and p_now>session.expected_end
  on conflict(employee_id,dedupe_key) do nothing;
$old$,
$new$  -- The check-out reminder used to be raised here. A missing check-out is
  -- still recorded as an exception on the timesheet below.
$new$);

drop function wf_private.patch_day_maintenance(text, text);

delete from public.workforce_notifications
where kind in ('CHECKIN_REMINDER','CHECKOUT_REMINDER');

do $verify$
declare body text; leftovers bigint;
begin
  select pg_get_functiondef(p.oid) into body
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='wf_private' and p.proname='maintain_day_set_based' and p.prokind='f';
  if body like '%CHECKOUT_REMINDER%' or body like '%CHECKIN_REMINDER%' then
    raise exception 'an attendance reminder survived the patch';
  end if;
  -- The work the batch actually exists to do has to be untouched.
  if body not like '%MISSING_CHECKOUT%'
    or body not like '%on conflict(organization_id,assignment_id) where assignment_id is not null%' then
    raise exception 'the patch removed more than it was meant to';
  end if;

  select count(*) into leftovers from public.workforce_notifications
  where kind in ('CHECKIN_REMINDER','CHECKOUT_REMINDER');
  if leftovers<>0 then
    raise exception '% reminder rows survived the delete', leftovers;
  end if;
end;
$verify$;

commit;

notify pgrst, 'reload schema';
