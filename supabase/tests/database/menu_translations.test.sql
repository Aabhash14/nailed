-- menu_translations.test.sql  (pgTAP; run with `supabase test db`)
-- Migration 20261024000001: menu_items / menu_categories / menu_variants.translations.
-- Proves: column shape; the three CHECKs accept valid shapes and refuse unknown languages, unknown keys, wrong types,
-- missing required keys and over-length text; owner can edit, staff cannot (but can still toggle sold-out, i.e. the
-- CHECK's validator is executable by authenticated); anon can read translations of visible rows only and cannot write.
-- Self-contained: fixtures use 'TR ' names and everything is rolled back. Does not depend on seed.sql.

begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- Fixtures (as postgres) -----------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('f5000000-0000-4000-8000-000000000001', 'tr-owner@test.invalid'),
  ('f5000000-0000-4000-8000-000000000002', 'tr-staff@test.invalid');
insert into public.profiles (id, role, display_name) values
  ('f5000000-0000-4000-8000-000000000001', 'owner', 'TR Owner'),
  ('f5000000-0000-4000-8000-000000000002', 'staff', 'TR Staff');

insert into public.menu_categories (id, slug, name, is_visible) values
  ('f6000000-0000-4000-8000-000000000001', 'tr-visible-cat', 'TR Visible cat', true),
  ('f6000000-0000-4000-8000-000000000002', 'tr-hidden-cat',  'TR Hidden cat',  false);
insert into public.menu_items (id, category_id, name, price_paisa, is_visible) values
  ('f7000000-0000-4000-8000-000000000001', 'f6000000-0000-4000-8000-000000000001', 'TR Visible item', 10000, true),
  ('f7000000-0000-4000-8000-000000000002', 'f6000000-0000-4000-8000-000000000001', 'TR Hidden item',  10000, false);
insert into public.menu_variants (id, item_id, kind, label) values
  ('f8000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001', 'size', 'TR Large'),
  ('f8000000-0000-4000-8000-000000000002', 'f7000000-0000-4000-8000-000000000002', 'size', 'TR Hidden variant');

-- ===== Structure ================================================================================================
select col_type_is('public', 'menu_items',      'translations', 'jsonb', 'menu_items.translations is jsonb');
select col_type_is('public', 'menu_categories', 'translations', 'jsonb', 'menu_categories.translations is jsonb');
select col_type_is('public', 'menu_variants',   'translations', 'jsonb', 'menu_variants.translations is jsonb');
select col_not_null('public', 'menu_items',      'translations', 'menu_items.translations is NOT NULL');
select col_not_null('public', 'menu_categories', 'translations', 'menu_categories.translations is NOT NULL');
select col_not_null('public', 'menu_variants',   'translations', 'menu_variants.translations is NOT NULL');
select is((select translations from public.menu_items where id = 'f7000000-0000-4000-8000-000000000001'), '{}'::jsonb,
          'a new item defaults to {}');
select is((select translations from public.menu_categories where id = 'f6000000-0000-4000-8000-000000000001'), '{}'::jsonb,
          'a new category defaults to {}');
select is((select translations from public.menu_variants where id = 'f8000000-0000-4000-8000-000000000001'), '{}'::jsonb,
          'a new variant defaults to {}');
select is((select count(*)::int from public.menu_items where translations is null), 0, 'no existing item has null translations');
select is((select array_agg(conname::text order by conname)
             from pg_constraint where conname like 'menu\_%\_translations\_valid' and contype = 'c' and convalidated),
          array['menu_categories_translations_valid', 'menu_items_translations_valid', 'menu_variants_translations_valid'],
          'the three translations CHECK constraints exist and are validated');
select ok(not has_function_privilege('anon', 'private.menu_translations_valid(jsonb,text)', 'execute'),
          'anon cannot execute the validator');
select ok(has_function_privilege('authenticated', 'private.menu_translations_valid(jsonb,text)', 'execute')
          and has_function_privilege('service_role', 'private.menu_translations_valid(jsonb,text)', 'execute'),
          'authenticated and service_role can execute the validator (needed by the CHECK on every write)');

-- ===== menu_items: valid shapes =================================================================================
select lives_ok($$update public.menu_items set translations = '{}' where id = 'f7000000-0000-4000-8000-000000000001'$$,
                'item: {} is valid');
select lives_ok($$update public.menu_items set translations = jsonb_build_object(
                    'ne', jsonb_build_object('name', 'मसला चिया', 'description', 'अदुवा र अलैंचीसहितको दूध चिया।',
                                             'pronunciation', 'masala chiya'),
                    'zh', jsonb_build_object('name', '马萨拉奶茶', 'description', '加姜和小豆蔻的奶茶。'),
                    'ja', jsonb_build_object('name', 'マサラチャイ'),
                    'ko', jsonb_build_object('name', '마살라 차이'),
                    'pt', jsonb_build_object('name', 'Chai masala', 'description', 'Chá com leite, gengibre e cardamomo.'))
                  where id = 'f7000000-0000-4000-8000-000000000001'$$,
                'item: all five languages, ne with description + pronunciation, is valid');
select lives_ok($$update public.menu_items set translations = jsonb_build_object('zh', jsonb_build_object('name', '咖啡'))
                  where id = 'f7000000-0000-4000-8000-000000000001'$$,
                'item: a single language with name only is valid');
select lives_ok($$update public.menu_items set translations = jsonb_build_object('ne', jsonb_build_object(
                    'name', repeat('क', 80), 'description', repeat('ख', 240), 'pronunciation', repeat('a', 80)))
                  where id = 'f7000000-0000-4000-8000-000000000001'$$,
                'item: boundaries pass (name 80, description 240, pronunciation 80; Devanagari counted as characters)');
select lives_ok($$update public.menu_items set translations = jsonb_build_object('ja', jsonb_build_object('name', 'a'))
                  where id = 'f7000000-0000-4000-8000-000000000001'$$,
                'item: name of 1 character passes');

-- ===== menu_items: invalid shapes ===============================================================================
create function pg_temp.item_fails(p jsonb, p_desc text) returns text language sql as $f$
  select throws_ok(
    format($$update public.menu_items set translations = %L::jsonb where id = 'f7000000-0000-4000-8000-000000000001'$$, p),
    '23514', 'new row for relation "menu_items" violates check constraint "menu_items_translations_valid"', p_desc) $f$;

select pg_temp.item_fails('{"fr": {"name": "Café"}}',                       'item: unknown language fr fails');
select pg_temp.item_fails('{"en": {"name": "Coffee"}}',                     'item: en is not a key (English is the row itself)');
select pg_temp.item_fails('{"zh-Hans": {"name": "咖啡"}}',                  'item: BCP 47 tags are not keys (zh, not zh-Hans)');
select pg_temp.item_fails('{"NE": {"name": "चिया"}}',                        'item: language keys are lower case');
select pg_temp.item_fails('{"ne": {"name": "चिया", "title": "x"}}',          'item: unknown key in a language fails');
select pg_temp.item_fails('{"ne": {"name": "चिया"}, "extra": 1}',            'item: unknown top-level key fails');
select pg_temp.item_fails('{"zh": {"name": "咖啡", "pronunciation": "kafei"}}', 'item: pronunciation on a non-ne language fails');
select pg_temp.item_fails('{"ne": {"description": "मीठो"}}',                 'item: missing name fails');
select pg_temp.item_fails('{"ne": {}}',                                     'item: empty language object fails');
select pg_temp.item_fails('{"ne": "चिया"}',                                  'item: language value must be an object, not a string');
select pg_temp.item_fails('{"ne": ["चिया"]}',                                'item: language value must be an object, not an array');
select pg_temp.item_fails('{"ne": null}',                                   'item: language value must not be null');
select pg_temp.item_fails('[]',                                             'item: top level must be an object, not an array');
select pg_temp.item_fails('"ne"',                                           'item: top level must be an object, not a string');
select pg_temp.item_fails('null',                                           'item: JSON null at top level fails');
select pg_temp.item_fails('{"ne": {"name": 42}}',                           'item: name as a number fails');
select pg_temp.item_fails('{"ne": {"name": null}}',                         'item: name as JSON null fails');
select pg_temp.item_fails('{"ne": {"name": ["चिया"]}}',                      'item: name as an array fails');
select pg_temp.item_fails('{"ne": {"name": true}}',                         'item: name as a boolean fails');
select pg_temp.item_fails('{"ne": {"name": "चिया", "description": 1}}',     'item: description as a number fails');
select pg_temp.item_fails('{"ne": {"name": "चिया", "pronunciation": null}}', 'item: pronunciation as null fails');
select pg_temp.item_fails('{"ne": {"name": ""}}',                           'item: empty name fails');
select pg_temp.item_fails('{"ne": {"name": "चिया", "description": ""}}',     'item: empty description fails (omit the key)');
select pg_temp.item_fails(jsonb_build_object('ne', jsonb_build_object('name', repeat('क', 81))),
                          'item: name of 81 characters fails');
select pg_temp.item_fails(jsonb_build_object('pt', jsonb_build_object('name', 'x', 'description', repeat('a', 241))),
                          'item: description of 241 characters fails');
select pg_temp.item_fails(jsonb_build_object('ne', jsonb_build_object('name', 'x', 'pronunciation', repeat('a', 81))),
                          'item: pronunciation of 81 characters fails');
select throws_ok($$update public.menu_items set translations = null where id = 'f7000000-0000-4000-8000-000000000001'$$,
                 '23502', null::text, 'item: SQL NULL fails (NOT NULL)');
select throws_ok($$insert into public.menu_items (category_id, name, price_paisa, translations)
                   values ('f6000000-0000-4000-8000-000000000001', 'TR bad insert', 1, '{"xx": {"name": "y"}}')$$,
                 '23514', null::text, 'item: the CHECK also runs on INSERT');

-- ===== menu_categories ==========================================================================================
create function pg_temp.cat_fails(p jsonb, p_desc text) returns text language sql as $f$
  select throws_ok(
    format($$update public.menu_categories set translations = %L::jsonb where id = 'f6000000-0000-4000-8000-000000000001'$$, p),
    '23514', 'new row for relation "menu_categories" violates check constraint "menu_categories_translations_valid"', p_desc) $f$;

select lives_ok($$update public.menu_categories set translations = jsonb_build_object(
                    'ne', jsonb_build_object('name', 'कफी'), 'zh', jsonb_build_object('name', '咖啡'),
                    'ja', jsonb_build_object('name', 'コーヒー'), 'ko', jsonb_build_object('name', '커피'),
                    'pt', jsonb_build_object('name', 'Café'))
                  where id = 'f6000000-0000-4000-8000-000000000001'$$,
                'category: all five languages with name is valid');
select lives_ok($$update public.menu_categories set translations = jsonb_build_object('ne', jsonb_build_object('name', repeat('क', 80)))
                  where id = 'f6000000-0000-4000-8000-000000000001'$$,
                'category: name of 80 characters passes');
select pg_temp.cat_fails('{"de": {"name": "Kaffee"}}',                 'category: unknown language fails');
select pg_temp.cat_fails('{"ne": {"name": "कफी", "description": "x"}}', 'category: description is not allowed on a category');
select pg_temp.cat_fails('{"ne": {"name": "कफी", "pronunciation": "kafi"}}', 'category: pronunciation is not allowed on a category');
select pg_temp.cat_fails('{"ne": {"label": "कफी"}}',                   'category: label instead of name fails');
select pg_temp.cat_fails('{"ne": {"name": 7}}',                        'category: name as a number fails');
select pg_temp.cat_fails('{"ne": {"name": ""}}',                       'category: empty name fails');
select pg_temp.cat_fails(jsonb_build_object('ne', jsonb_build_object('name', repeat('क', 81))),
                         'category: name of 81 characters fails');

-- ===== menu_variants ============================================================================================
create function pg_temp.var_fails(p jsonb, p_desc text) returns text language sql as $f$
  select throws_ok(
    format($$update public.menu_variants set translations = %L::jsonb where id = 'f8000000-0000-4000-8000-000000000001'$$, p),
    '23514', 'new row for relation "menu_variants" violates check constraint "menu_variants_translations_valid"', p_desc) $f$;

select lives_ok($$update public.menu_variants set translations = jsonb_build_object(
                    'ne', jsonb_build_object('label', 'ठूलो'), 'zh', jsonb_build_object('label', '大杯'),
                    'ja', jsonb_build_object('label', 'ラージ'), 'ko', jsonb_build_object('label', '라지'),
                    'pt', jsonb_build_object('label', 'Grande'))
                  where id = 'f8000000-0000-4000-8000-000000000001'$$,
                'variant: all five languages with label is valid');
select lives_ok($$update public.menu_variants set translations = jsonb_build_object('ko', jsonb_build_object('label', repeat('라', 40)))
                  where id = 'f8000000-0000-4000-8000-000000000001'$$,
                'variant: label of 40 characters passes');
select pg_temp.var_fails('{"it": {"label": "Grande"}}',       'variant: unknown language fails');
select pg_temp.var_fails('{"ne": {"name": "ठूलो"}}',           'variant: name instead of label fails');
select pg_temp.var_fails('{"ne": {"label": "ठूलो", "x": "y"}}', 'variant: unknown key fails');
select pg_temp.var_fails('{"ne": {"label": false}}',          'variant: label as a boolean fails');
select pg_temp.var_fails('{"ne": {"label": ""}}',             'variant: empty label fails');
select pg_temp.var_fails(jsonb_build_object('ne', jsonb_build_object('label', repeat('क', 41))),
                         'variant: label of 41 characters fails');

-- Known state for the role checks below.
update public.menu_items set translations = '{"ne": {"name": "भिजिबल", "pronunciation": "visible"}}'
 where id = 'f7000000-0000-4000-8000-000000000001';
update public.menu_items set translations = '{"ne": {"name": "लुकेको"}}'
 where id = 'f7000000-0000-4000-8000-000000000002';
update public.menu_categories set translations = '{"zh": {"name": "可见"}}' where id = 'f6000000-0000-4000-8000-000000000001';
update public.menu_categories set translations = '{"zh": {"name": "隐藏"}}' where id = 'f6000000-0000-4000-8000-000000000002';
update public.menu_variants set translations = '{"ja": {"label": "ラージ"}}' where id = 'f8000000-0000-4000-8000-000000000001';
update public.menu_variants set translations = '{"ja": {"label": "隠し"}}' where id = 'f8000000-0000-4000-8000-000000000002';

-- ===== ANON =====================================================================================================
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

select ok(has_column_privilege('anon', 'public.menu_items', 'translations', 'select')
          and has_column_privilege('anon', 'public.menu_categories', 'translations', 'select')
          and has_column_privilege('anon', 'public.menu_variants', 'translations', 'select'),
          'anon has SELECT on all three translations columns');
select results_eq($$select translations from public.menu_items where name like 'TR %'$$,
                  $$values ('{"ne": {"name": "भिजिबल", "pronunciation": "visible"}}'::jsonb)$$,
                  'anon reads translations of the visible item only');
select results_eq($$select translations ->> 'ne' is not null from public.menu_items where name like 'TR %'$$,
                  $$values (true)$$, 'anon can use jsonb operators on translations');
select results_eq($$select translations from public.menu_categories where name like 'TR %'$$,
                  $$values ('{"zh": {"name": "可见"}}'::jsonb)$$,
                  'anon reads translations of the visible category only');
select results_eq($$select translations from public.menu_variants where label like 'TR %'$$,
                  $$values ('{"ja": {"label": "ラージ"}}'::jsonb)$$,
                  'anon reads translations of variants of visible items only');
select lives_ok($$select c.id, c.name, c.translations, i.id, i.name, i.translations, v.label, v.translations
                    from public.menu_categories c
                    join public.menu_items i on i.category_id = c.id
                    left join public.menu_variants v on v.item_id = i.id$$,
                'anon can read the public menu join with translations');
select throws_ok($$update public.menu_items set translations = '{}' where id = 'f7000000-0000-4000-8000-000000000001'$$,
                 '42501', null::text, 'anon cannot update item translations');
select throws_ok($$update public.menu_categories set translations = '{}'$$, '42501', null::text,
                 'anon cannot update category translations');
select throws_ok($$update public.menu_variants set translations = '{}'$$, '42501', null::text,
                 'anon cannot update variant translations');
reset role;

-- ===== STAFF ====================================================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-8000-000000000002","role":"authenticated"}', true);

select throws_ok($$update public.menu_items set translations = '{"ne": {"name": "ह्याक"}}'
                    where id = 'f7000000-0000-4000-8000-000000000001'$$,
                 '42501', 'staff may only change: is_sold_out', 'staff cannot edit item translations (guard trigger)');
select throws_ok($$update public.menu_variants set translations = '{"ne": {"label": "ह्याक"}}'
                    where id = 'f8000000-0000-4000-8000-000000000001'$$,
                 '42501', 'staff may only change: is_sold_out', 'staff cannot edit variant translations (guard trigger)');
select results_eq($$with u as (update public.menu_categories set translations = '{"ne": {"name": "ह्याक"}}'
                                where id = 'f6000000-0000-4000-8000-000000000001' returning 1)
                    select count(*)::int from u$$,
                  $$values (0)$$, 'staff cannot edit category translations (no update policy: 0 rows)');
select lives_ok($$update public.menu_items set is_sold_out = true where id = 'f7000000-0000-4000-8000-000000000001'$$,
                'staff can still toggle item sold-out (the CHECK validator runs for authenticated)');
select lives_ok($$update public.menu_variants set is_sold_out = true where id = 'f8000000-0000-4000-8000-000000000001'$$,
                'staff can still toggle variant sold-out');
select is((select translations from public.menu_items where id = 'f7000000-0000-4000-8000-000000000001'),
          '{"ne": {"name": "भिजिबल", "pronunciation": "visible"}}'::jsonb,
          'item translations unchanged after the staff attempts');
select ok((select translations ? 'ne' from public.menu_items where id = 'f7000000-0000-4000-8000-000000000002'),
          'staff can read translations of hidden items');
reset role;
select is((select translations from public.menu_categories where id = 'f6000000-0000-4000-8000-000000000001'),
          '{"zh": {"name": "可见"}}'::jsonb, 'category translations unchanged after the staff attempt');

-- ===== OWNER ====================================================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select lives_ok($$update public.menu_items set translations = '{"ne": {"name": "मालिक", "description": "राम्रो", "pronunciation": "malik"}, "pt": {"name": "Dono"}}'
                    where id = 'f7000000-0000-4000-8000-000000000001'$$,
                'owner can edit item translations');
select lives_ok($$update public.menu_categories set translations = '{"ko": {"name": "커피"}}'
                    where id = 'f6000000-0000-4000-8000-000000000001'$$,
                'owner can edit category translations');
select lives_ok($$update public.menu_variants set translations = '{"pt": {"label": "Grande"}}'
                    where id = 'f8000000-0000-4000-8000-000000000001'$$,
                'owner can edit variant translations');
select lives_ok($$insert into public.menu_items (category_id, name, price_paisa, translations)
                   values ('f6000000-0000-4000-8000-000000000001', 'TR Owner new', 1, '{"zh": {"name": "新"}}')$$,
                'owner can insert an item with translations');
select throws_ok($$update public.menu_items set translations = '{"fr": {"name": "x"}}'
                    where id = 'f7000000-0000-4000-8000-000000000001'$$,
                 '23514', null::text, 'owner is held to the same CHECK');
select is((select translations -> 'pt' ->> 'name' from public.menu_items where id = 'f7000000-0000-4000-8000-000000000001'),
          'Dono', 'owner edit stored');
reset role;

-- ===== Service role =============================================================================================
set local role service_role;
select lives_ok($$update public.menu_items set translations = '{"ja": {"name": "テスト"}}'
                    where id = 'f7000000-0000-4000-8000-000000000001'$$,
                'service_role can edit translations (backend after requireRole)');
select throws_ok($$update public.menu_items set translations = '{"ja": {"name": 1}}'
                    where id = 'f7000000-0000-4000-8000-000000000001'$$,
                 '23514', null::text, 'service_role is held to the same CHECK');
reset role;

select * from finish();
rollback;
