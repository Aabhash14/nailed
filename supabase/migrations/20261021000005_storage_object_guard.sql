-- 20261021000005_storage_object_guard.sql
-- SEC-018: enforce the per-width byte caps (480 px: 40 KB, 960 px: 120 KB, 1600 px: 300 KB; same numbers as
-- IMAGE_SIZE_CAPS in src/lib/validation/admin.ts, KB = 1024 bytes) and the WebP MIME type in the database layer of
-- Supabase Storage, not only in the createUploadUrl action.
--
-- Why a trigger and not an RLS policy: Storage evaluates the INSERT policy on a permission dry-run BEFORE the bytes
-- arrive (metadata is still NULL then), and writes the final row with the real size/mimetype as its own privileged
-- role, which bypasses RLS. A policy can therefore check the path (it already does) but never the size. A BEFORE
-- trigger runs for every role, so it sees the final metadata. (Based on how storage-api works today; NOT verified
-- on a running stack.)
--
-- What it checks, for bucket public-media and names ending /480.webp, /960.webp or /1600.webp only:
--   * metadata.size (bytes, measured by Storage, not the client's declared size) must be <= the cap for that width;
--   * metadata.mimetype, when present, must be image/webp (the bucket allow-list already enforces this; this is a
--     second layer).
-- Rows with NULL metadata (the dry-run, and the pgTAP fixtures) pass, so nothing that worked before breaks.
-- What it cannot check: the bytes themselves (magic bytes RIFF....WEBP). Storage keeps the bytes outside Postgres,
-- so that check stays in the backend (post-upload HEAD/read, SEC-018 remediation).
-- An over-cap upload is rejected by Storage with an error; the object row is not created, so nothing is served.
--
-- Hosted Supabase may not let the `postgres` role create triggers on storage.objects (the storage schema belongs
-- to the platform). The block below is guarded: if it is refused, the migration still succeeds with a NOTICE and
-- the backend post-upload check is the only size control (devops: confirm which happened on staging).

create or replace function private.storage_public_media_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_width text;
  v_cap   bigint;
  v_size  text;
  v_mime  text;
begin
  if new.bucket_id is distinct from 'public-media' or new.metadata is null then
    return new;
  end if;
  v_width := substring(new.name from '/(480|960|1600)\.webp$');
  if v_width is null then
    return new;                      -- not an image variant path (the insert policy already refuses those for users)
  end if;
  v_cap := case v_width when '480' then 40960 when '960' then 122880 else 307200 end;

  v_size := coalesce(new.metadata ->> 'size', new.metadata ->> 'contentLength');
  if v_size ~ '^[0-9]{1,15}$' and v_size::bigint > v_cap then
    raise exception 'public-media: % px image is % bytes, the limit is % bytes', v_width, v_size, v_cap
      using errcode = '23514';
  end if;

  v_mime := lower(btrim(new.metadata ->> 'mimetype'));
  if v_mime is not null and v_mime <> 'image/webp' then
    raise exception 'public-media: only image/webp is accepted' using errcode = '23514';
  end if;
  return new;
end;
$$;

do $$
begin
  grant execute on function private.storage_public_media_guard() to authenticated, service_role;
  if exists (select 1 from pg_roles where rolname = 'supabase_storage_admin') then
    execute 'grant execute on function private.storage_public_media_guard() to supabase_storage_admin';
  end if;

  execute 'drop trigger if exists public_media_object_guard on storage.objects';
  execute 'create trigger public_media_object_guard before insert or update on storage.objects for each row execute function private.storage_public_media_guard()';
exception when others then
  raise notice 'SEC-018 storage trigger not installed (%): the backend post-upload check is the only size control', sqlerrm;
end
$$;
