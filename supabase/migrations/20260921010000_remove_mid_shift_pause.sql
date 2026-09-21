-- Removes the mid-shift pause, and clears the setting nothing reads.
--
-- The pause was used eight times and resumed once.
--
-- The reason is in the order of the checks. Pause and resume ran past the
-- geofence test before reaching their own branch, so both required standing
-- inside the branch's 200 m radius — and stepping outside that radius is what a
-- lunch break is. People could pause at their desk and then not resume, because
-- by the time they tried they were at lunch.
--
-- An unresumed pause is not a harmless leftover. Check-out computes unpaid time
-- as break_minutes plus everything since break_started_at, so a pause at noon
-- that was never resumed swallows the whole afternoon. On 18/09 seven people
-- carry 423 to 443 minutes of deducted break against zero work minutes: a full
-- day each, recorded as unpaid.
--
-- It was also never needed. The policy already deducts unpaid_break_minutes —
-- 120 here — from any shift of six hours or more, automatically and without
-- anybody tapping anything. And a genuine break long enough to matter is now
-- better recorded as two sessions: check out, check in again, which the system
-- handles and which the home screen stopped blocking.
--
-- So the actions are refused. No session is paused right now, so nothing is
-- stranded by this. break_minutes and the automatic deduction stay exactly as
-- they are; only the manual control goes.
--
-- The damaged days are deliberately left alone. Rewriting seven people's hours
-- is the owner's call, not a migration's, and the explanation flow already
-- credits a full day once a manager approves one.

begin;

create or replace function wf_private.patch_function(p_name text, source text, target text)
returns void language plpgsql as $patch$
declare body text; occurrences integer;
begin
  select pg_get_functiondef(p.oid) into body
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='wf_private' and p.proname=p_name and p.prokind='f';
  if body is null then raise exception '% not found', p_name; end if;
  occurrences:=(length(body)-length(replace(body,source,'')))/greatest(length(source),1);
  if occurrences<>1 then
    raise exception 'expected exactly one occurrence in %, found %', p_name, occurrences;
  end if;
  execute replace(body,source,target);
end;
$patch$;

select wf_private.patch_function('attendance',
$old$  if v_command_id is null or action not in ('checkin','checkout','pause','resume') then$old$,
$new$  if action in ('pause','resume') then
    raise exception 'Tính năng tạm dừng ca đã được gỡ bỏ. Hãy check-out rồi check-in lại.' using errcode='22023';
  end if;
  if v_command_id is null or action not in ('checkin','checkout') then$new$);

drop function wf_private.patch_function(text, text, text);

-- OFF_DAYS: written by a control in the admin screen, read by nothing. Working
-- days come from attendance_policies.work_days. The control is gone; the row
-- goes with it, so nobody finds it later and assumes it means something.
delete from public.config_system where key='OFF_DAYS';

do $verify$
declare body text;
begin
  select pg_get_functiondef(p.oid) into body
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='wf_private' and p.proname='attendance';
  if body not like '%Tính năng tạm dừng ca đã được gỡ bỏ%' then
    raise exception 'pause is still accepted';
  end if;
  -- Check-in and check-out must be untouched.
  if body not like '%action not in (''checkin'',''checkout'')%' then
    raise exception 'the allowed action list is not what it should be';
  end if;
  if body not like '%ALREADY_OPEN%' or body not like '%OUTSIDE_GEOFENCE%' then
    raise exception 'the patch removed more of the attendance command than intended';
  end if;

  if exists(select 1 from public.config_system where key='OFF_DAYS') then
    raise exception 'OFF_DAYS survived';
  end if;
  -- The setting that actually decides working days has to still be there.
  if not exists(select 1 from public.attendance_policies where work_days is not null) then
    raise exception 'no policy defines working days';
  end if;
end;
$verify$;

commit;

notify pgrst, 'reload schema';
