-- 20261023000001_storage_guard_dry_run.sql
-- BUG-016 (blocker): the SEC-018 trigger public_media_object_guard (20261021000005) rejected storage-api's own
-- permission dry-run with 23514 "only image/webp is accepted", so every createSignedUploadUrl failed.
-- Forward fix: replace private.storage_public_media_guard() only. The trigger itself is unchanged (if the platform
-- refused it in 20261021000005, there is still no trigger and this function is simply unused).
--
-- How storage-api 1.82 writes an object (read from /app/dist in the storage-api v1.82.1 image, 2026-10-23):
--   a) POST /object/upload/sign/<bucket>/<path> -> signUploadObjectUrl -> uploader.canUpload -> db.testPermission:
--      INSERT INTO storage.objects inside a transaction that is always rolled back (RLS dry-run, as the caller).
--      metadata = {"mimetype": <Content-Type of the SIGN request, e.g. application/json>,
--                  "contentLength": <Content-Length of the SIGN request>}   (absent keys dropped; may be {}).
--   b) PUT /object/upload/sign/... (the real upload) -> uploader.upload -> prepareUpload -> the same dry-run with
--      metadata = {"mimetype": <client Content-Type>, "contentLength": <client-declared length>,
--                  "contentEncoding": ...}   -> client-declared, not measured.
--   c) bytes written to the backend; backend.uploadObject/headObject returns the MEASURED metadata
--      {"eTag", "size", "mimetype", "cacheControl", "lastModified", "contentLength", "httpStatusCode"}.
--   d) completeUpload: one more dry-run as the caller with the measured metadata, then
--      INSERT ... ON CONFLICT DO UPDATE as the storage superuser with the measured metadata (the row that is kept).
--   The same applies to TUS and S3 multipart (both finish through completeUpload with headObject metadata) and to
--   copy (destination metadata is copied from the source object, so it carries a measured "size").
-- So: only rows whose metadata has a "size" key carry Storage-measured facts. Dry-runs (a, b) never have it.
--
-- New rule, bucket public-media, names ending /480.webp, /960.webp or /1600.webp:
--   * metadata NULL, or no "size" key (dry-run / pre-check / delete marker / pgTAP path fixture): pass. The insert
--     RLS policy still checks the path and owner role on the dry-run; the bucket allow-list still checks MIME.
--   * "size" present (the real object): size must be a whole number <= the cap for that width (480: 40 KB,
--     960: 120 KB, 1600: 300 KB; KB = 1024; same as IMAGE_SIZE_CAPS in src/lib/validation/admin.ts), and mimetype
--     must be image/webp (parameters after ';' ignored). A missing or non-numeric size, or a missing mimetype, is
--     refused (fail closed on the real row).
--   * UPDATE that changes neither metadata nor name nor bucket (last_accessed_at, owner, archive flags): pass.
--     A rename into a variant path (move) is checked like a new object.
-- Error code is now 42501 (was 23514): storage-api maps 42501 to a 403 AccessDenied carrying our message, while
-- 23514 became a generic 500 "database error", which the app logs and shows as INTERNAL. Messages keep the
-- "public-media:" prefix so they can be told apart from an RLS refusal ("new row violates row-level security policy").
-- Still not checkable here: the bytes themselves (RIFF....WEBP). The backend attach-time check stays (SEC-018).

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
  if new.bucket_id is distinct from 'public-media' then
    return new;
  end if;

  -- Not a measured object: storage-api dry-run (sign URL, upload pre-check), delete marker, or a bare path row.
  if new.metadata is null or jsonb_typeof(new.metadata) <> 'object' or not (new.metadata ? 'size') then
    return new;
  end if;

  -- Nothing about the stored content or its path changed (e.g. last_accessed_at, owner, versioning flags).
  if tg_op = 'UPDATE'
     and new.metadata is not distinct from old.metadata
     and new.name is not distinct from old.name
     and new.bucket_id is not distinct from old.bucket_id then
    return new;
  end if;

  v_width := substring(new.name from '/(480|960|1600)\.webp$');
  if v_width is null then
    return new;                      -- not an image variant path (the insert policy already refuses those for users)
  end if;
  v_cap := case v_width when '480' then 40960 when '960' then 122880 else 307200 end;

  v_size := new.metadata ->> 'size';
  if v_size is null or v_size !~ '^[0-9]{1,15}$' then
    raise exception 'public-media: % px image has no measured size', v_width
      using errcode = '42501';
  end if;
  if v_size::bigint > v_cap then
    raise exception 'public-media: % px image is % bytes, the limit is % bytes', v_width, v_size, v_cap
      using errcode = '42501';
  end if;

  v_mime := lower(btrim(split_part(coalesce(new.metadata ->> 'mimetype', ''), ';', 1)));
  if v_mime <> 'image/webp' then
    raise exception 'public-media: only image/webp is accepted (got %)', coalesce(nullif(v_mime, ''), 'none')
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function private.storage_public_media_guard() is
  'SEC-018 / BUG-016: per-width size cap + WebP-only on public-media variant objects. Checks only rows whose metadata '
  'carries a Storage-measured "size" (the real object); storage-api permission dry-runs pass. Raises 42501 (HTTP 403).';

-- create or replace keeps the existing EXECUTE grants from 20261021000005; restated so this file stands alone.
do $$
begin
  grant execute on function private.storage_public_media_guard() to authenticated, service_role;
  if exists (select 1 from pg_roles where rolname = 'supabase_storage_admin') then
    execute 'grant execute on function private.storage_public_media_guard() to supabase_storage_admin';
  end if;
end
$$;
