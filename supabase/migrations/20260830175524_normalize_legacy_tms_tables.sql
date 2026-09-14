-- Normalize legacy TMS tables for the genAi schema.
alter table public.leave_requests
  add column if not exists id uuid not null default gen_random_uuid(),
  add column if not exists approver_id text null,
  add column if not exists updated_at timestamptz not null default now();

-- Some legacy deployments used a text request_id; fresh installs already use
-- the UUID `id` primary key. Only normalize the legacy column when it exists.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'leave_requests'
      and column_name = 'request_id'
  ) then
    alter table public.leave_requests
      alter column request_id set default (gen_random_uuid()::text);
  end if;
end;
$$;
alter table public.leave_requests alter column reason set default '';
alter table public.leave_requests alter column manager_note set default '';
alter table public.leave_requests alter column status set default 'Pending';
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.leave_requests'::regclass
      and contype in ('p', 'u')
      and pg_get_constraintdef(oid) ~ '\(id\)'
  ) then
    create unique index if not exists leave_requests_id_uidx
      on public.leave_requests(id);
  end if;
end;
$$;
create index if not exists leave_requests_approver_idx on public.leave_requests(approver_id) where approver_id is not null;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname='leave_requests_approver_id_fkey' and conrelid='public.leave_requests'::regclass
  ) then
    alter table public.leave_requests add constraint leave_requests_approver_id_fkey foreign key (approver_id) references public.employees(employee_id) on update cascade on delete set null;
  end if;
end $$;

alter table public.kiosks
  add column if not exists updated_at timestamptz not null default now();
update public.kiosks set description = '' where description is null;
update public.kiosks set status = 'Active' where status is null;
alter table public.kiosks alter column description set default '';
alter table public.kiosks alter column description set not null;
alter table public.kiosks alter column status set default 'Active';
alter table public.kiosks alter column status set not null;
alter table public.kiosks alter column center_id set not null;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname='kiosks_center_id_fkey' and conrelid='public.kiosks'::regclass
  ) then
    alter table public.kiosks add constraint kiosks_center_id_fkey foreign key (center_id) references public.locations(center_id) on update cascade on delete restrict;
  end if;
end $$;

create index if not exists kiosks_center_idx on public.kiosks(center_id, status);
create index if not exists attendance_explanations_approver_idx on public.attendance_explanations(approver_id) where approver_id is not null;
