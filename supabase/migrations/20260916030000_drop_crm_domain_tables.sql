-- Removes the education/CRM tables that shared this Postgres instance with the
-- workforce system. They are the last remnant of a different application: a
-- learning-centre CRM whose final write was in March 2026, six months before
-- this migration.
--
-- Unlike the tables dropped in 20260916020000, these still held rows:
--
--   session_balances   120   sessions bought and used per enrolment
--   students            24   learner records, incl. guardian name and phone
--   payments            24   tuition payments, amounts and receipts
--   enrollments         24   class enrolments
--   levels               8   course levels
--   courses              3   course catalogue
--   subjects             1   subject catalogue
--
-- Removing them destroys those records permanently, and they were not backed
-- up first. That was the owner's explicit instruction after being shown the
-- contents, the row counts and the alternative of dumping them to a file.
--
-- The same three checks as the previous migration were applied: no function in
-- public/wf_private/tms_private reads them, nothing depends on them, and a
-- plain `drop table` with no CASCADE succeeded in a rolled-back transaction.
-- Nothing in the workforce system referenced them at any point — no shared
-- foreign keys, no shared functions. The only thing they shared was the
-- database.

begin;

do $migration$
declare
  doomed text[]:=array[
    -- leaf tables first; levels and courses both point at subjects
    'session_balances','payments','enrollments','students',
    'levels','courses','subjects'
  ];
  survivor text;
  target text;
begin
  -- Re-checked at apply time rather than trusting the list above.
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
  from unnest(array['session_balances','payments','enrollments','students',
                    'levels','courses','subjects']) t
  where to_regclass('public.'||t) is not null;
  if remaining is not null then
    raise exception 'tables survived the drop: %', remaining;
  end if;
  -- The workforce system must be entirely intact.
  if to_regclass('public.employees') is null
    or to_regclass('public.work_sessions') is null
    or to_regclass('public.timesheets') is null
    or to_regclass('public.attendance_requests') is null then
    raise exception 'a workforce table was removed';
  end if;
  if (select count(*) from public.employees)=0 then
    raise exception 'employees is empty after the drop';
  end if;
end;
$verify$;

commit;

notify pgrst, 'reload schema';
