-- Removes the first generation of four workforce tables, each of which was
-- replaced by a later design that is the one actually carrying the pilot.
--
--   attendance        1 row    superseded by work_sessions (110) + timesheets (109)
--   leave_requests    0 rows   superseded by attendance_requests (7)
--   notifications     1 row    superseded by workforce_notifications (21)
--   schedule          0 rows   superseded by shift_assignments + config_shifts
--
-- The two surviving rows are destroyed permanently and were not dumped to a
-- file first. That was the owner's explicit instruction after being shown the
-- row counts and offered the alternative.
--
-- Their age is visible in the schema itself: `attendance` stores employee_name
-- and location_name inline on every row and has no organization_id column at
-- all, so it predates the system becoming multi-tenant. `schedule` is the same
-- shape.
--
-- A naive reference scan makes these look load-bearing — 19 functions appear to
-- mention `attendance` and 9 mention `schedule`. Every one of those is a false
-- positive: the matches are capability strings ('attendance.self',
-- 'schedule.manage'), the resource name 'schedule' (which reads
-- shift_assignments, not this table), and the unrelated function
-- wf_private.attendance. Matching only real table positions — from, join, into,
-- update, delete from — leaves:
--
--   attendance, leave_requests  ->  wf_private.refresh_tms_exceptions_v2
--   notifications               ->  public.mark_notification_read,
--                                   public.notify_tms_review_result
--   schedule                    ->  nothing at all
--
-- Those three functions are themselves dead. Nothing calls
-- refresh_tms_exceptions_v2 or mark_notification_read: not cron (the single job
-- runs wf_private.run_automation), not another function, and not the browser —
-- neither is granted to `authenticated`, and the readiness guard has forbidden
-- the first by name since before this migration. notify_tms_review_result is
-- reached only by a trigger on leave_requests, a table with no rows, so it has
-- never fired.
--
-- A scan of function *bodies* misses one more dependency, which a rolled-back
-- rehearsal of this migration surfaced: tms_private.attendance_json takes the
-- `attendance` row type as its argument, so Postgres refuses to drop the table
-- while it exists. It is a serializer for the old row shape and nothing calls
-- it. It is dropped here by name rather than by CASCADE, and the guard below
-- now checks argument and return types too, so the next table drop does not
-- have to rediscover this the same way.
--
-- So the functions go first and the tables follow, with both scans re-run in
-- between rather than trusted from up here.

begin;

-- On leave_requests, so it would fall with the table; dropped explicitly so the
-- function below can be removed without CASCADE.
drop trigger if exists leave_requests_notify_status on public.leave_requests;

drop function if exists public.notify_tms_review_result();
drop function if exists public.mark_notification_read(uuid);
drop function if exists wf_private.refresh_tms_exceptions_v2(date, date);
drop function if exists tms_private.attendance_json(public.attendance);

do $migration$
declare
  doomed text[]:=array['attendance','leave_requests','notifications','schedule'];
  target text;
  survivor text;
begin
  foreach target in array doomed loop
    -- Only real table positions. The loose \m<name>\M match used by the earlier
    -- drop migrations reports every capability string as a reference here.
    select n.nspname||'.'||p.proname into survivor
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where p.prokind='f' and n.nspname in ('public','wf_private','tms_private')
      and p.prosrc ~* ('(from|join|into|update|delete\s+from)\s+(public\.)?'||target||'\M')
    limit 1;
    if survivor is not null then
      raise exception 'public.% is still read by %, refusing to drop it', target, survivor;
    end if;

    select c.relname into survivor
    from pg_constraint k join pg_class c on c.oid=k.conrelid
    where k.confrelid=to_regclass('public.'||target)
    limit 1;
    if survivor is not null then
      raise exception 'public.% is still referenced by a foreign key on %', target, survivor;
    end if;

    -- A function that takes or returns the table's row type blocks the drop
    -- without ever naming the table in its body.
    select n.nspname||'.'||p.proname into survivor
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (select c.reltype from pg_class c where c.oid=to_regclass('public.'||target))
          = any(array_append(p.proargtypes::oid[], p.prorettype))
    limit 1;
    if survivor is not null then
      raise exception 'the row type of public.% is used by %, refusing to drop it', target, survivor;
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
  from unnest(array['attendance','leave_requests','notifications','schedule']) t
  where to_regclass('public.'||t) is not null;
  if remaining is not null then
    raise exception 'tables survived the drop: %', remaining;
  end if;

  -- The generation that replaced them has to be untouched, rows included.
  if to_regclass('public.work_sessions') is null
    or to_regclass('public.timesheets') is null
    or to_regclass('public.attendance_requests') is null
    or to_regclass('public.workforce_notifications') is null
    or to_regclass('public.shift_assignments') is null then
    raise exception 'a surviving workforce table is missing';
  end if;
  if (select count(*) from public.employees)<>43 then
    raise exception 'employees is no longer 43 rows';
  end if;
  if (select count(*) from public.work_sessions)=0
    or (select count(*) from public.workforce_notifications)=0 then
    raise exception 'a replacement table lost its rows';
  end if;
end;
$verify$;

commit;

notify pgrst, 'reload schema';
