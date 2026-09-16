-- Repairs 20260916050000, which cut the ON CONFLICT clause one predicate short.
--
-- That clause ended with an `and (...) is distinct from (...)` comparison — the
-- guard that stopped the DO UPDATE writing rows it would not change. Removing
-- the arbiter but leaving the comparison behind left `public.work_sessions` and
-- `excluded` referenced from a plain INSERT ... SELECT, where neither exists,
-- so the statement failed to plan:
--
--   42P01: invalid reference to FROM-clause entry for table "work_sessions"
--
-- Worse than what it replaced: the old statement at least failed predictably at
-- 55000. Caught immediately by running the previously-failing job rather than
-- trusting the patch's own assertions, which passed — they checked that the
-- arbiter was gone, not that what remained still parsed.

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
$old$        and existing.session_sequence=1
    )
    and (
      public.work_sessions.policy_id,
      public.work_sessions.location_internal_id,
      public.work_sessions.location_id,
      public.work_sessions.expected_start,
      public.work_sessions.expected_end,
      public.work_sessions.status,
      public.work_sessions.exception_codes,
      public.work_sessions.paid_leave_minutes
    ) is distinct from (
      excluded.policy_id,
      excluded.location_internal_id,
      excluded.location_id,
      excluded.expected_start,
      excluded.expected_end,
      excluded.status,
      excluded.exception_codes,
      excluded.paid_leave_minutes
    );$old$,
$new$        and existing.session_sequence=1
    );$new$);

drop function wf_private.patch_day_maintenance(text, text);

do $verify$
declare body text;
begin
  select pg_get_functiondef(p.oid) into body
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='wf_private' and p.proname='maintain_day_set_based' and p.prokind='f';
  -- `excluded` may only survive where an ON CONFLICT still provides it.
  if body like '%excluded.paid_leave_minutes%' and body not like '%on conflict%excluded.paid_leave_minutes%' then
    raise exception 'an excluded reference is left outside an ON CONFLICT';
  end if;
end;
$verify$;

commit;
