-- Two changes to how a request gets decided, both asked for after the pilot
-- walkthrough hit them from opposite sides.
--
-- 1. Leave, overtime and business travel ran Manager then HR. The manager who
--    approved step 1 kept seeing the request in their queue, could not act on
--    it, and nobody was told it had moved. One level of approval is what this
--    tenant actually wants, so step 2 goes.
--
-- 2. Reviewing somebody else's step demanded an aal2 session. No account in
--    this deployment has an MFA factor enrolled and the app has no enrolment
--    screen, so that branch could never be satisfied by anyone — it read as a
--    control but behaved as a dead end. HR and Admin already hold
--    attendance.review.override; the capability, a written reason and the audit
--    record are the controls that stay.
--
-- In-flight instances keep the steps they were created with. One request is
-- currently parked on an active HR step; it stays assigned to HR, who can
-- clear it normally, and an override-capable reviewer can now clear it too.
-- Nothing already in motion is decided by this migration.

begin;

-- 1. Drop the second approval level from the definitions that carry one.
do $migration$
declare removed integer;
begin
  with doomed as (
    delete from public.workflow_definition_steps step
    using public.workflow_definitions definition
    where definition.id=step.definition_id
      and step.step_no=2
      and definition.request_type in ('TIME_OFF','OVERTIME','BUSINESS')
    returning step.definition_id
  )
  select count(*) into removed from doomed;
  if removed=0 then
    raise exception 'expected second approval steps to remove, found none';
  end if;
  -- Every definition must still be able to start: no step_no=1, no workflow.
  if exists(
    select 1 from public.workflow_definitions definition
    where not exists(
      select 1 from public.workflow_definition_steps step
      where step.definition_id=definition.id and step.step_no=1
    )
  ) then
    raise exception 'a workflow definition lost its first approval step';
  end if;
  raise notice 'removed % second-level approval step(s)', removed;
end;
$migration$;

-- 2. Let an override-capable reviewer decide a step assigned to someone else
--    without an aal2 session. Patched as a fragment so the rest of
--    review_request_commercial stays exactly as deployed.
create or replace function wf_private.patch_review_mfa(source text, target text)
returns void language plpgsql as $patch$
declare body text; occurrences integer;
begin
  select pg_get_functiondef(p.oid) into body
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='wf_private' and p.proname='review_request_commercial' and p.prokind='f';
  if body is null then raise exception 'review_request_commercial not found'; end if;
  occurrences:=(length(body)-length(replace(body,source,'')))/length(source);
  if occurrences<>1 then
    raise exception 'expected exactly one aal2 gate to patch, found %', occurrences;
  end if;
  execute replace(body,source,target);
end;
$patch$;

select wf_private.patch_review_mfa(
$old$    if coalesce((select auth.jwt()->>'aal'),'aal1')<>'aal2' then
      raise exception 'Duyệt thay người khác yêu cầu xác thực hai lớp.'
        using errcode='42501';
    end if;
$old$,
$new$    -- Authorization for deciding another reviewer's step is the
    -- attendance.review.override capability plus the written reason checked
    -- just above, both recorded in the audit entry that follows.
$new$);

drop function wf_private.patch_review_mfa(text, text);

do $verify$
declare body text;
begin
  select pg_get_functiondef(p.oid) into body
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='wf_private' and p.proname='review_request_commercial' and p.prokind='f';
  if body like '%Duyệt thay người khác yêu cầu xác thực hai lớp%' then
    raise exception 'the aal2 gate survived the patch';
  end if;
  -- The controls that replace it must still be in the function.
  if body not like '%attendance.review.override%' or body not like '%WORKFLOW_REVIEW_OVERRIDE%' then
    raise exception 'override capability check or audit trail was lost';
  end if;
end;
$verify$;

commit;

notify pgrst, 'reload schema';
