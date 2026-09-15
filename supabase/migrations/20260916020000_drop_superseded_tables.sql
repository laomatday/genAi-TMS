-- Removes 17 tables that nothing in the system reads or writes any more.
--
-- Each one was verified three ways before landing here:
--   1. no function in public/wf_private/tms_private mentions it,
--   2. no view, foreign key or policy depends on it,
--   3. a plain `drop table` (no CASCADE) in a rolled-back transaction succeeded.
--
-- All three were needed. A clean DROP alone proves nothing, because plpgsql
-- function bodies are not dependency-tracked: public.leave_requests drops just
-- as cleanly, yet wf_private.refresh_tms_exceptions_v2 and
-- public.notify_tms_review_result both read it. It is deliberately NOT dropped
-- here, and neither are attendance, attendance_commands, attendance_events,
-- notifications, holidays or schedule, which are all still referenced.
--
-- Two groups:
--
-- Superseded by the workforce domain, all empty except where noted:
--   kiosks, kiosk_sessions          -> qr_stations
--   config_holidays                 -> holidays
--   config_schedule                 -> config_shifts
--   explanations                    -> attendance_requests
--   attendance_explanations         -> attendance_requests
--   user_notifications              -> workforce_notifications
--
-- attendance_explanations held one row, a test record left by ADMIN001 on
-- 2026-09-05 against work date 2026-08-01 — reason "em ốm", approved by
-- ADMIN001 with the note "lười quá nha". It is recorded here rather than
-- migrated, because the row is a test and the workflow that produced it no
-- longer exists.
--
-- Built but never wired to anything, all empty:
--   scim_credentials, scim_events   -> no SCIM provisioning was ever enabled
--   classes, config_course, crm_attendance_logs, trial_sessions,
--   interactions, kpis, teams, monthly_stats
--
-- The education/CRM tables that still hold rows — students, enrollments,
-- payments, session_balances, courses, levels, subjects — are left untouched.
-- They belong to a different application and contain learner records and
-- payment history; removing those is a separate, explicit decision.

begin;

do $migration$
declare
  doomed text[]:=array[
    -- children first: kiosk_sessions carries a policy that reads kiosks
    'kiosk_sessions','kiosks',
    'config_holidays','config_schedule','explanations','user_notifications',
    'attendance_explanations',
    'scim_events','scim_credentials',
    'crm_attendance_logs','classes','config_course','trial_sessions',
    'interactions','kpis','teams','monthly_stats'
  ];
  survivor text;
  target text;
begin
  -- Guard against dropping something that gained a reader since this migration
  -- was written. Checked against live function bodies, not against a list.
  foreach target in array doomed loop
    select n.nspname||'.'||p.proname into survivor
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where p.prokind='f' and n.nspname in ('public','wf_private','tms_private')
      and pg_get_functiondef(p.oid) ~ ('\m(public\.)?'||target||'\M')
    limit 1;
    if survivor is not null then
      raise exception 'public.% is read by %, refusing to drop it', target, survivor;
    end if;
  end loop;

  foreach target in array doomed loop
    if to_regclass('public.'||target) is null then
      raise notice 'public.% already absent, skipping', target;
    else
      execute format('drop table public.%I', target);
    end if;
  end loop;
end;
$migration$;

do $verify$
declare remaining text;
begin
  select string_agg(t, ', ') into remaining
  from unnest(array[
    'kiosk_sessions','kiosks','config_holidays','config_schedule','explanations',
    'user_notifications','attendance_explanations','scim_events','scim_credentials',
    'crm_attendance_logs','classes','config_course','trial_sessions','interactions',
    'kpis','teams','monthly_stats'
  ]) t
  where to_regclass('public.'||t) is not null;
  if remaining is not null then
    raise exception 'tables survived the drop: %', remaining;
  end if;
  -- The tables that are still in use must all still be here.
  if to_regclass('public.leave_requests') is null
    or to_regclass('public.holidays') is null
    or to_regclass('public.qr_stations') is null
    or to_regclass('public.workforce_notifications') is null
    or to_regclass('public.students') is null then
    raise exception 'a table that is still in use was removed';
  end if;
end;
$verify$;

commit;

notify pgrst, 'reload schema';
