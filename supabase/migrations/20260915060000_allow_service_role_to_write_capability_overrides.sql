-- The account editor writes per-employee capability overrides through the
-- admin-users Edge Function, which runs as service_role. That role could read
-- workforce_employee_capabilities but not write it, so saving any account failed
-- with CAPABILITY_OVERRIDE_FAILED — including accounts with no override at all,
-- because the replace always began with a delete.
--
-- The same function already inserts employees and audit_logs; this grant puts
-- the capability table on the same footing. Reading stays available to nobody
-- else: the browser still reaches these rows only through workforce_query, and
-- authorization is still the capability check in Postgres, never the client.

grant insert, update, delete on public.workforce_employee_capabilities to service_role;

do $migration$
begin
  if not has_table_privilege('service_role', 'public.workforce_employee_capabilities', 'insert')
    or not has_table_privilege('service_role', 'public.workforce_employee_capabilities', 'delete') then
    raise exception 'service_role still cannot maintain capability overrides';
  end if;
  -- The browser must not have gained anything here.
  if has_table_privilege('authenticated', 'public.workforce_employee_capabilities', 'select')
    or has_table_privilege('anon', 'public.workforce_employee_capabilities', 'select') then
    raise exception 'capability overrides must stay unreadable outside the RPC surface';
  end if;
end;
$migration$;

notify pgrst, 'reload schema';
