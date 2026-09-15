-- Accounts are provisioned with a name-derived default password
-- (`cvtnghia@genai`). That value is guessable by anyone who knows the
-- convention, so the owner is prompted to replace it after signing in. This
-- column records whether the prompt is still owed.
--
-- `workforce_query('bootstrap')` returns `to_jsonb(employees)` as `profile`, so
-- the flag reaches the browser without any query function being rewritten.

alter table public.employees
  add column if not exists password_change_required boolean not null default false;

comment on column public.employees.password_change_required is
  'True while the account still uses the default password issued at provisioning.';

-- Only the rows that still owe a prompt are ever looked up, and they drain to
-- zero as people change their password, so keep the index off the false side.
create index if not exists employees_password_change_required_idx
  on public.employees (organization_id)
  where password_change_required;

-- Called by the profile screen straight after Supabase Auth accepts a new
-- password. It clears nothing but the reminder: an employee who calls it
-- directly only silences a prompt they are already free to dismiss, and it can
-- never grant access or alter another tenant's row.
create or replace function public.acknowledge_password_change()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Vui lòng đăng nhập.';
  end if;

  update public.employees
  set password_change_required = false,
      updated_at = clock_timestamp()
  where auth_user_id = auth.uid()
    and password_change_required;
end;
$$;

revoke all on function public.acknowledge_password_change() from public, anon;
grant execute on function public.acknowledge_password_change() to authenticated;

notify pgrst, 'reload schema';
