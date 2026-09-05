-- Normalize remaining product-brand text without changing RPC behavior or grants.
do $migration$
declare
  attendance_rpc regprocedure := to_regprocedure(
    'public.record_qr_attendance(text,double precision,double precision,double precision)'
  );
  current_definition text;
  normalized_definition text;
begin
  if attendance_rpc is null then
    return;
  end if;

  select pg_get_functiondef(attendance_rpc)
  into current_definition;

  normalized_definition := replace(
    current_definition,
    'Vi' || 'ant TMS',
    'genAi TMS'
  );

  if normalized_definition is distinct from current_definition then
    execute normalized_definition;
  end if;
end;
$migration$;
