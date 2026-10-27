-- 20261026000002_table_ordering_functions.sql
-- Table ordering (decision 22, revised for api-contract 2.1.0 and 2.2.0), part 2: functions, grants, the pg_cron
-- expiry job, and the 180-day alert purge added to purge_personal_data(). Schema: 20261026000001.
--
-- Every public function here is SECURITY DEFINER, `set search_path = ''`, revoked from public/anon/authenticated and
-- EXECUTE for service_role ONLY (SEC-007; the pinned anon/authenticated allow-lists in rls.test.sql do not change).
-- Admin RPCs take p_actor = the verified profiles.id (FORBIDDEN without a profile); the role is read from profiles.
-- Guest RPCs (join, guest view, create round) take no actor: the server calls them after Turnstile / the signed
-- cookie; view and round also take p_epoch (the cookie's epoch), compared with table_sessions.cookie_epoch.
--
-- ERROR PROTOCOL (same as the order functions): SQLSTATE P0001, MESSAGE = contract code, DETAIL = JSON field errors
-- (or {"retryAfterSeconds": n}), HINT = the safe message of api-contract 9.3 to 9.10a, word for word. Codes used:
--   VALIDATION, NOT_FOUND, CONFLICT, FORBIDDEN, OUT_OF_STOCK, RATE_LIMITED, TABLE_SESSION_INVALID, TABLE_ORDERS_PAUSED
-- The typed table code, or any other input, never appears in a MESSAGE, DETAIL or HINT (SEC-029 item 6). Texts are fixed.
--
-- LOCK ORDER (deadlock-free by construction). Every table WRITER takes, as its first statement after the argument
-- checks, `select 1 from public.table_board_state for update`, which serialises all table-ordering writes in the cafe
-- (milliseconds each). Then, in this order: cafe_tables rows, the table_sessions row, table_orders rows. Readers
-- (join_table_session, table_session_guest_view, table_board, list_cafe_tables, stats_table_orders) take no locks.
-- A writer that changed something ends with private.table_board_bump() (version + 1) and rev + 1 on every session it
-- touched. A replay changes and bumps nothing. The alert functions (record_admin_alert, mark_admin_alerts_read,
-- claim_alert_deliveries, finish_alert_delivery) touch only admin_alerts / alert_deliveries, never a table, session or
-- round row, so they do not take the board lock (the table writers only INSERT alert rows).
-- Writers set app.table_write = 'on' (transaction-local) for the write guards and set it back to 'off' when done.

create extension if not exists pgcrypto with schema extensions;   -- gen_random_bytes, digest (already on Supabase)

-- ===========================================================================
-- Helpers (schema private; not exposed by PostgREST, not executable by anon, authenticated or service_role)
-- ===========================================================================

-- 6 characters from 23456789ABCDEFGHJKMNPQRSTUVWXYZ (31 symbols: no 0/O, 1/I/L). Rejection sampling over random
-- bytes: a byte b is used only if b < 248 (= 31 x 8), then symbol b % 31. No modulo bias.
create or replace function private.new_table_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  c_alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  v_bytes bytea;
  v_b     integer;
  v_code  text := '';
  v_i     integer;
begin
  while char_length(v_code) < 6 loop
    v_bytes := extensions.gen_random_bytes(16);
    for v_i in 0 .. 15 loop
      v_b := get_byte(v_bytes, v_i);
      if v_b < 248 then
        v_code := v_code || substr(c_alphabet, v_b % 31 + 1, 1);
        exit when char_length(v_code) = 6;
      end if;
    end loop;
  end loop;
  return v_code;
end;
$$;

-- TableBill for a subtotal, with EXACTLY the rounding of create_order (service charge on the subtotal; VAT 13% on
-- subtotal + service, inside or on top per site_settings.prices_include_vat). Live settings.
create or replace function private.table_bill(p_subtotal bigint)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_sub     bigint := coalesce(p_subtotal, 0);
  v_inc     boolean;
  v_pct     numeric;
  v_service bigint;
  v_taxable bigint;
  v_vat     bigint;
  v_total   bigint;
begin
  select s.prices_include_vat, s.service_charge_pct into v_inc, v_pct from public.site_settings s limit 1;
  v_service := round(v_sub * v_pct / 100.0)::bigint;
  v_taxable := v_sub + v_service;
  if v_inc then
    v_vat   := round(v_taxable * 13 / 113.0)::bigint;      -- VAT portion inside the prices
    v_total := v_taxable;
  else
    v_vat   := round(v_taxable * 13 / 100.0)::bigint;      -- VAT added on top
    v_total := v_taxable + v_vat;
  end if;
  return jsonb_build_object('subtotal', v_sub, 'serviceCharge', v_service, 'vat', v_vat, 'total', v_total,
                            'pricesIncludeVat', v_inc, 'serviceChargePct', v_pct);
end;
$$;

-- Live subtotal of a session: rounds that are not cancelled.
create or replace function private.table_session_subtotal(p_session_id uuid)
returns bigint
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(o.subtotal_paisa), 0)::bigint
    from public.table_orders o
   where o.session_id = p_session_id and o.status <> 'cancelled'
$$;

-- SEC-022: "any round of the session was ever accepted" (accepted_at is never cleared, rounds are never deleted).
create or replace function private.table_ever_accepted(p_session_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from public.table_orders o where o.session_id = p_session_id and o.accepted_at is not null)
$$;

-- The bill of a session: live while open, the close snapshot after (serviceChargePct is not snapshotted, so a closed
-- session reports the current percentage).
create or replace function private.table_session_bill(p_session_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case when s.status = 'open' then private.table_bill(private.table_session_subtotal(s.id))
              else jsonb_build_object('subtotal', s.subtotal_paisa, 'serviceCharge', s.service_charge_paisa,
                                      'vat', s.vat_paisa, 'total', s.total_paisa,
                                      'pricesIncludeVat', s.prices_include_vat,
                                      'serviceChargePct', (select st.service_charge_pct from public.site_settings st limit 1))
         end
    from public.table_sessions s where s.id = p_session_id
$$;

-- GuestTableRound: round, status, items, note, subtotal, createdAt. NOTHING else (no ids, names or reasons).
create or replace function private.table_round_guest_json(p_order_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
           'round',     o.round,
           'status',    o.status,
           'items',     coalesce((select jsonb_agg(jsonb_build_object(
                                     'menuItemId', i.menu_item_ref,
                                     'variantIds', to_jsonb(i.variant_refs),
                                     'name',       i.name_snapshot,
                                     'options',    i.options_snapshot,
                                     'qty',        i.qty,
                                     'unitPrice',  i.unit_price_paisa,
                                     'lineTotal',  i.line_total_paisa) order by i.line_no)
                                    from public.table_order_items i where i.order_id = o.id), '[]'::jsonb),
           'note',      o.note,
           'subtotal',  o.subtotal_paisa,
           'createdAt', o.created_at)
    from public.table_orders o
   where o.id = p_order_id
$$;

-- AdminTableRound = GuestTableRound + id, timestamps, cancelReason, cancelledByName, staffCanCancelUntil (2.2.0:
-- accepted_at + order_rules.staff_cancel_window_minutes; null if not accepted or the window is 0).
create or replace function private.table_round_admin_json(p_order_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select private.table_round_guest_json(o.id)
         || jsonb_build_object(
              'id',                  o.id,
              'acceptedAt',          o.accepted_at,
              'servedAt',            o.served_at,
              'cancelledAt',         o.cancelled_at,
              'cancelReason',        o.cancel_reason,
              'cancelledByName',     (select p.display_name from public.profiles p where p.id = o.cancelled_by),
              'staffCanCancelUntil', (select case when o.accepted_at is not null and r.staff_cancel_window_minutes > 0
                                                  then o.accepted_at + make_interval(mins => r.staff_cancel_window_minutes)
                                             end
                                        from public.order_rules r limit 1))
    from public.table_orders o
   where o.id = p_order_id
$$;

-- TableSessionView, the GUEST builder (2.1.0, SEC-029: separate from the admin builder, no switch). Keys: rev,
-- tableNumber, tableLabel, openedAt, ordering ('stopped' if orders_locked, else 'on' / 'paused' from the mode), rounds,
-- bill, limits. No ids, code, joinPath, staff names, cancel reasons or waiting counts. Null if the session is unknown.
create or replace function private.table_session_guest_json(p_session_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
           'rev',         s.rev,
           'tableNumber', s.table_number,
           'tableLabel',  t.label,
           'openedAt',    s.opened_at,
           'ordering',    case when s.orders_locked then 'stopped'
                               when (select st.table_ordering from public.site_settings st limit 1) = 'on' then 'on'
                               else 'paused' end,
           'rounds',      coalesce((select jsonb_agg(private.table_round_guest_json(o.id) order by o.round)
                                      from public.table_orders o where o.session_id = s.id), '[]'::jsonb),
           'bill',        private.table_session_bill(s.id),
           'limits',      jsonb_build_object('maxLines', 20, 'maxQty', 20, 'maxWaitingRounds', 3, 'maxLiveRounds', 30,
                                             'maxNoteLength', 200))
    from public.table_sessions s
    join public.cafe_tables t on t.id = s.table_id
   where s.id = p_session_id
$$;

-- AdminTableSession, the ADMIN builder: id, code, joinPath ('/menu?t=<n>#c=<code>', 2.1.0 SEC-024: fragment, not
-- query), openedAt, openedByName, lastActivityAt, ordersLocked, codeChanges (= cookie_epoch - 1), everAccepted,
-- rounds (admin), bill, waiting {new, preparing}.
create or replace function private.table_session_admin_json(p_session_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
           'id',             s.id,
           'code',           s.code,
           'joinPath',       case when s.code is not null then '/menu?t=' || s.table_number || '#c=' || s.code end,
           'openedAt',       s.opened_at,
           'openedByName',   (select p.display_name from public.profiles p where p.id = s.opened_by),
           'lastActivityAt', greatest(s.opened_at, (select max(o.created_at) from public.table_orders o where o.session_id = s.id)),
           'ordersLocked',   s.orders_locked,
           'codeChanges',    s.cookie_epoch - 1,
           'everAccepted',   private.table_ever_accepted(s.id),
           'rounds',         coalesce((select jsonb_agg(private.table_round_admin_json(o.id) order by o.round)
                                         from public.table_orders o where o.session_id = s.id), '[]'::jsonb),
           'bill',           private.table_session_bill(s.id),
           'waiting',        jsonb_build_object(
                               'new',       (select count(*) from public.table_orders o where o.session_id = s.id and o.status = 'new'),
                               'preparing', (select count(*) from public.table_orders o where o.session_id = s.id and o.status = 'preparing')))
    from public.table_sessions s
   where s.id = p_session_id
$$;

-- ClosedTableSummary (api-contract 9.7).
create or replace function private.table_closed_summary_json(p_session_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
           'sessionId',    s.id,
           'tableNumber',  s.table_number,
           'openedAt',     s.opened_at,
           'closedAt',     s.closed_at,
           'outcome',      s.outcome,
           'paidVia',      s.paid_via,
           'total',        s.total_paisa,
           'rounds',       (select count(*) from public.table_orders o
                             where o.session_id = s.id and o.status <> 'cancelled'),
           'closedByName', (select p.display_name from public.profiles p where p.id = s.closed_by))
    from public.table_sessions s
   where s.id = p_session_id
$$;

-- CafeTable rows (api-contract 9.7), all tables by number.
create or replace function private.cafe_tables_json()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',         t.id,
           'number',     t.number,
           'label',      t.label,
           'isActive',   t.is_active,
           'isOpen',     exists (select 1 from public.table_sessions s where s.table_id = t.id and s.status = 'open'),
           'hasHistory', exists (select 1 from public.table_sessions s where s.table_id = t.id))
         order by t.number), '[]'::jsonb)
    from public.cafe_tables t
$$;

-- The shared lock (first statement of every table writer) and the version bump (last statement of a writer that
-- changed something). Callers must have set app.table_write = 'on' before the bump.
create or replace function private.table_lock_board()
returns void
language sql
volatile
set search_path = ''
as $$
  select null::void from public.table_board_state for update
$$;

create or replace function private.table_board_bump()
returns void
language sql
volatile
set search_path = ''
as $$
  update public.table_board_state set version = version + 1, changed_at = now()
$$;

-- 2.1.0 (SEC-027): fingerprint of a round request = SHA-256 hex of the canonical JSON of the merged lines (merged by
-- item and SET of options; sorted by menuItemId, then the sorted variantIds text; with qty) plus the normalised note
-- (trimmed, '' = null). Pure: reads no rows. Returns null for a body that cannot be parsed (a replay with such a body
-- is then a mismatch, never a crash).
create or replace function private.table_request_fingerprint(p_items jsonb, p_note text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_canon text;
begin
  with req as (
    select (e.value ->> 'menuItemId')::uuid as item_id,
           coalesce((select array_agg(distinct (v #>> '{}')::uuid order by (v #>> '{}')::uuid)
                       from jsonb_array_elements(case when jsonb_typeof(e.value -> 'variantIds') = 'array'
                                                      then e.value -> 'variantIds' else '[]'::jsonb end) v),
                    '{}'::uuid[]) as variant_ids,
           (e.value ->> 'qty')::integer as qty
      from jsonb_array_elements(p_items) as e(value)
  ),
  merged as (
    select r.item_id, r.variant_ids, sum(r.qty)::integer as qty from req r group by r.item_id, r.variant_ids
  )
  select jsonb_build_object(
           'lines', coalesce(jsonb_agg(jsonb_build_object('menuItemId', m.item_id, 'variantIds', to_jsonb(m.variant_ids),
                                                          'qty', m.qty)
                                       order by m.item_id::text, array_to_string(m.variant_ids, ',')), '[]'::jsonb),
           'note',  nullif(btrim(coalesce(p_note, '')), ''))::text
    into v_canon
    from merged m;
  return encode(extensions.digest(convert_to(v_canon, 'UTF8'), 'sha256'), 'hex');
exception when others then
  return null;
end;
$$;

-- 2.2.0: writes one admin_alerts row, with its one-line English text built here from FIXED wording (amounts via
-- private.fmt_npr). Never a code, note or phone. The caller has set app.table_write. Returns the alert id.
--   table_void                          data: tableNumber, amount, actorName, acceptedRounds
--   table_round_cancelled_after_accept  data: tableNumber, round, amount, actorName, reason, minutesAfterAccept
--   table_expired_with_bill             data: tableNumber, amount
--   table_join_fail                     data: tableNumber (null = all tables), failures
create or replace function private.raise_admin_alert(p_kind text, p_data jsonb, p_session_id uuid)
returns uuid
language plpgsql
volatile
set search_path = ''
as $$
declare
  c_unsafe constant text := '[\x01-\x1F\x7F-\x9F‪-‮⁦-⁩]';
  v_data   jsonb := coalesce(p_data, '{}'::jsonb);
  v_table  text := coalesce(v_data ->> 'tableNumber', '?');
  v_name   text := btrim(regexp_replace(coalesce(v_data ->> 'actorName', 'a removed user'), c_unsafe, ' ', 'g'));
  v_amount text := private.fmt_npr(coalesce((v_data ->> 'amount')::bigint, 0));
  v_text   text;
  v_id     uuid;
begin
  v_text := case p_kind
    when 'table_void' then
      'Table ' || v_table || ' voided by ' || v_name || ' (' || v_amount || ', '
      || coalesce(v_data ->> 'acceptedRounds', '0') || ' accepted round'
      || case when (v_data ->> 'acceptedRounds') = '1' then '' else 's' end || ').'
    when 'table_round_cancelled_after_accept' then
      'Table ' || v_table || ': round ' || coalesce(v_data ->> 'round', '?') || ' (' || v_amount || ') cancelled by '
      || v_name || ', ' || coalesce(v_data ->> 'minutesAfterAccept', '?')
      || ' min after the kitchen accepted it (reason: ' || coalesce(v_data ->> 'reason', '?') || ').'
    when 'table_expired_with_bill' then
      'Table ' || v_table || ' was never closed: it expired with ' || v_amount || ' on the bill.'
    when 'table_join_fail' then
      case when v_data ->> 'tableNumber' is null
           then 'Many wrong table codes in the last hour (all tables: ' || coalesce(v_data ->> 'failures', '?')
                || '). If guests are seated, press New code on their table.'
           else 'Many wrong table codes in the last hour (table ' || v_table || ': '
                || coalesce(v_data ->> 'failures', '?') || '). If guests are seated there, press New code.'
      end
  end;
  if v_text is null then
    raise exception 'raise_admin_alert: unknown kind' using errcode = '22023';
  end if;
  v_text := left(regexp_replace(v_text, '[\x01-\x1F]', ' ', 'g'), 200);

  insert into public.admin_alerts (kind, text, data, session_id)
  values (p_kind, v_text, v_data, p_session_id)
  returning id into v_id;
  return v_id;
end;
$$;

-- The ONE place that changes a round's status (api-contract 9.6, 2.1.0 table + 2.2.0 window). The caller holds the
-- board lock and the session row lock and has set app.table_write; this locks the round row. Does not bump rev /
-- version (the caller does that once per call).
--   p_actor_role 'owner' | 'staff' from transition_table_order; 'system' ONLY from close_table_session and
--   auto_close_stale_table_sessions (this function is private: nothing else can call it).
-- Rules: closed table -> CONFLICT "This table is closed." (everyone). cancelled -> anything: CONFLICT.
--   staff/owner: new -> preparing; new|preparing -> served; new -> cancelled (reason, not session_closed);
--                preparing|served -> cancelled: the owner always; staff only while
--                now() <= accepted_at + order_rules.staff_cancel_window_minutes and the window > 0 (2.2.0), else
--                FORBIDDEN with the minutes in the hint. Every cancel of an accepted round raises the
--                table_round_cancelled_after_accept alert in the same transaction; a cancel of a `new` round does not.
--   system:      preparing -> served (paid close, expiry); new -> cancelled with session_closed (void, expiry).
--   Any move out of `new` sets accepted_at if it is null (new -> served at once included).
-- NOTE: the data-model helper paragraph still says "staff may cancel only `new`" (2.1.0 wording); the 2.2.0 function
-- table and api-contract 9.6 / 9.10a (the window) are what is built.
create or replace function private.transition_table_round(
  p_order_id   uuid,
  p_to         text,
  p_reason     text,
  p_actor      uuid,
  p_actor_role text
)
returns public.table_orders
language plpgsql
set search_path = ''
as $$
declare
  o        public.table_orders%rowtype;
  v_from   text;
  s        record;
  v_ok     boolean;
  v_now    timestamptz := now();
  v_window integer;
begin
  select * into o from public.table_orders where id = p_order_id for update;
  if not found then
    perform private.raise_order_error('NOT_FOUND', null, 'That order no longer exists.');
  end if;
  v_from := o.status;

  select ts.status, ts.table_number into s from public.table_sessions ts where ts.id = o.session_id;
  if s.status is distinct from 'open' then
    perform private.raise_order_error('CONFLICT', null, 'This table is closed.');
  end if;

  if p_actor_role = 'system' then
    v_ok := (v_from = 'preparing' and p_to = 'served')
         or (v_from = 'new' and p_to = 'cancelled' and p_reason = 'session_closed');
  elsif p_actor_role in ('owner', 'staff') then
    v_ok := (v_from = 'new' and p_to = 'preparing')
         or (v_from in ('new', 'preparing') and p_to = 'served')
         or (v_from in ('new', 'preparing', 'served') and p_to = 'cancelled');
    if v_ok and p_to = 'cancelled'
       and (p_reason is null or p_reason not in ('guest_request', 'unavailable', 'mistake', 'other')) then
      perform private.raise_order_error('VALIDATION', jsonb_build_object('reason',
        jsonb_build_array('Pick a reason: guest_request, unavailable, mistake or other.')));
    end if;
  else
    v_ok := false;
  end if;

  if not v_ok then
    perform private.raise_order_error('CONFLICT', null, 'That status change is not allowed.');
  end if;

  -- 2.2.0 staff cancel window for accepted rounds.
  if v_from in ('preparing', 'served') and p_to = 'cancelled' and p_actor_role = 'staff' then
    select r.staff_cancel_window_minutes into v_window from public.order_rules r limit 1;
    v_window := coalesce(v_window, 0);
    if v_window = 0 or v_now > o.accepted_at + make_interval(mins => v_window) then
      perform private.raise_order_error('FORBIDDEN', null,
        'Only the owner can cancel this order now. The kitchen accepted it more than ' || v_window || ' minutes ago.');
    end if;
  end if;

  update public.table_orders set
      status        = p_to,
      accepted_at   = case when p_to in ('preparing', 'served') then coalesce(accepted_at, v_now) else accepted_at end,
      served_at     = case when p_to = 'served' then v_now else served_at end,
      cancelled_at  = case when p_to = 'cancelled' then v_now else cancelled_at end,
      cancel_reason = case when p_to = 'cancelled' then p_reason else cancel_reason end,
      cancelled_by  = case when p_to = 'cancelled' and p_actor_role <> 'system' then p_actor else cancelled_by end
   where id = o.id
  returning * into o;

  if v_from in ('preparing', 'served') and p_to = 'cancelled' then
    perform private.raise_admin_alert('table_round_cancelled_after_accept', jsonb_build_object(
      'tableNumber',        s.table_number,
      'round',              o.round,
      'amount',             o.subtotal_paisa,
      'actorName',          (select p.display_name from public.profiles p where p.id = p_actor),
      'reason',             p_reason,
      'minutesAfterAccept', floor(extract(epoch from (v_now - o.accepted_at)) / 60)::integer), o.session_id);
  end if;
  return o;
end;
$$;

-- Replay of a known clientRequestId (2.1.0, SEC-027). Null = the id is unused. Same session + same fingerprint ->
-- the original round, replayed = true; same session + different body -> CONFLICT; another session -> VALIDATION.
create or replace function private.table_order_replay(p_session_id uuid, p_client_request_id uuid, p_items jsonb,
                                                       p_note text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  o record;
begin
  if p_client_request_id is null then
    return null;
  end if;
  select t.round, t.session_id, t.request_fingerprint into o
    from public.table_orders t where t.client_request_id = p_client_request_id;
  if not found then
    return null;
  end if;
  if o.session_id <> p_session_id then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('clientRequestId',
      jsonb_build_array('This request id was already used. Send the order again.')));
  end if;
  if o.request_fingerprint is distinct from private.table_request_fingerprint(p_items, p_note) then
    perform private.raise_order_error('CONFLICT', null,
      'This order was already sent with different items. Refresh and send again.');
  end if;
  return jsonb_build_object('round', o.round, 'replayed', true, 'session', private.table_session_guest_json(p_session_id));
end;
$$;

-- Actor checks reuse private.require_actor_role(p_actor) from 20261025000001 (FORBIDDEN without a profile).

revoke all on function private.new_table_code(), private.table_bill(bigint), private.table_session_subtotal(uuid),
                       private.table_ever_accepted(uuid), private.table_session_bill(uuid),
                       private.table_round_guest_json(uuid), private.table_round_admin_json(uuid),
                       private.table_session_guest_json(uuid), private.table_session_admin_json(uuid),
                       private.table_closed_summary_json(uuid), private.cafe_tables_json(),
                       private.table_lock_board(), private.table_board_bump(),
                       private.table_request_fingerprint(jsonb, text), private.raise_admin_alert(text, jsonb, uuid),
                       private.transition_table_round(uuid, text, text, uuid, text),
                       private.table_order_replay(uuid, uuid, jsonb, text)
  from public, anon, authenticated;

-- ===========================================================================
-- Public RPCs (service role only)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- list_cafe_tables (S): { rows: CafeTable[], mode }
-- ---------------------------------------------------------------------------
create or replace function public.list_cafe_tables(p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_actor_role(p_actor);
  return jsonb_build_object('rows', private.cafe_tables_json(),
                            'mode', (select s.table_ordering from public.site_settings s limit 1));
end;
$$;

-- ---------------------------------------------------------------------------
-- save_cafe_tables (O): the FULL set of tables. p_tables = [{ id?, number, label?, isActive }], 0..99 objects.
--   * VALIDATION: tables (not an array / over 99), tables.N.id / .number / .label / .isActive; a number used twice
--     ("That table number is used twice."); an id listed twice; a new or renumbered row taking the number of a
--     left-out table that keeps its number because it has history.
--   * NOT_FOUND: an unknown id.
--   * CONFLICT "Close table <n> first.": a table with an open session renumbered, set inactive or left out.
--   * Left-out tables: deleted if they never had a session, else deactivated (history stays).
-- Numbers can be swapped in one call (cafe_tables_number_key is deferred for this transaction).
-- ---------------------------------------------------------------------------
create or replace function public.save_cafe_tables(p_tables jsonb, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_uuid_re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_role    text;
  v_errors  jsonb := '{}'::jsonb;
  v_n       integer;
  v_changed integer := 0;
  v_rows    integer;
  r         record;
begin
  v_role := private.require_actor_role(p_actor);
  if v_role <> 'owner' then
    perform private.raise_order_error('FORBIDDEN', null, 'Only the owner can change the tables.');
  end if;

  -- Shape -----------------------------------------------------------------------------------------------------
  if p_tables is null or jsonb_typeof(p_tables) <> 'array' or jsonb_array_length(p_tables) > 99 then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('tables',
      jsonb_build_array('Send the full list of tables (at most 99).')));
  end if;

  for r in
    select (e.ord - 1)::integer as idx, e.value as v
      from jsonb_array_elements(p_tables) with ordinality as e(value, ord)
  loop
    if jsonb_typeof(r.v) <> 'object' then
      v_errors := v_errors || jsonb_build_object('tables.' || r.idx, jsonb_build_array('Each table must be an object.'));
      continue;
    end if;
    if r.v ? 'id' and jsonb_typeof(r.v -> 'id') <> 'null'
       and not (jsonb_typeof(r.v -> 'id') = 'string' and (r.v ->> 'id') ~ c_uuid_re) then
      v_errors := v_errors || jsonb_build_object('tables.' || r.idx || '.id', jsonb_build_array('Not a valid id.'));
    end if;
    if not (jsonb_typeof(r.v -> 'number') = 'number' and (r.v ->> 'number') ~ '^[0-9]{1,2}$'
            and (r.v ->> 'number')::integer between 1 and 99) then
      v_errors := v_errors || jsonb_build_object('tables.' || r.idx || '.number',
        jsonb_build_array('Use a whole number from 1 to 99.'));
    end if;
    if r.v ? 'label' and jsonb_typeof(r.v -> 'label') not in ('null', 'string') then
      v_errors := v_errors || jsonb_build_object('tables.' || r.idx || '.label', jsonb_build_array('Must be text.'));
    elsif jsonb_typeof(r.v -> 'label') = 'string' and char_length(btrim(r.v ->> 'label')) > 40 then
      v_errors := v_errors || jsonb_build_object('tables.' || r.idx || '.label',
        jsonb_build_array('At most 40 characters.'));
    elsif jsonb_typeof(r.v -> 'label') = 'string'
          and (r.v ->> 'label') ~ '[\x01-\x1F\x7F-\x9F‪-‮⁦-⁩]' then
      v_errors := v_errors || jsonb_build_object('tables.' || r.idx || '.label',
        jsonb_build_array('Use plain text only.'));
    end if;
    if jsonb_typeof(r.v -> 'isActive') is distinct from 'boolean' then
      v_errors := v_errors || jsonb_build_object('tables.' || r.idx || '.isActive',
        jsonb_build_array('Must be true or false.'));
    end if;
  end loop;
  if v_errors <> '{}'::jsonb then
    perform private.raise_order_error('VALIDATION', v_errors);
  end if;

  -- Parsed input in a temp table (dropped at commit). label: trimmed, blank = null.
  drop table if exists pg_temp.tbl_input;
  create temp table tbl_input on commit drop as
    select (e.ord - 1)::integer                                 as idx,
           nullif(e.value ->> 'id', '')::uuid                   as id,
           (e.value ->> 'number')::smallint                     as number,
           nullif(btrim(coalesce(e.value ->> 'label', '')), '') as label,
           (e.value ->> 'isActive')::boolean                    as is_active
      from jsonb_array_elements(p_tables) with ordinality as e(value, ord);

  select v_errors || coalesce(jsonb_object_agg('tables.' || x.idx || '.number',
                                jsonb_build_array('That table number is used twice.')), '{}'::jsonb)
    into v_errors
    from (select i.idx, count(*) over (partition by i.number) as n from pg_temp.tbl_input i) x
   where x.n > 1;
  select v_errors || coalesce(jsonb_object_agg('tables.' || x.idx || '.id',
                                jsonb_build_array('That table is listed twice.')), '{}'::jsonb)
    into v_errors
    from (select i.idx, count(*) over (partition by i.id) as n from pg_temp.tbl_input i where i.id is not null) x
   where x.n > 1;
  if v_errors <> '{}'::jsonb then
    perform private.raise_order_error('VALIDATION', v_errors);
  end if;

  -- Lock (shared order: board state, then cafe_tables rows by id) ---------------------------------------------
  perform private.table_lock_board();
  perform 1 from public.cafe_tables t order by t.id for update;

  if exists (select 1 from pg_temp.tbl_input i
              where i.id is not null and not exists (select 1 from public.cafe_tables t where t.id = i.id)) then
    perform private.raise_order_error('NOT_FOUND', null, 'One of these tables no longer exists. Reload and try again.');
  end if;

  -- An open table may not be renumbered, set inactive or left out.
  select t.number into v_n
    from public.cafe_tables t
    left join pg_temp.tbl_input i on i.id = t.id
   where exists (select 1 from public.table_sessions s where s.table_id = t.id and s.status = 'open')
     and (i.id is null or i.number <> t.number or not i.is_active)
   order by t.number
   limit 1;
  if v_n is not null then
    perform private.raise_order_error('CONFLICT', null, 'Close table ' || v_n || ' first.');
  end if;

  -- A left-out table with history is kept (deactivated) with its number, so nothing else may take that number.
  select v_errors || coalesce(jsonb_object_agg('tables.' || i.idx || '.number',
                                jsonb_build_array('An old table with order history uses this number. Keep that table in the list, or pick another number.')),
                              '{}'::jsonb)
    into v_errors
    from pg_temp.tbl_input i
    join public.cafe_tables t on t.number = i.number and t.id is distinct from i.id
   where not exists (select 1 from pg_temp.tbl_input k where k.id = t.id)
     and exists (select 1 from public.table_sessions s where s.table_id = t.id);
  if v_errors <> '{}'::jsonb then
    perform private.raise_order_error('VALIDATION', v_errors);
  end if;

  -- Write ------------------------------------------------------------------------------------------------------
  perform set_config('app.table_write', 'on', true);
  set constraints public.cafe_tables_number_key deferred;

  delete from public.cafe_tables t
   where not exists (select 1 from pg_temp.tbl_input i where i.id = t.id)
     and not exists (select 1 from public.table_sessions s where s.table_id = t.id);
  get diagnostics v_rows = row_count;
  v_changed := v_changed + v_rows;

  update public.cafe_tables t set is_active = false
   where not exists (select 1 from pg_temp.tbl_input i where i.id = t.id)
     and t.is_active;
  get diagnostics v_rows = row_count;
  v_changed := v_changed + v_rows;

  update public.cafe_tables t
     set number = i.number, label = i.label, is_active = i.is_active
    from pg_temp.tbl_input i
   where i.id = t.id
     and (t.number, t.label, t.is_active) is distinct from (i.number, i.label, i.is_active);
  get diagnostics v_rows = row_count;
  v_changed := v_changed + v_rows;

  insert into public.cafe_tables (number, label, is_active)
  select i.number, i.label, i.is_active from pg_temp.tbl_input i where i.id is null order by i.idx;
  get diagnostics v_rows = row_count;
  v_changed := v_changed + v_rows;

  begin
    set constraints public.cafe_tables_number_key immediate;     -- check uniqueness now, inside this function
  exception when unique_violation then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('tables',
      jsonb_build_array('Two tables would have the same number.')));
  end;

  if v_changed > 0 then
    perform private.table_board_bump();
  end if;
  perform set_config('app.table_write', 'off', true);
  drop table if exists pg_temp.tbl_input;

  return jsonb_build_object('rows', private.cafe_tables_json());
end;
$$;

-- ---------------------------------------------------------------------------
-- set_table_ordering: owner any mode; staff only 'on' <-> 'paused' (FORBIDDEN for 'off' or away from 'off').
-- 'off' with an open session: CONFLICT "Close all open tables first." Sets app.table_write (site_settings guard).
-- Returns the mode. No change = no bump.
-- ---------------------------------------------------------------------------
create or replace function public.set_table_ordering(p_mode text, p_actor uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_cur  text;
begin
  v_role := private.require_actor_role(p_actor);
  if p_mode is null or p_mode not in ('off', 'on', 'paused') then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('mode', jsonb_build_array('off, on or paused')));
  end if;

  perform private.table_lock_board();
  select s.table_ordering into v_cur from public.site_settings s limit 1 for update;

  if v_role <> 'owner' and not (v_cur in ('on', 'paused') and p_mode in ('on', 'paused')) then
    perform private.raise_order_error('FORBIDDEN', null,
      'Staff can pause and resume table ordering. Ask the owner to turn it on or off.');
  end if;
  if v_cur = p_mode then
    return p_mode;
  end if;
  if p_mode = 'off' and exists (select 1 from public.table_sessions s where s.status = 'open') then
    perform private.raise_order_error('CONFLICT', null, 'Close all open tables first.');
  end if;

  perform set_config('app.table_write', 'on', true);
  update public.site_settings set table_ordering = p_mode;
  perform private.table_board_bump();
  perform set_config('app.table_write', 'off', true);
  return p_mode;
end;
$$;

-- ---------------------------------------------------------------------------
-- open_table_session (S): new session with a fresh 6-character code. Returns AdminTableSession.
-- Already open (also a race between two phones, caught as unique_violation): CONFLICT
-- "Table <n> is still open from <HH:mm>. Close it first, or press New code." (Kathmandu opened_at, 2.1.0).
-- ---------------------------------------------------------------------------
create or replace function public.open_table_session(p_table_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t      public.cafe_tables%rowtype;
  v_id   uuid;
  v_open timestamptz;
begin
  perform private.require_actor_role(p_actor);

  perform private.table_lock_board();
  if (select s.table_ordering from public.site_settings s limit 1) = 'off' then
    perform private.raise_order_error('CONFLICT', null, 'Table ordering is off. Turn it on in Tables setup.');
  end if;

  select * into t from public.cafe_tables where id = p_table_id for update;
  if not found then
    perform private.raise_order_error('NOT_FOUND', null, 'That table no longer exists.');
  end if;
  if not t.is_active then
    perform private.raise_order_error('CONFLICT', null, 'This table is not in use.');
  end if;

  select s.opened_at into v_open from public.table_sessions s where s.table_id = t.id and s.status = 'open';
  if v_open is null then
    perform set_config('app.table_write', 'on', true);
    begin
      insert into public.table_sessions (table_id, table_number, code, opened_by)
      values (t.id, t.number, private.new_table_code(), p_actor)
      returning id into v_id;
    exception when unique_violation then
      select s.opened_at into v_open from public.table_sessions s where s.table_id = t.id and s.status = 'open';
      v_open := coalesce(v_open, now());
    end;
  end if;
  if v_open is not null then
    perform private.raise_order_error('CONFLICT', null,
      'Table ' || t.number || ' is still open from ' || to_char(v_open at time zone 'Asia/Kathmandu', 'HH24:MI')
      || '. Close it first, or press New code.');
  end if;

  perform private.table_board_bump();
  perform set_config('app.table_write', 'off', true);
  return private.table_session_admin_json(v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- rotate_table_code (S, 2.1.0 SEC-023): a new code for the SAME open session (different from the old one),
-- cookie_epoch + 1 (every guest who joined before gets `none` / TABLE_SESSION_INVALID), rev + 1, board version + 1.
-- Rounds, the bill and orders_locked are unchanged. Closed: CONFLICT "This table is closed." Returns AdminTableSession.
-- ---------------------------------------------------------------------------
create or replace function public.rotate_table_code(p_session_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s      public.table_sessions%rowtype;
  v_code text;
begin
  perform private.require_actor_role(p_actor);
  perform private.table_lock_board();
  select * into s from public.table_sessions where id = p_session_id for update;
  if not found then
    perform private.raise_order_error('NOT_FOUND', null, 'That table session no longer exists.');
  end if;
  if s.status <> 'open' then
    perform private.raise_order_error('CONFLICT', null, 'This table is closed.');
  end if;
  if s.cookie_epoch >= 32767 then
    perform private.raise_order_error('CONFLICT', null, 'Too many new codes for this table. Close it and open it again.');
  end if;

  loop
    v_code := private.new_table_code();
    exit when v_code <> s.code;
  end loop;

  perform set_config('app.table_write', 'on', true);
  update public.table_sessions
     set code = v_code, cookie_epoch = cookie_epoch + 1, rev = rev + 1
   where id = s.id;
  perform private.table_board_bump();
  perform set_config('app.table_write', 'off', true);
  return private.table_session_admin_json(s.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- set_table_orders_locked (S, 2.1.0 SEC-023): stop (true) or allow (false) app orders for one open table. While
-- locked, create_table_order answers TABLE_ORDERS_PAUSED with the table message (replays still return their round).
-- Closing clears it. Idempotent: no change = no bump. Closed: CONFLICT "This table is closed." Returns AdminTableSession.
-- ---------------------------------------------------------------------------
create or replace function public.set_table_orders_locked(p_session_id uuid, p_locked boolean, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.table_sessions%rowtype;
begin
  perform private.require_actor_role(p_actor);
  if p_locked is null then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('locked', jsonb_build_array('true or false')));
  end if;
  perform private.table_lock_board();
  select * into s from public.table_sessions where id = p_session_id for update;
  if not found then
    perform private.raise_order_error('NOT_FOUND', null, 'That table session no longer exists.');
  end if;
  if s.status <> 'open' then
    perform private.raise_order_error('CONFLICT', null, 'This table is closed.');
  end if;
  if s.orders_locked is distinct from p_locked then
    perform set_config('app.table_write', 'on', true);
    update public.table_sessions set orders_locked = p_locked, rev = rev + 1 where id = s.id;
    perform private.table_board_bump();
    perform set_config('app.table_write', 'off', true);
  end if;
  return private.table_session_admin_json(s.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- join_table_session (no actor; the server calls it after Turnstile and its IP limits). Writes nothing.
-- Mode 'off': NOT_FOUND. Code normalised (spaces and '-' removed, upper case). ONE identical VALIDATION with fixed
-- text for every miss: unknown number, inactive table, free table, wrong or old code, session opened 12 h or more ago.
-- The typed code never appears in MESSAGE, DETAIL or HINT. Failed joins are counted by the backend in rate_limits
-- (table-join-fail:*), and the threshold alert goes through record_admin_alert().
-- Returns { sessionId, epoch, view: TableSessionView }; epoch (cookie_epoch) goes into the signed cookie.
-- ---------------------------------------------------------------------------
create or replace function public.join_table_session(p_table_number integer, p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_code  text := upper(regexp_replace(coalesce(p_code, ''), '[\s-]', '', 'g'));
  v_id    uuid;
  v_epoch smallint;
begin
  if (select s.table_ordering from public.site_settings s limit 1) = 'off' then
    perform private.raise_order_error('NOT_FOUND');
  end if;

  select s.id, s.cookie_epoch into v_id, v_epoch
    from public.cafe_tables t
    join public.table_sessions s on s.table_id = t.id and s.status = 'open'
   where t.number = p_table_number
     and t.is_active
     and s.opened_at > now() - interval '12 hours'
     and s.code = v_code;

  if v_id is null then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('code',
      jsonb_build_array('That code doesn''t match this table. Check it, or ask our staff.')));
  end if;

  return jsonb_build_object('sessionId', v_id, 'epoch', v_epoch, 'view', private.table_session_guest_json(v_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- table_session_guest_view (no actor; the signed cookie gives session + epoch). TableGuestState:
--   unknown session, mode 'off', or p_epoch <> cookie_epoch -> {state:"none"};
--   closed, or open with opened_at <= now() - 12 h (2.1.0, SEC-029) -> {state:"closed", tableNumber};
--   open and p_since = rev -> {state:"unchanged", rev}; else {state:"open", session} (guest builder).
-- ---------------------------------------------------------------------------
create or replace function public.table_session_guest_view(
  p_session_id uuid,
  p_epoch      smallint,
  p_since      integer default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s record;
begin
  select ts.id, ts.status, ts.rev, ts.table_number, ts.opened_at, ts.cookie_epoch into s
    from public.table_sessions ts where ts.id = p_session_id;
  if not found
     or (select st.table_ordering from public.site_settings st limit 1) = 'off'
     or p_epoch is distinct from s.cookie_epoch then
    return jsonb_build_object('state', 'none');
  end if;
  if s.status <> 'open' or s.opened_at <= now() - interval '12 hours' then
    return jsonb_build_object('state', 'closed', 'tableNumber', s.table_number);
  end if;
  if p_since is not null and p_since = s.rev then
    return jsonb_build_object('state', 'unchanged', 'rev', s.rev);
  end if;
  return jsonb_build_object('state', 'open', 'session', private.table_session_guest_json(s.id));
end;
$$;

-- ---------------------------------------------------------------------------
-- create_table_order (no actor; session + epoch from the signed cookie are the credential). api-contract 9.5 (2.1.0):
--    6 session exists, open, opened < 12 h ago, cookie_epoch = p_epoch; row locked FOR UPDATE -> else TABLE_SESSION_INVALID
--    7 replay (before the mode check, SEC-027): same id + same fingerprint -> the original round, replayed = true,
--      nothing bumped; same id + other body -> CONFLICT; id used in another session -> VALIDATION clientRequestId
--    8 mode off -> NOT_FOUND; paused -> TABLE_ORDERS_PAUSED; orders_locked -> TABLE_ORDERS_PAUSED (table message)
--    9 input: items 1..20 lines {menuItemId, variantIds? (0..4 unique uuids), qty 1..20}; note <= 200 after trimming,
--      '' = absent, plain text (no control characters incl. newline, no bidi overrides); clientRequestId required;
--      lines merged by (menuItemId, set of variantIds), merged qty <= 20 -> VALIDATION
--   10 rounds created in the last 10 min >= 6 -> RATE_LIMITED {retryAfterSeconds} (from the oldest round in the window)
--   11 rounds still 'new' >= 3 -> CONFLICT
--   12 not-cancelled rounds >= 30, or all rounds >= 60 -> CONFLICT (SEC-023)
--   13 item exists, not deleted, visible, category visible; options belong to the item; one per kind -> VALIDATION items.N
--   14 item or a chosen option sold out -> OUT_OF_STOCK items.N ["sold out"]
--   15 round subtotal <= 2,000,000 paisa -> else VALIDATION items
--   16 insert round (next number, fingerprint) + lines (snapshots), rev + 1, version + 1. A unique_violation on a
--      clientRequestId index (a concurrent duplicate) is answered as the replay / VALIDATION, never INTERNAL.
-- items.N = index in the REQUEST (for merged lines, the first line of the group). Returns {round, replayed, session}.
-- ---------------------------------------------------------------------------
create or replace function public.create_table_order(
  p_session_id        uuid,
  p_epoch             smallint,
  p_client_request_id uuid,
  p_items             jsonb,
  p_note              text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_uuid_re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_mode     text;
  s          public.table_sessions%rowtype;
  v_replay   jsonb;
  v_note     text := nullif(btrim(coalesce(p_note, '')), '');
  v_errors   jsonb := '{}'::jsonb;
  v_oos      jsonb := '{}'::jsonb;
  v_cnt      integer;
  v_oldest   timestamptz;
  v_subtotal bigint;
  v_round    integer;
  v_order_id uuid;
  v_cons     text;
begin
  perform private.table_lock_board();

  -- 6. Session + epoch (locked: serialises rounds and close) -------------------------------------------------------
  select * into s from public.table_sessions where id = p_session_id for update;
  if not found or s.status <> 'open' or s.opened_at <= now() - interval '12 hours'
     or p_epoch is distinct from s.cookie_epoch then
    perform private.raise_order_error('TABLE_SESSION_INVALID', null,
      'Your table is not open for ordering. Enter the code from our staff to order.');
  end if;

  -- 7. Replay, before the mode check: a round that exists is always reported as sent (SEC-027) ---------------------
  v_replay := private.table_order_replay(s.id, p_client_request_id, p_items, p_note);
  if v_replay is not null then
    return v_replay;
  end if;

  -- 8. Mode and the per-table stop -----------------------------------------------------------------------------
  select st.table_ordering into v_mode from public.site_settings st limit 1;
  if v_mode = 'off' then
    perform private.raise_order_error('NOT_FOUND');
  end if;
  if v_mode = 'paused' then
    perform private.raise_order_error('TABLE_ORDERS_PAUSED', null,
      'The kitchen is not taking orders from the app right now. Please order with our staff.');
  end if;
  if s.orders_locked then
    perform private.raise_order_error('TABLE_ORDERS_PAUSED', null,
      'Ordering from the app is stopped for this table. Please order with our staff.');
  end if;

  -- 9. Input -----------------------------------------------------------------------------------------------------
  if p_client_request_id is null then
    v_errors := v_errors || jsonb_build_object('clientRequestId', jsonb_build_array('required'));
  end if;
  if v_note is not null and char_length(v_note) > 200 then
    v_errors := v_errors || jsonb_build_object('note', jsonb_build_array('At most 200 characters.'));
  elsif v_note ~ '[\x01-\x1F\x7F-\x9F‪-‮⁦-⁩]' then
    v_errors := v_errors || jsonb_build_object('note', jsonb_build_array('One line of plain text only.'));
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 20 then
    v_errors := v_errors || jsonb_build_object('items', jsonb_build_array('Send 1 to 20 lines.'));
  else
    select v_errors || coalesce(jsonb_object_agg('items.' || (e.ord - 1), jsonb_build_array(
             'Each line needs a menuItemId, up to 4 different options and a whole qty from 1 to 20.')), '{}'::jsonb)
      into v_errors
      from jsonb_array_elements(p_items) with ordinality as e(value, ord)
     where not coalesce(
             jsonb_typeof(e.value) = 'object'
             and jsonb_typeof(e.value -> 'menuItemId') = 'string'
             and (e.value ->> 'menuItemId') ~ c_uuid_re
             and jsonb_typeof(e.value -> 'qty') = 'number'
             and (e.value ->> 'qty') ~ '^[0-9]{1,2}$'
             and (e.value ->> 'qty')::integer between 1 and 20
             and (not (e.value ? 'variantIds') or jsonb_typeof(e.value -> 'variantIds') = 'null'
                  or (jsonb_typeof(e.value -> 'variantIds') = 'array'
                      and jsonb_array_length(e.value -> 'variantIds') <= 4
                      and not exists (select 1 from jsonb_array_elements(e.value -> 'variantIds') v
                                       where jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ c_uuid_re)
                      and (select count(distinct lower(v #>> '{}')) from jsonb_array_elements(e.value -> 'variantIds') v)
                          = jsonb_array_length(e.value -> 'variantIds'))),
             false);
  end if;
  if v_errors <> '{}'::jsonb then
    perform private.raise_order_error('VALIDATION', v_errors);
  end if;

  -- Merge lines by (menuItemId, sorted set of variantIds). Kept in a temp table for steps 13..16.
  drop table if exists pg_temp.tbl_round_lines;
  create temp table tbl_round_lines on commit drop as
    with req as (
      select (e.ord - 1)::integer as idx,
             (e.value ->> 'menuItemId')::uuid as item_id,
             coalesce((select array_agg(distinct (v #>> '{}')::uuid order by (v #>> '{}')::uuid)
                         from jsonb_array_elements(case when jsonb_typeof(e.value -> 'variantIds') = 'array'
                                                        then e.value -> 'variantIds' else '[]'::jsonb end) v),
                      '{}'::uuid[]) as variant_ids,
             (e.value ->> 'qty')::integer as qty
        from jsonb_array_elements(p_items) with ordinality as e(value, ord)
    )
    select min(req.idx) as idx, req.item_id, req.variant_ids, sum(req.qty)::integer as qty,
           null::text as name, null::text as options, null::integer as unit_price, null::text as problem,
           false as sold_out
      from req
     group by req.item_id, req.variant_ids;

  select v_errors || coalesce(jsonb_object_agg('items.' || l.idx, jsonb_build_array('At most 20 of one item.')), '{}'::jsonb)
    into v_errors
    from pg_temp.tbl_round_lines l where l.qty > 20;
  if v_errors <> '{}'::jsonb then
    perform private.raise_order_error('VALIDATION', v_errors);
  end if;

  -- 10..12. Session caps -----------------------------------------------------------------------------------------
  select count(*), min(o.created_at) into v_cnt, v_oldest
    from public.table_orders o
   where o.session_id = s.id and o.created_at > now() - interval '10 minutes';
  if v_cnt >= 6 then
    perform private.raise_order_error('RATE_LIMITED', jsonb_build_object('retryAfterSeconds',
      greatest(ceil(extract(epoch from (v_oldest + interval '10 minutes' - now())))::integer, 1)));
  end if;
  if (select count(*) from public.table_orders o where o.session_id = s.id and o.status = 'new') >= 3 then
    perform private.raise_order_error('CONFLICT', null,
      'Your earlier orders are still waiting for the kitchen. Please wait a moment or ask our staff.');
  end if;
  if (select count(*) from public.table_orders o where o.session_id = s.id and o.status <> 'cancelled') >= 30
     or (select count(*) from public.table_orders o where o.session_id = s.id) >= 60 then
    perform private.raise_order_error('CONFLICT', null, 'Please order the rest with our staff.');
  end if;

  -- 13. Re-price from the menu; availability and options ------------------------------------------------------------
  update pg_temp.tbl_round_lines l
     set name       = x.name,
         options    = x.options,
         unit_price = x.unit_price,
         sold_out   = x.sold_out,
         problem    = x.problem
    from (
      select l2.idx,
             i.name,
             (select string_agg(v.label, ', ' order by v.sort_order, v.label)
                from public.menu_variants v where v.id = any (l2.variant_ids)) as options,
             greatest(0, i.price_paisa + coalesce((select sum(v.price_delta_paisa)
                                                     from public.menu_variants v where v.id = any (l2.variant_ids)), 0))::integer
               as unit_price,
             coalesce(i.is_sold_out, false)
               or exists (select 1 from public.menu_variants v where v.id = any (l2.variant_ids) and v.is_sold_out)
               as sold_out,
             case
               when i.id is null or i.deleted_at is not null or not i.is_visible or not c.is_visible
                 or (select count(*) from public.menu_variants v
                      where v.id = any (l2.variant_ids) and v.item_id = i.id) <> cardinality(l2.variant_ids)
                 then 'This item is no longer on the menu.'
               when (select count(distinct v.kind) from public.menu_variants v where v.id = any (l2.variant_ids))
                    <> cardinality(l2.variant_ids)
                 then 'Pick at most one option of each kind.'
             end as problem
        from pg_temp.tbl_round_lines l2
        left join public.menu_items i on i.id = l2.item_id
        left join public.menu_categories c on c.id = i.category_id
    ) x
   where x.idx = l.idx;

  select coalesce(jsonb_object_agg('items.' || l.idx, jsonb_build_array(l.problem)), '{}'::jsonb)
    into v_errors
    from pg_temp.tbl_round_lines l where l.problem is not null;
  if v_errors <> '{}'::jsonb then
    perform private.raise_order_error('VALIDATION', v_errors);
  end if;

  -- 14. Sold out -------------------------------------------------------------------------------------------------
  select coalesce(jsonb_object_agg('items.' || l.idx, jsonb_build_array('sold out')), '{}'::jsonb)
    into v_oos
    from pg_temp.tbl_round_lines l where l.sold_out;
  if v_oos <> '{}'::jsonb then
    perform private.raise_order_error('OUT_OF_STOCK', v_oos);
  end if;

  -- 15. Round size cap -------------------------------------------------------------------------------------------
  select coalesce(sum(l.unit_price::bigint * l.qty), 0) into v_subtotal from pg_temp.tbl_round_lines l;
  if v_subtotal > 2000000 then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('items', jsonb_build_array(
      'This order is too large to send from the app. Please order with our staff.')));
  end if;

  -- 16. Insert -----------------------------------------------------------------------------------------------------
  perform set_config('app.table_write', 'on', true);
  select coalesce(max(o.round), 0) + 1 into v_round from public.table_orders o where o.session_id = s.id;

  begin
    insert into public.table_orders (session_id, round, client_request_id, request_fingerprint, note, subtotal_paisa)
    values (s.id, v_round, p_client_request_id, private.table_request_fingerprint(p_items, p_note), v_note, v_subtotal)
    returning id into v_order_id;
  exception when unique_violation then
    get stacked diagnostics v_cons = constraint_name;
    if v_cons in ('table_orders_client_request_id_key', 'table_orders_session_request_key') then
      perform set_config('app.table_write', 'off', true);
      return private.table_order_replay(s.id, p_client_request_id, p_items, p_note);
    end if;
    raise;
  end;

  insert into public.table_order_items (order_id, line_no, menu_item_ref, variant_refs, name_snapshot,
                                        options_snapshot, unit_price_paisa, qty)
  select v_order_id, row_number() over (order by l.idx), l.item_id, l.variant_ids, l.name, l.options,
         l.unit_price, l.qty
    from pg_temp.tbl_round_lines l
   order by l.idx;

  update public.table_sessions set rev = rev + 1 where id = s.id;
  perform private.table_board_bump();
  perform set_config('app.table_write', 'off', true);
  drop table if exists pg_temp.tbl_round_lines;

  return jsonb_build_object('round', v_round, 'replayed', false, 'session', private.table_session_guest_json(s.id));
end;
$$;

-- ---------------------------------------------------------------------------
-- transition_table_order (S; accepted rounds: staff within the window, else O). p_to: preparing | served | cancelled.
-- Returns AdminTableRound. reason (cancel only): guest_request | unavailable | mistake | other; session_closed ->
-- VALIDATION reason. Unknown round -> NOT_FOUND; table closed -> CONFLICT "This table is closed."; illegal -> CONFLICT
-- "That status change is not allowed."; staff after the window -> FORBIDDEN (minutes in the hint). Every cancel of an
-- accepted round writes the table_round_cancelled_after_accept alert in this transaction.
-- ---------------------------------------------------------------------------
create or replace function public.transition_table_order(p_order_id uuid, p_to text, p_reason text, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role    text;
  v_session uuid;
  o         public.table_orders%rowtype;
begin
  v_role := private.require_actor_role(p_actor);
  if p_to is null or p_to not in ('preparing', 'served', 'cancelled') then
    perform private.raise_order_error('CONFLICT', null, 'That status change is not allowed.');
  end if;
  if p_to = 'cancelled' and p_reason = 'session_closed' then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('reason',
      jsonb_build_array('This reason is set by the system only.')));
  end if;

  perform private.table_lock_board();
  select t.session_id into v_session from public.table_orders t where t.id = p_order_id;
  if v_session is null then
    perform private.raise_order_error('NOT_FOUND', null, 'That order no longer exists.');
  end if;
  perform 1 from public.table_sessions s where s.id = v_session for update;

  perform set_config('app.table_write', 'on', true);
  o := private.transition_table_round(p_order_id, p_to, case when p_to = 'cancelled' then p_reason end,
                                      p_actor, v_role);
  update public.table_sessions set rev = rev + 1 where id = v_session;
  perform private.table_board_bump();
  perform set_config('app.table_write', 'off', true);

  return private.table_round_admin_json(o.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- close_table_session (S; O per SEC-022). api-contract 9.7 closeTable. Order: lock -> open? (CONFLICT "This table is
-- already closed.") -> paidVia rules (VALIDATION paidVia) -> any 'new' round on a paid close (CONFLICT) -> expected
-- total vs the live bill total (CONFLICT) -> role rule from HISTORY, not the live subtotal: staff + void + ever
-- accepted, or staff + paid + total 0 + ever accepted -> FORBIDDEN "Only the owner can void a table after an order was
-- accepted." -> move rounds (paid: preparing -> served; void: only new -> cancelled session_closed; accepted rounds
-- stay and the snapshot keeps them) -> bill snapshot, code erased, orders_locked cleared, status closed. Every void
-- writes the table_void alert in this transaction. Returns ClosedTableSummary.
-- ---------------------------------------------------------------------------
create or replace function public.close_table_session(
  p_session_id     uuid,
  p_outcome        text,
  p_paid_via       text,
  p_expected_total integer,
  p_actor          uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role     text;
  s          public.table_sessions%rowtype;
  v_bill     jsonb;
  v_accepted boolean;
  v_id       uuid;
begin
  v_role := private.require_actor_role(p_actor);
  if p_outcome is null or p_outcome not in ('paid', 'void') then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('outcome', jsonb_build_array('paid or void')));
  end if;
  if p_expected_total is null or p_expected_total < 0 then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('expectedTotal',
      jsonb_build_array('Send the total shown on the screen.')));
  end if;

  perform private.table_lock_board();
  select * into s from public.table_sessions where id = p_session_id for update;
  if not found then
    perform private.raise_order_error('NOT_FOUND', null, 'That table session no longer exists.');
  end if;
  if s.status <> 'open' then
    perform private.raise_order_error('CONFLICT', null, 'This table is already closed.');
  end if;

  if p_outcome = 'paid' and (p_paid_via is null or p_paid_via not in ('cash', 'fonepay', 'other')) then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('paidVia', jsonb_build_array('cash, fonepay or other')));
  end if;
  if p_outcome = 'void' and p_paid_via is not null then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('paidVia',
      jsonb_build_array('Leave this empty when voiding a table.')));
  end if;

  if p_outcome = 'paid' and exists (select 1 from public.table_orders o where o.session_id = s.id and o.status = 'new') then
    perform private.raise_order_error('CONFLICT', null, 'Accept or cancel the new order first.');
  end if;

  v_bill := private.table_bill(private.table_session_subtotal(s.id));
  if (v_bill ->> 'total')::bigint <> p_expected_total then
    perform private.raise_order_error('CONFLICT', null, 'The total changed. Check the new total and close again.');
  end if;

  v_accepted := private.table_ever_accepted(s.id);
  if v_role <> 'owner' and v_accepted
     and (p_outcome = 'void' or (v_bill ->> 'total')::bigint = 0) then
    perform private.raise_order_error('FORBIDDEN', null, 'Only the owner can void a table after an order was accepted.');
  end if;

  perform set_config('app.table_write', 'on', true);
  for v_id in
    select o.id from public.table_orders o
     where o.session_id = s.id
       and o.status = case when p_outcome = 'paid' then 'preparing' else 'new' end
     order by o.round
       for update
  loop
    if p_outcome = 'paid' then
      perform private.transition_table_round(v_id, 'served', null, null, 'system');
    else
      perform private.transition_table_round(v_id, 'cancelled', 'session_closed', null, 'system');
    end if;
  end loop;

  v_bill := private.table_bill(private.table_session_subtotal(s.id));
  update public.table_sessions set
      status               = 'closed',
      outcome              = p_outcome,
      paid_via             = case when p_outcome = 'paid' then p_paid_via end,
      closed_by            = p_actor,
      closed_at            = now(),
      code                 = null,
      orders_locked        = false,
      prices_include_vat   = (v_bill ->> 'pricesIncludeVat')::boolean,
      subtotal_paisa       = (v_bill ->> 'subtotal')::integer,
      service_charge_paisa = (v_bill ->> 'serviceCharge')::integer,
      vat_paisa            = (v_bill ->> 'vat')::integer,
      total_paisa          = (v_bill ->> 'total')::integer,
      rev                  = rev + 1
   where id = s.id;

  if p_outcome = 'void' then
    perform private.raise_admin_alert('table_void', jsonb_build_object(
      'tableNumber',    s.table_number,
      'amount',         (v_bill ->> 'total')::bigint,
      'actorName',      (select p.display_name from public.profiles p where p.id = p_actor),
      'acceptedRounds', (select count(*) from public.table_orders o where o.session_id = s.id and o.accepted_at is not null)),
      s.id);
  end if;
  perform private.table_board_bump();
  perform set_config('app.table_write', 'off', true);

  return private.table_closed_summary_json(s.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- table_board (S): the change-only feed. cursor = version || '-' || Kathmandu date (YYYYMMDD), so "closed today" rolls
-- over at midnight. p_since = cursor -> {changed:false, cursor, serverTime} with no other reads. Else TableBoard.
-- ---------------------------------------------------------------------------
create or replace function public.table_board(p_since text, p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today  date := private.ktm_date(now());
  v_cursor text;
  v_from   timestamptz;
  v_to     timestamptz;
begin
  perform private.require_actor_role(p_actor);
  select b.version::text || '-' || to_char(v_today, 'YYYYMMDD') into v_cursor from public.table_board_state b;
  if p_since is not null and p_since = v_cursor then
    return jsonb_build_object('changed', false, 'cursor', v_cursor, 'serverTime', now());
  end if;

  v_from := private.ktm_day_start(v_today);
  v_to   := private.ktm_day_start(v_today + 1);

  return jsonb_build_object(
    'changed',    true,
    'cursor',     v_cursor,
    'serverTime', now(),
    'mode',       (select st.table_ordering from public.site_settings st limit 1),
    'tables',     coalesce((
                    select jsonb_agg(jsonb_build_object(
                             'tableId', t.id,
                             'number',  t.number,
                             'label',   t.label,
                             'session', (select private.table_session_admin_json(s.id)
                                           from public.table_sessions s
                                          where s.table_id = t.id and s.status = 'open'))
                           order by t.number)
                      from public.cafe_tables t
                     where t.is_active), '[]'::jsonb),
    'closedToday', coalesce((
                    select jsonb_agg(private.table_closed_summary_json(x.id) order by x.closed_at desc, x.id)
                      from (select s.id, s.closed_at
                              from public.table_sessions s
                             where s.status = 'closed' and s.closed_at >= v_from and s.closed_at < v_to
                             order by s.closed_at desc, s.id
                             limit 200) x), '[]'::jsonb),
    'closedTodayTotals', (
                    select jsonb_build_object(
                             'tables',    count(*),
                             'paid',      coalesce(sum(s.total_paisa) filter (where s.outcome = 'paid'), 0),
                             'byPaidVia', jsonb_build_object(
                                            'cash',    coalesce(sum(s.total_paisa) filter (where s.paid_via = 'cash'), 0),
                                            'fonepay', coalesce(sum(s.total_paisa) filter (where s.paid_via = 'fonepay'), 0),
                                            'other',   coalesce(sum(s.total_paisa) filter (where s.paid_via = 'other'), 0)),
                             'voided',    count(*) filter (where s.outcome = 'void'),
                             'expired',   count(*) filter (where s.outcome = 'expired'))
                      from public.table_sessions s
                     where s.status = 'closed' and s.closed_at >= v_from and s.closed_at < v_to));
end;
$$;

-- ---------------------------------------------------------------------------
-- auto_close_stale_table_sessions (service role; pg_cron every 15 min). Sessions open since 12 h or more, oldest
-- first, at most 200 per run, FOR UPDATE SKIP LOCKED (after the board lock). Outcome 'expired', closed_by null.
-- 2.1.0 (SEC-022): `new` rounds -> cancelled session_closed; `preparing` -> served (the food stays on the bill).
-- Bill snapshot, code erased, orders_locked cleared. A bill above 0 writes the table_expired_with_bill alert in the
-- same step. One failing session is skipped and counted. Returns {closed, failed, ranAt}.
-- ---------------------------------------------------------------------------
create or replace function public.auto_close_stale_table_sessions()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id     uuid;
  v_round  record;
  v_bill   jsonb;
  v_done   integer := 0;
  v_failed integer := 0;
begin
  perform private.table_lock_board();
  perform set_config('app.table_write', 'on', true);

  for v_id in
    select s.id
      from public.table_sessions s
     where s.status = 'open' and s.opened_at <= now() - interval '12 hours'
     order by s.opened_at
     limit 200
       for update skip locked
  loop
    begin
      for v_round in
        select o.id, o.status from public.table_orders o
         where o.session_id = v_id and o.status in ('new', 'preparing')
         order by o.round
           for update
      loop
        if v_round.status = 'new' then
          perform private.transition_table_round(v_round.id, 'cancelled', 'session_closed', null, 'system');
        else
          perform private.transition_table_round(v_round.id, 'served', null, null, 'system');
        end if;
      end loop;

      v_bill := private.table_bill(private.table_session_subtotal(v_id));
      update public.table_sessions set
          status               = 'closed',
          outcome              = 'expired',
          paid_via             = null,
          closed_by            = null,
          closed_at            = now(),
          code                 = null,
          orders_locked        = false,
          prices_include_vat   = (v_bill ->> 'pricesIncludeVat')::boolean,
          subtotal_paisa       = (v_bill ->> 'subtotal')::integer,
          service_charge_paisa = (v_bill ->> 'serviceCharge')::integer,
          vat_paisa            = (v_bill ->> 'vat')::integer,
          total_paisa          = (v_bill ->> 'total')::integer,
          rev                  = rev + 1
       where id = v_id;

      if (v_bill ->> 'total')::bigint > 0 then
        perform private.raise_admin_alert('table_expired_with_bill', jsonb_build_object(
          'tableNumber', (select s.table_number from public.table_sessions s where s.id = v_id),
          'amount',      (v_bill ->> 'total')::bigint), v_id);
      end if;
      v_done := v_done + 1;
    exception when others then
      v_failed := v_failed + 1;
      raise warning 'auto_close_stale_table_sessions: session % skipped (%)', v_id, sqlstate;
    end;
  end loop;

  if v_done > 0 then
    perform private.table_board_bump();
  end if;
  perform set_config('app.table_write', 'off', true);
  return jsonb_build_object('closed', v_done, 'failed', v_failed, 'ranAt', now());
end;
$$;

-- ---------------------------------------------------------------------------
-- stats_table_orders (OWNER): StatsTableOrders (api-contract 9.11, 2.1.0). Kathmandu dates, inclusive, at most 1,096
-- days (same range rules and errors as the decision 21 RPCs). Never mixed into the daily log figures.
--   rounds / cancelledRounds   rounds CREATED in the range, not cancelled / cancelled
--   cancelledAfterAccept       cancelled rounds with accepted_at set, by cancelled_at in the range (SEC-022)
--   paidTables, paidTotalPaisa sessions closed 'paid' with closed_at in the range; sum of their bill snapshots
--   voidedTables, expiredTables sessions closed 'void' / 'expired' with closed_at in the range
--   expiredWithOrdersPaisa     sum of bill snapshots of 'expired' sessions closed in the range (SEC-022)
--   topItems  top 10 by qty, then revenue (then name, id): lines of rounds created in the range that are not
--             cancelled, in sessions still open or closed 'paid' (void and expired excluded); name = latest snapshot
--   byHour    24 entries, Kathmandu hour of created_at, rounds not cancelled (sums to `rounds`)
-- ---------------------------------------------------------------------------
create or replace function public.stats_table_orders(p_from date, p_to date, p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from timestamptz;
  v_to   timestamptz;
  r      record;
  q      record;
  v_caa  integer;
  v_top  jsonb;
  v_hour jsonb;
begin
  perform private.stats_require_owner(p_actor);
  perform private.stats_check_range(p_from, p_to);
  v_from := private.ktm_day_start(p_from);
  v_to   := private.ktm_day_start(p_to + 1);

  select count(*) filter (where o.status <> 'cancelled')::integer as rounds,
         count(*) filter (where o.status = 'cancelled')::integer  as cancelled
    into r
    from public.table_orders o
   where o.created_at >= v_from and o.created_at < v_to;

  select count(*)::integer into v_caa
    from public.table_orders o
   where o.status = 'cancelled' and o.accepted_at is not null
     and o.cancelled_at >= v_from and o.cancelled_at < v_to;

  select count(*) filter (where s.outcome = 'paid')::integer                          as paid,
         coalesce(sum(s.total_paisa) filter (where s.outcome = 'paid'), 0)::bigint     as paid_total,
         count(*) filter (where s.outcome = 'void')::integer                          as voided,
         count(*) filter (where s.outcome = 'expired')::integer                       as expired,
         coalesce(sum(s.total_paisa) filter (where s.outcome = 'expired'), 0)::bigint  as expired_total
    into q
    from public.table_sessions s
   where s.status = 'closed' and s.closed_at >= v_from and s.closed_at < v_to;

  with lines as (
    select i.menu_item_ref, i.name_snapshot, i.qty, i.line_total_paisa, o.created_at, i.line_no
      from public.table_order_items i
      join public.table_orders o on o.id = i.order_id
      join public.table_sessions s on s.id = o.session_id
     where o.created_at >= v_from and o.created_at < v_to
       and o.status <> 'cancelled'
       and (s.status = 'open' or s.outcome = 'paid')
  ),
  items as (
    select l.menu_item_ref as item_id,
           (array_agg(l.name_snapshot order by l.created_at desc, l.line_no desc))[1] as name,
           sum(l.qty)::bigint as qty,
           sum(l.line_total_paisa)::bigint as revenue
      from lines l
     group by l.menu_item_ref
  ),
  ranked as (
    select it.*, row_number() over (order by it.qty desc, it.revenue desc, it.name, it.item_id) as rn from items it
  )
  select coalesce(jsonb_agg(jsonb_build_object('menuItemId', x.item_id, 'name', x.name, 'qty', x.qty,
                                               'revenuePaisa', x.revenue) order by x.rn), '[]'::jsonb)
    into v_top
    from ranked x
   where x.rn <= 10;

  select jsonb_agg(jsonb_build_object('hour', h.h, 'rounds', coalesce(c.n, 0)) order by h.h)
    into v_hour
    from generate_series(0, 23) as h(h)
    left join (select extract(hour from (o.created_at at time zone 'Asia/Kathmandu'))::integer as hr,
                      count(*)::integer as n
                 from public.table_orders o
                where o.created_at >= v_from and o.created_at < v_to and o.status <> 'cancelled'
                group by 1) c on c.hr = h.h;

  return jsonb_build_object(
    'rounds',                 r.rounds,
    'cancelledRounds',        r.cancelled,
    'cancelledAfterAccept',   v_caa,
    'paidTables',             q.paid,
    'paidTotalPaisa',         q.paid_total,
    'voidedTables',           q.voided,
    'expiredTables',          q.expired,
    'expiredWithOrdersPaisa', q.expired_total,
    'topItems',               v_top,
    'byHour',                 v_hour);
end;
$$;

-- ===========================================================================
-- Owner alerts (2.2.0)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- record_admin_alert (service role; no actor): the backend records the failed-join threshold alert (9.3). ONLY kind
-- table_join_fail (any other: VALIDATION kind). p_data: { tableNumber: 1..99 | null (all tables), failures: 1.. }.
-- Other keys are dropped (never a code). Returns the alert id.
-- ---------------------------------------------------------------------------
create or replace function public.record_admin_alert(p_kind text, p_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table integer;
  v_fail  integer;
  v_id    uuid;
begin
  if p_kind is distinct from 'table_join_fail' then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('kind', jsonb_build_array('only table_join_fail')));
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object'
     or not (coalesce(jsonb_typeof(p_data -> 'tableNumber'), 'null') = 'null'
             or (jsonb_typeof(p_data -> 'tableNumber') = 'number' and (p_data ->> 'tableNumber') ~ '^[0-9]{1,2}$'
                 and (p_data ->> 'tableNumber')::integer between 1 and 99))
     or not coalesce(jsonb_typeof(p_data -> 'failures') = 'number' and (p_data ->> 'failures') ~ '^[0-9]{1,9}$'
                     and (p_data ->> 'failures')::integer >= 1, false) then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('data',
      jsonb_build_array('{ tableNumber: 1..99 or null, failures: 1 or more }')));
  end if;
  v_table := (p_data ->> 'tableNumber')::integer;
  v_fail  := (p_data ->> 'failures')::integer;

  perform set_config('app.table_write', 'on', true);
  v_id := private.raise_admin_alert('table_join_fail',
            jsonb_build_object('tableNumber', v_table, 'failures', v_fail), null);
  perform set_config('app.table_write', 'off', true);
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- mark_admin_alerts_read (OWNER): p_all = true marks every unread alert; otherwise p_ids (1..100). Sets read_at /
-- read_by on unread rows only. Returns the number of unread alerts left.
-- ---------------------------------------------------------------------------
create or replace function public.mark_admin_alerts_read(p_ids uuid[], p_all boolean, p_actor uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.require_actor_role(p_actor) <> 'owner' then
    perform private.raise_order_error('FORBIDDEN', null, 'Only the owner can see alerts.');
  end if;
  if not coalesce(p_all, false) and (p_ids is null or cardinality(p_ids) not between 1 and 100) then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('ids', jsonb_build_array('1 to 100 alert ids')));
  end if;
  perform set_config('app.table_write', 'on', true);
  update public.admin_alerts
     set read_at = now(), read_by = p_actor
   where read_at is null
     and (coalesce(p_all, false) or id = any (p_ids));
  perform set_config('app.table_write', 'off', true);
  return (select count(*)::integer from public.admin_alerts a where a.read_at is null);
end;
$$;

-- ---------------------------------------------------------------------------
-- claim_alert_deliveries (service role; the backend notifier, per enabled channel). Claims, oldest first, at most
-- p_limit (1..20) alerts created in the last 24 h that have no delivery row for the channel, or a 'failed' row with
-- attempts < 3, or a 'sending' row claimed more than 5 minutes ago with attempts < 3. FOR UPDATE SKIP LOCKED, so two
-- parallel callers never get the same alert. Sets them to 'sending' (attempts + 1 on retries) and returns
-- {alertId, kind, text, createdAt}. Stale 'sending' rows that cannot be retried (3 attempts, or the alert is older
-- than 24 h) are marked 'failed' (last_error 'expired'). Alerts older than 24 h are never claimed.
-- ---------------------------------------------------------------------------
create or replace function public.claim_alert_deliveries(p_channel text, p_limit integer)
returns setof jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_channel is null or p_channel not in ('whatsapp') then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('channel', jsonb_build_array('whatsapp')));
  end if;
  if p_limit is null or p_limit not between 1 and 20 then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('limit', jsonb_build_array('1 to 20')));
  end if;

  perform set_config('app.table_write', 'on', true);

  update public.alert_deliveries d
     set status = 'failed', last_error = coalesce(d.last_error, 'expired')
    from public.admin_alerts a
   where a.id = d.alert_id and d.channel = p_channel and d.status = 'sending'
     and d.claimed_at < now() - interval '5 minutes'
     and (d.attempts >= 3 or a.created_at < now() - interval '24 hours');

  return query
    with cand as (
      select a.id, a.kind, a.text, a.created_at
        from public.admin_alerts a
        left join public.alert_deliveries d on d.alert_id = a.id and d.channel = p_channel
       where a.created_at >= now() - interval '24 hours'
         and (d.alert_id is null
              or (d.status = 'failed' and d.attempts < 3)
              or (d.status = 'sending' and d.claimed_at < now() - interval '5 minutes' and d.attempts < 3))
       order by a.created_at, a.id
       limit p_limit
         for update of a skip locked
    ),
    up as (
      insert into public.alert_deliveries as ad (alert_id, channel, status, attempts, claimed_at)
      select c.id, p_channel, 'sending', 1, now() from cand c
      on conflict (alert_id, channel) do update
         set status = 'sending', attempts = ad.attempts + 1, claimed_at = now(), last_error = null
      returning ad.alert_id
    )
    select jsonb_build_object('alertId', c.id, 'kind', c.kind, 'text', c.text, 'createdAt', c.created_at)
      from cand c join up on up.alert_id = c.id
     order by c.created_at, c.id;

  perform set_config('app.table_write', 'off', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- finish_alert_delivery (service role; the notifier after a send). p_ok -> 'sent'; else 'failed' with p_error (HTTP
-- status / provider error code only; trimmed to 100 characters, control characters removed). Only a 'sending' row
-- changes; a row already finished is left alone. No row at all: NOT_FOUND.
-- ---------------------------------------------------------------------------
create or replace function public.finish_alert_delivery(p_alert_id uuid, p_channel text, p_ok boolean, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_ok is null then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('ok', jsonb_build_array('true or false')));
  end if;
  if not exists (select 1 from public.alert_deliveries d where d.alert_id = p_alert_id and d.channel = p_channel) then
    perform private.raise_order_error('NOT_FOUND');
  end if;
  perform set_config('app.table_write', 'on', true);
  update public.alert_deliveries
     set status     = case when p_ok then 'sent' else 'failed' end,
         last_error = case when p_ok then null
                           else left(nullif(btrim(regexp_replace(coalesce(p_error, ''), '[\x01-\x1F\x7F]', ' ', 'g')), ''), 100) end
   where alert_id = p_alert_id and channel = p_channel and status = 'sending';
  perform set_config('app.table_write', 'off', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- purge_personal_data (existing daily job, 20261019000010): unchanged, plus 2.2.0: admin_alerts older than 180 days
-- (ESTIMATE) are deleted, their delivery rows cascade. The result gains `alertsDeleted` (additive).
-- ---------------------------------------------------------------------------
create or replace function public.purge_personal_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_days    integer;
  v_orders  integer;
  v_blocks  integer;
  v_rl      integer;
  v_alerts  integer;
begin
  select retention_days into v_days from public.order_rules limit 1;
  v_days := coalesce(v_days, 90);

  update public.orders
     set customer_name = null, customer_phone = null, customer_email = null,
         address = null, landmark = null, area = null, notes = null, ip_hash = null,
         personal_data_purged_at = now()
   where personal_data_purged_at is null
     and status in ('completed', 'cancelled')
     and coalesce(completed_at, cancelled_at) < now() - make_interval(days => v_days);
  get diagnostics v_orders = row_count;

  delete from public.blocked_contacts where expires_at < now();
  get diagnostics v_blocks = row_count;

  delete from public.rate_limits where window_start < now() - interval '2 days';
  get diagnostics v_rl = row_count;

  perform set_config('app.table_write', 'on', true);
  delete from public.admin_alerts where created_at < now() - interval '180 days';
  get diagnostics v_alerts = row_count;
  perform set_config('app.table_write', 'off', true);

  return jsonb_build_object('ordersPurged', v_orders, 'blocksExpired', v_blocks, 'rateLimitRowsDeleted', v_rl,
                            'alertsDeleted', v_alerts, 'retentionDays', v_days, 'ranAt', now());
end;
$$;

-- ===========================================================================
-- Privileges (SEC-007): service role only. Nothing here is executable by anon, authenticated or PUBLIC.
-- ===========================================================================
revoke all on function public.list_cafe_tables(uuid)                                     from public, anon, authenticated;
revoke all on function public.save_cafe_tables(jsonb, uuid)                              from public, anon, authenticated;
revoke all on function public.set_table_ordering(text, uuid)                             from public, anon, authenticated;
revoke all on function public.open_table_session(uuid, uuid)                             from public, anon, authenticated;
revoke all on function public.rotate_table_code(uuid, uuid)                              from public, anon, authenticated;
revoke all on function public.set_table_orders_locked(uuid, boolean, uuid)               from public, anon, authenticated;
revoke all on function public.join_table_session(integer, text)                          from public, anon, authenticated;
revoke all on function public.table_session_guest_view(uuid, smallint, integer)          from public, anon, authenticated;
revoke all on function public.create_table_order(uuid, smallint, uuid, jsonb, text)      from public, anon, authenticated;
revoke all on function public.transition_table_order(uuid, text, text, uuid)             from public, anon, authenticated;
revoke all on function public.close_table_session(uuid, text, text, integer, uuid)       from public, anon, authenticated;
revoke all on function public.table_board(text, uuid)                                    from public, anon, authenticated;
revoke all on function public.auto_close_stale_table_sessions()                          from public, anon, authenticated;
revoke all on function public.stats_table_orders(date, date, uuid)                       from public, anon, authenticated;
revoke all on function public.record_admin_alert(text, jsonb)                            from public, anon, authenticated;
revoke all on function public.mark_admin_alerts_read(uuid[], boolean, uuid)              from public, anon, authenticated;
revoke all on function public.claim_alert_deliveries(text, integer)                      from public, anon, authenticated;
revoke all on function public.finish_alert_delivery(uuid, text, boolean, text)           from public, anon, authenticated;
revoke all on function public.purge_personal_data()                                      from public, anon, authenticated;

grant execute on function public.list_cafe_tables(uuid)                                  to service_role;
grant execute on function public.save_cafe_tables(jsonb, uuid)                           to service_role;
grant execute on function public.set_table_ordering(text, uuid)                          to service_role;
grant execute on function public.open_table_session(uuid, uuid)                          to service_role;
grant execute on function public.rotate_table_code(uuid, uuid)                           to service_role;
grant execute on function public.set_table_orders_locked(uuid, boolean, uuid)            to service_role;
grant execute on function public.join_table_session(integer, text)                       to service_role;
grant execute on function public.table_session_guest_view(uuid, smallint, integer)       to service_role;
grant execute on function public.create_table_order(uuid, smallint, uuid, jsonb, text)   to service_role;
grant execute on function public.transition_table_order(uuid, text, text, uuid)          to service_role;
grant execute on function public.close_table_session(uuid, text, text, integer, uuid)    to service_role;
grant execute on function public.table_board(text, uuid)                                 to service_role;
grant execute on function public.auto_close_stale_table_sessions()                       to service_role;
grant execute on function public.stats_table_orders(date, date, uuid)                    to service_role;
grant execute on function public.record_admin_alert(text, jsonb)                         to service_role;
grant execute on function public.mark_admin_alerts_read(uuid[], boolean, uuid)           to service_role;
grant execute on function public.claim_alert_deliveries(text, integer)                   to service_role;
grant execute on function public.finish_alert_delivery(uuid, text, boolean, text)        to service_role;
grant execute on function public.purge_personal_data()                                   to service_role;

-- ===========================================================================
-- pg_cron: expire abandoned sessions every 15 minutes. Guarded exactly like 20261021000004: if pg_cron is missing
-- the migration still succeeds with a NOTICE, and devops calls rpc('auto_close_stale_table_sessions') with the
-- service key every 15 minutes from a scheduled job instead (supabase/README.md, "Table ordering").
-- cron.schedule() with an existing job name updates that job, so re-running is safe.
-- ===========================================================================
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('cafe-table-sessions-expire', '*/15 * * * *',
                          'select public.auto_close_stale_table_sessions()');
  elsif exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('cafe-table-sessions-expire', '*/15 * * * *',
                          'select public.auto_close_stale_table_sessions()');
  else
    raise notice 'pg_cron is not available: call public.auto_close_stale_table_sessions() every 15 minutes some other way (see supabase/README.md)';
  end if;
exception when others then
  raise notice 'pg_cron schedule skipped (%): call public.auto_close_stale_table_sessions() some other way', sqlerrm;
end
$$;
