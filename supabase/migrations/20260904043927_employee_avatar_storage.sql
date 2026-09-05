-- Public reads let every app surface render an avatar while writes remain owner-only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "avatar_owner_select" on storage.objects;
drop policy if exists "avatar_owner_insert" on storage.objects;
drop policy if exists "avatar_owner_update" on storage.objects;
drop policy if exists "avatar_owner_delete" on storage.objects;

create policy "avatar_owner_select"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'avatars'
  and name = (select auth.uid())::text || '/avatar.jpg'
);

create policy "avatar_owner_insert"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'avatars'
  and name = (select auth.uid())::text || '/avatar.jpg'
);

create policy "avatar_owner_update"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'avatars'
  and name = (select auth.uid())::text || '/avatar.jpg'
)
with check (
  bucket_id = 'avatars'
  and name = (select auth.uid())::text || '/avatar.jpg'
);

create policy "avatar_owner_delete"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'avatars'
  and name = (select auth.uid())::text || '/avatar.jpg'
);

create or replace function public.set_my_avatar(p_url text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  expected_path text;
begin
  if auth.uid() is null then
    raise exception 'Vui lòng đăng nhập.';
  end if;

  expected_path := '/storage/v1/object/public/avatars/' || auth.uid()::text || '/avatar.jpg';
  if p_url is null or length(trim(p_url)) > 2048 or position(expected_path in p_url) = 0 then
    raise exception 'Đường dẫn ảnh đại diện không hợp lệ.';
  end if;

  update public.employees
  set avatar_url = trim(p_url),
      face_ref_url = trim(p_url),
      updated_at = clock_timestamp()
  where auth_user_id = auth.uid();

  if not found then
    raise exception 'Không tìm thấy hồ sơ nhân viên.';
  end if;
end;
$$;

revoke all on function public.set_my_avatar(text) from public, anon;
grant execute on function public.set_my_avatar(text) to authenticated;
