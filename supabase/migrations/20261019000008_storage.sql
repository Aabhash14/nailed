-- 20261019000008_storage.sql
-- Public media bucket: pre-sized WebP variants only (contract createUploadUrl).
-- Reads: the bucket is public, so object URLs work without any SELECT policy. We deliberately add NO
--        anon select policy on storage.objects, which also prevents anon from LISTING the bucket.
-- Writes: owner only (RLS below), and only paths shaped <folder>/<uuid>/<480|960|1600>.webp.
-- Per-width size caps (40 / 120 / 300 KB) cannot be expressed in bucket config; the createUploadUrl action
-- enforces them. The bucket-wide limit below is the 300 KB ceiling.
-- Cache-Control (public, max-age=31536000, immutable) is set by the uploader (cacheControl option), not here.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('public-media', 'public-media', true, 307200, array['image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "public-media owner insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'public-media'
    and public.is_owner()
    and name ~ '^(menu|products|site)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(480|960|1600)\.webp$'
  );

-- Replaced photos get a new group id and the old group is deleted, never overwritten, so no UPDATE policy.
create policy "public-media owner delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'public-media' and public.is_owner());

-- Staff (owner/staff) may read object metadata through the API if the admin UI needs it.
create policy "public-media staff select" on storage.objects
  for select to authenticated
  using (bucket_id = 'public-media' and public.is_staff());
