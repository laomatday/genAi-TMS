-- Creating a rotating attendance QR is a privileged Control Center action.
-- Keep the dedicated Kiosk account as the sole role-based exception; every
-- human operator must hold the effective kiosk.manage capability, including
-- employee-level allow/deny overrides.

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $migration$
declare
  definition text;
  old_fragment text := $old$if actor.role not in ('Admin','Director','HR','Kiosk') then
    raise exception 'Tài khoản không có quyền mở trạm QR.';
  end if;$old$;
  new_fragment text := $new$if actor.role <> 'Kiosk'
    and not wf_private.employee_capable(
      actor.organization_id,
      actor.employee_id,
      'kiosk.manage'
    ) then
    raise exception 'Tài khoản không có quyền mở trạm QR.' using errcode = '42501';
  end if;$new$;
  occurrences integer;
begin
  select pg_catalog.pg_get_functiondef(
    'tms_private.create_attendance_qr_v1(text)'::regprocedure
  ) into definition;

  occurrences := (
    length(definition) - length(replace(definition, old_fragment, ''))
  ) / length(old_fragment);
  if occurrences <> 1 then
    raise exception 'Could not safely patch create_attendance_qr_v1 authorization';
  end if;

  execute replace(definition, old_fragment, new_fragment);
end;
$migration$;

notify pgrst, 'reload schema';
