-- Per-employee capability overrides already back the effective-capability check,
-- but nothing returned them to the Control Center, so they could only be set by
-- writing to the table directly. Carrying them on the admin.people row lets the
-- account editor show and change them.
--
-- The shape is an object of capability -> boolean. An absent key means "follow
-- the role", which is what almost every employee carries.

create function wf_private.patch_people_capability_fragment(
  p_signature regprocedure,
  p_old text,
  p_new text
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  definition text;
  occurrences integer;
begin
  select pg_catalog.pg_get_functiondef(p_signature) into definition;
  occurrences := (length(definition) - length(replace(definition, p_old, ''))) / length(p_old);
  if occurrences <> 1 then
    raise exception 'Expected one occurrence in %, found %', p_signature, occurrences;
  end if;
  execute replace(definition, p_old, p_new);
end;
$$;

select wf_private.patch_people_capability_fragment(
  'wf_private.query_commercial(text,jsonb)'::regprocedure,
  $old$select employee.*,lower(employee.name) as sort_name$old$,
  $new$select employee.*,lower(employee.name) as sort_name,
        coalesce((
          select jsonb_object_agg(override.capability, override.enabled)
          from public.workforce_employee_capabilities override
          where override.organization_id=employee.organization_id
            and override.employee_id=employee.employee_id
        ),'{}'::jsonb) as capability_overrides$new$
);

drop function wf_private.patch_people_capability_fragment(regprocedure, text, text);

notify pgrst, 'reload schema';
