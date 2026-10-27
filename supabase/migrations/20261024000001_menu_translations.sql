-- 20261024000001_menu_translations.sql
-- Multi-language menu (same idea as projects/aduwa src/lib/menu-i18n): English stays the primary text in the existing
-- name / description / label columns. A guest may add ONE secondary language next to it. Cafe items have no slug and
-- are owner-edited, so the secondary text lives in the DB, one jsonb column per menu table.
--
-- Allowed languages (keys): ne (Nepali), zh (Simplified Chinese), ja, ko, pt (Brazilian Portuguese). English is never
-- a key: it is the row's own column. A missing language means "show English only".
--
--   menu_items.translations       { "<lang>": { "name": text 1..80, "description"?: text 1..240,
--                                               "pronunciation"?: text 1..80 (romanised, "ne" only) } }
--   menu_categories.translations  { "<lang>": { "name": text 1..80 } }
--   menu_variants.translations    { "<lang>": { "label": text 1..40 } }
--
-- Rules (all three): the value is a JSON object; every key is an allowed language; every language value is an object
-- with exactly the listed keys (no others); the required key ("name" / "label") is present; every value is a JSON
-- string (not null, number, array); lengths are counted in characters (char_length), like the English columns.
-- Optional keys must be non-empty when present: omit the key instead of sending "". '{}' = no translations.
-- A violation is SQLSTATE 23514 with the constraint name <table>_translations_valid.
--
-- Why a function in the CHECK (not plain jsonpath like 20261021000002): jsonpath's @? returns NULL on structural
-- errors in strict mode and auto-unwraps arrays in lax mode, and NULL passes a CHECK, so a jsonpath-only check is easy
-- to get subtly wrong. The validator is a plain IMMUTABLE plpgsql function in schema `private` (not exposed by
-- PostgREST). Since 20261021000001 there is no implicit PUBLIC EXECUTE, so it is granted explicitly to every role that
-- writes these tables: authenticated (owner edits, and staff sold-out toggles also re-check the row) and service_role.
-- anon has no write grant on the menu, so it gets no EXECUTE.
--
-- Access is unchanged: anon already has a table-level SELECT grant on all three tables (RLS still shows only visible
-- rows); the explicit column grants below just pin that the public menu may read the new columns, should the table
-- grant ever be narrowed to columns. Staff still cannot edit translations: the menu_items / menu_variants
-- guard_staff_update('is_sold_out') triggers compare the whole row, so any translations change by staff is 42501;
-- staff have no UPDATE policy on menu_categories at all (0 rows). Owner (and service role) can edit them.
-- Realtime already publishes full menu_items / menu_variants rows, so translation edits reach open menus live.

create or replace function private.menu_translations_valid(p_value jsonb, p_kind text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_lang    text;
  v_entry   jsonb;
  v_key     text;
  v_val     jsonb;
  v_req     text;
  v_max     jsonb;     -- {"<key>": max chars}
  v_ne_only text[];
begin
  if p_value is null then
    return true;        -- NOT NULL on the column handles nulls
  end if;

  case p_kind
    when 'item' then
      v_req := 'name';
      v_max := '{"name": 80, "description": 240, "pronunciation": 80}';
      v_ne_only := array['pronunciation'];
    when 'category' then
      v_req := 'name';
      v_max := '{"name": 80}';
      v_ne_only := '{}';
    when 'variant' then
      v_req := 'label';
      v_max := '{"label": 40}';
      v_ne_only := '{}';
    else
      raise exception 'menu_translations_valid: unknown kind %', p_kind using errcode = '22023';
  end case;

  if jsonb_typeof(p_value) <> 'object' then
    return false;
  end if;

  for v_lang, v_entry in select e.key, e.value from jsonb_each(p_value) e loop
    if v_lang not in ('ne', 'zh', 'ja', 'ko', 'pt') then
      return false;
    end if;
    if jsonb_typeof(v_entry) <> 'object' or not (v_entry ? v_req) then
      return false;
    end if;
    for v_key, v_val in select f.key, f.value from jsonb_each(v_entry) f loop
      if not (v_max ? v_key) then
        return false;                                   -- unknown key
      end if;
      if v_key = any (v_ne_only) and v_lang <> 'ne' then
        return false;                                   -- pronunciation is for Nepali only
      end if;
      if jsonb_typeof(v_val) <> 'string' then
        return false;                                   -- null / number / array / object
      end if;
      if char_length(v_val #>> '{}') not between 1 and (v_max ->> v_key)::int then
        return false;
      end if;
    end loop;
  end loop;

  return true;
end;
$$;

comment on function private.menu_translations_valid(jsonb, text) is
  'Validates menu translations jsonb (kind item | category | variant). Used by the <table>_translations_valid CHECKs.';

revoke all on function private.menu_translations_valid(jsonb, text) from public, anon, authenticated;
grant execute on function private.menu_translations_valid(jsonb, text) to authenticated, service_role;

-- Columns. ADD COLUMN with a constant default is a metadata-only change (no table rewrite); existing rows read '{}'.
alter table public.menu_items
  add column translations jsonb not null default '{}'::jsonb,
  add constraint menu_items_translations_valid
    check (private.menu_translations_valid(translations, 'item'));

alter table public.menu_categories
  add column translations jsonb not null default '{}'::jsonb,
  add constraint menu_categories_translations_valid
    check (private.menu_translations_valid(translations, 'category'));

-- NOT NULL here too (the request said "default '{}'"): one shape for all three tables, so readers never handle null.
alter table public.menu_variants
  add column translations jsonb not null default '{}'::jsonb,
  add constraint menu_variants_translations_valid
    check (private.menu_translations_valid(translations, 'variant'));

comment on column public.menu_items.translations is
  'Secondary-language text. {"<ne|zh|ja|ko|pt>": {"name": 1..80, "description"?: 1..240, "pronunciation"?: 1..80 (ne only)}}. English = name/description.';
comment on column public.menu_categories.translations is
  'Secondary-language text. {"<ne|zh|ja|ko|pt>": {"name": 1..80}}. English = name.';
comment on column public.menu_variants.translations is
  'Secondary-language text. {"<ne|zh|ja|ko|pt>": {"label": 1..40}}. English = label.';

-- Public menu reads the new columns (redundant with the existing table-level SELECT grant; pins intent).
grant select (translations) on public.menu_items, public.menu_categories, public.menu_variants to anon;
