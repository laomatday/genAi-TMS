-- Wires the stored credit into the two paths that matter: the one that writes a
-- day, and the one the home screen reads.
--
-- The previous migration defined the rule and backfilled it. On its own that is
-- a column nobody maintains and nobody reads.

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

-- 1. Keep it fresh. The day aggregate is rebuilt on every attendance command,
--    so the credit is recomputed in the same breath and cannot lag behind the
--    hours it is derived from.
select wf_private.patch_function('refresh_timesheet_from_sessions',
$old$  where public.timesheets.status<>'LOCKED';
end;$old$,
$new$  where public.timesheets.status<>'LOCKED';

  perform wf_private.recompute_work_credit(
    p_organization_id, employee.employee_id, p_business_date
  );
end;$new$);

-- 2. Read it. 'days' stops meaning "days with a check-in" and starts meaning
--    the credit actually earned, which is what every screen was supposed to be
--    showing.
--
--    SCHEDULED rows have to be included now. The maintenance batch writes a
--    placeholder for an approved leave day or a public holiday and leaves it
--    SCHEDULED, so excluding them threw away exactly the two cases the owner
--    asked to have counted. A scheduled day nobody attended carries a credit of
--    zero, so including them adds nothing else.
select wf_private.patch_function('bootstrap_fast',
$old$    'days',count(*) filter(where actual_checkin is not null),$old$,
$new$    'days',coalesce(sum(work_credit),0),$new$);

select wf_private.patch_function('bootstrap_fast',
$old$    and status not in ('SCHEDULED','CANCELLED');$old$,
$new$    and status<>'CANCELLED';$new$);

drop function wf_private.patch_function(text, text, text);

do $verify$
declare body text;
begin
  select pg_get_functiondef(p.oid) into body
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='wf_private' and p.proname='refresh_timesheet_from_sessions';
  if body not like '%recompute_work_credit%' then
    raise exception 'the day refresh does not recompute the credit';
  end if;

  select pg_get_functiondef(p.oid) into body
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='wf_private' and p.proname='bootstrap_fast';
  if body not like '%sum(work_credit)%' then
    raise exception 'the summary does not read the credit';
  end if;
  if body like '%not in (''SCHEDULED'',''CANCELLED'')%' then
    raise exception 'the summary still discards leave and holiday placeholders';
  end if;
  -- The parts that were not the point must survive.
  if body not like '%remaining_leave%' or body not like '%exceptions%' then
    raise exception 'the patch removed more of the summary than it was meant to';
  end if;
end;
$verify$;

commit;

notify pgrst, 'reload schema';
