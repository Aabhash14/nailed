-- 20261025000002_stats.sql
-- Owner statistics dashboard: read-only RPCs over the food sales log (daily_sales*) and the merch shop (orders,
-- order_items, product_variants). Every function:
--   * is SECURITY DEFINER with search_path = '', returns ONE jsonb object (camelCase keys, money keys end in "Paisa",
--     shapes documented in supabase/README.md "Statistics" and pinned by tests/database/daily_sales_stats.test.sql);
--   * takes p_actor (the verified profiles.id, last argument) and raises FORBIDDEN unless that profile is the OWNER;
--   * is executable by service_role ONLY (SEC-007: revoke from public/anon/authenticated, explicit grant). The backend
--     calls it with the service-role client after requireRole('owner'), like set_order_status / block_contact. The
--     authenticated allow-list pinned in rls.test.sql stays at the four role helpers;
--   * works in Kathmandu time (Asia/Kathmandu, UTC+05:45): p_from / p_to are Kathmandu calendar dates, BOTH
--     inclusive; an order belongs to the Kathmandu date of its timestamp (00:00 +05:45 = 18:15 UTC the day before).
--
-- Definitions (also in README):
--   food revenue      sum of daily_sales_lines.line_total_paisa (qty x price snapshot) of days in range.
--                     The optional till total is reported separately (foodTillTotalPaisa), never mixed in.
--   merch revenue     sum of orders.total_paisa of COMPLETED orders whose completed_at falls in range (cash is collected
--                     at completion; includes delivery fee and VAT as charged). merchOrders = count of those orders.
--   merch placed      orders by created_at (any status): timeseries merchOrdersPlaced, heatmap, cancellations.
--   changePct         round((value - compare) / compare x 100, 1); null when there is no compare range or compare = 0.
--   week buckets      start on SUNDAY (Nepal's working week is Sunday to Friday). ASSUMPTION, see data-model.md.
--   weekday numbers   0 = Sunday ... 6 = Saturday (Postgres dow).
-- Ranges: p_from and p_to required, p_from <= p_to, at most 1,096 days (3 years) -> else VALIDATION.

-- ---------------------------------------------------------------------------
-- Private helpers
-- ---------------------------------------------------------------------------
create or replace function private.stats_require_owner(p_actor uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_actor is null or not exists (select 1 from public.profiles p where p.id = p_actor and p.role = 'owner') then
    perform private.raise_order_error('FORBIDDEN', null, 'Statistics are for the owner only.');
  end if;
end;
$$;

create or replace function private.stats_check_range(p_from date, p_to date, p_prefix text default '')
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_from is null or p_to is null then
    perform private.raise_order_error('VALIDATION',
      jsonb_build_object(p_prefix || 'range', jsonb_build_array('from and to are required')));
  end if;
  if p_from > p_to then
    perform private.raise_order_error('VALIDATION',
      jsonb_build_object(p_prefix || 'range', jsonb_build_array('from must be on or before to')));
  end if;
  if p_to - p_from >= 1096 then
    perform private.raise_order_error('VALIDATION',
      jsonb_build_object(p_prefix || 'range', jsonb_build_array('at most 1096 days')));
  end if;
end;
$$;

create or replace function private.stats_pct_change(p_value numeric, p_compare numeric)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case when p_value is null or p_compare is null or p_compare = 0 then null
              else round((p_value - p_compare) * 100.0 / p_compare, 1) end
$$;

-- {value, compare, changePct}
create or replace function private.stats_metric(p_value numeric, p_compare numeric, p_has_compare boolean)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
           'value',     p_value,
           'compare',   case when p_has_compare then p_compare end,
           'changePct', case when p_has_compare then private.stats_pct_change(p_value, p_compare) end)
$$;

-- Food totals of a date range (inclusive).
create or replace function private.stats_food_totals(p_from date, p_to date)
returns table (revenue_paisa bigint, items_sold bigint, days_logged integer, till_total_paisa bigint, till_days integer)
language sql
stable
set search_path = ''
as $$
  select coalesce((select sum(l.line_total_paisa)
                     from public.daily_sales d join public.daily_sales_lines l on l.daily_sales_id = d.id
                    where d.business_date between p_from and p_to), 0)::bigint,
         coalesce((select sum(l.qty)
                     from public.daily_sales d join public.daily_sales_lines l on l.daily_sales_id = d.id
                    where d.business_date between p_from and p_to), 0)::bigint,
         (select count(*) from public.daily_sales d where d.business_date between p_from and p_to)::integer,
         coalesce((select sum(d.till_total_paisa) from public.daily_sales d
                    where d.business_date between p_from and p_to), 0)::bigint,
         (select count(*) from public.daily_sales d
           where d.business_date between p_from and p_to and d.till_total_paisa is not null)::integer
$$;

-- Completed merch orders of a date range (by completed_at, Kathmandu dates, inclusive).
create or replace function private.stats_merch_totals(p_from date, p_to date)
returns table (revenue_paisa bigint, orders integer)
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(o.total_paisa), 0)::bigint, count(*)::integer
    from public.orders o
   where o.status = 'completed'
     and o.completed_at >= private.ktm_day_start(p_from)
     and o.completed_at <  private.ktm_day_start(p_to + 1)
$$;

revoke all on function private.stats_require_owner(uuid), private.stats_check_range(date, date, text),
                       private.stats_pct_change(numeric, numeric), private.stats_metric(numeric, numeric, boolean),
                       private.stats_food_totals(date, date), private.stats_merch_totals(date, date)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- stats_overview: headline numbers for a range, with an optional compare range (both ends or neither).
-- ---------------------------------------------------------------------------
create or replace function public.stats_overview(
  p_from      date,
  p_to        date,
  p_cmp_from  date default null,
  p_cmp_to    date default null,
  p_actor     uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_has_cmp boolean := p_cmp_from is not null or p_cmp_to is not null;
  f   record;  m   record;
  fc  record;  mc  record;
  v_avg     numeric;
  v_avg_cmp numeric;
begin
  perform private.stats_require_owner(p_actor);
  perform private.stats_check_range(p_from, p_to);
  if v_has_cmp then
    perform private.stats_check_range(p_cmp_from, p_cmp_to, 'compare.');
  end if;

  select * into f from private.stats_food_totals(p_from, p_to);
  select * into m from private.stats_merch_totals(p_from, p_to);
  v_avg := case when m.orders > 0 then round(m.revenue_paisa::numeric / m.orders) end;

  if v_has_cmp then
    select * into fc from private.stats_food_totals(p_cmp_from, p_cmp_to);
    select * into mc from private.stats_merch_totals(p_cmp_from, p_cmp_to);
    v_avg_cmp := case when mc.orders > 0 then round(mc.revenue_paisa::numeric / mc.orders) end;
  else
    select null::bigint as revenue_paisa, null::bigint as items_sold, null::integer as days_logged,
           null::bigint as till_total_paisa, null::integer as till_days into fc;
    select null::bigint as revenue_paisa, null::integer as orders into mc;
  end if;

  return jsonb_build_object(
    'from',               p_from,
    'to',                 p_to,
    'compareFrom',        p_cmp_from,
    'compareTo',          p_cmp_to,
    'timezone',           'Asia/Kathmandu',
    'foodRevenuePaisa',   private.stats_metric(f.revenue_paisa, fc.revenue_paisa, v_has_cmp),
    'merchRevenuePaisa',  private.stats_metric(m.revenue_paisa, mc.revenue_paisa, v_has_cmp),
    'totalRevenuePaisa',  private.stats_metric(f.revenue_paisa + m.revenue_paisa,
                                               fc.revenue_paisa + mc.revenue_paisa, v_has_cmp),
    'merchOrders',        private.stats_metric(m.orders, mc.orders, v_has_cmp),
    'avgMerchOrderPaisa', private.stats_metric(v_avg, v_avg_cmp, v_has_cmp),
    'foodItemsSold',      private.stats_metric(f.items_sold, fc.items_sold, v_has_cmp),
    'foodDaysLogged',     private.stats_metric(f.days_logged, fc.days_logged, v_has_cmp),
    'foodTillTotalPaisa', private.stats_metric(f.till_total_paisa, fc.till_total_paisa, v_has_cmp),
    'foodTillDays',       private.stats_metric(f.till_days, fc.till_days, v_has_cmp));
end;
$$;

-- ---------------------------------------------------------------------------
-- stats_timeseries: per bucket (day | week starting Sunday | month), every bucket present (zeros included).
-- ---------------------------------------------------------------------------
create or replace function public.stats_timeseries(
  p_from   date,
  p_to     date,
  p_grain  text default 'day',
  p_actor  uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_buckets jsonb;
begin
  perform private.stats_require_owner(p_actor);
  perform private.stats_check_range(p_from, p_to);
  if p_grain is null or p_grain not in ('day', 'week', 'month') then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('grain', jsonb_build_array('day, week or month')));
  end if;

  with days as (
    select (p_from + g)::date as d from generate_series(0, p_to - p_from) as g
  ),
  food as (
    select d.business_date as d, sum(l.line_total_paisa)::bigint as rev, sum(l.qty)::bigint as qty
      from public.daily_sales d join public.daily_sales_lines l on l.daily_sales_id = d.id
     where d.business_date between p_from and p_to
     group by d.business_date
  ),
  done as (
    select private.ktm_date(o.completed_at) as d, sum(o.total_paisa)::bigint as rev, count(*)::bigint as n
      from public.orders o
     where o.status = 'completed'
       and o.completed_at >= private.ktm_day_start(p_from) and o.completed_at < private.ktm_day_start(p_to + 1)
     group by 1
  ),
  placed as (
    select private.ktm_date(o.created_at) as d, count(*)::bigint as n
      from public.orders o
     where o.created_at >= private.ktm_day_start(p_from) and o.created_at < private.ktm_day_start(p_to + 1)
     group by 1
  ),
  per_day as (
    select days.d,
           case p_grain
             when 'day'   then days.d
             when 'week'  then days.d - extract(dow from days.d)::integer
             else date_trunc('month', days.d)::date
           end as b,
           coalesce(food.rev, 0) as food_rev, coalesce(food.qty, 0) as food_qty,
           coalesce(done.rev, 0) as merch_rev, coalesce(done.n, 0) as merch_n, coalesce(placed.n, 0) as placed_n
      from days
      left join food   on food.d   = days.d
      left join done   on done.d   = days.d
      left join placed on placed.d = days.d
  ),
  buckets as (
    select b,
           min(d) as s, max(d) as e,
           case p_grain when 'day' then b when 'week' then b + 6 else (b + interval '1 month')::date - 1 end as natural_end,
           sum(food_rev)::bigint as food_rev, sum(food_qty)::bigint as food_qty,
           sum(merch_rev)::bigint as merch_rev, sum(merch_n)::bigint as merch_n, sum(placed_n)::bigint as placed_n
      from per_day
     group by b
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'bucket',            b,
           'start',             s,
           'end',               e,
           'partial',           (s <> b or e <> natural_end),
           'foodRevenuePaisa',  food_rev,
           'foodItemsSold',     food_qty,
           'merchRevenuePaisa', merch_rev,
           'merchOrders',       merch_n,
           'merchOrdersPlaced', placed_n,
           'totalRevenuePaisa', food_rev + merch_rev) order by b), '[]'::jsonb)
    into v_buckets
    from buckets;

  return jsonb_build_object('from', p_from, 'to', p_to, 'grain', p_grain, 'weekStartsOn', 'sunday',
                            'timezone', 'Asia/Kathmandu', 'buckets', v_buckets);
end;
$$;

-- ---------------------------------------------------------------------------
-- stats_top_food: top menu items by qty and by revenue (variants summed into their item). p_limit 1..100.
-- Items are identified by the ORIGINAL id (menu_item_ref), so a deleted item still shows, by its last logged name.
-- ---------------------------------------------------------------------------
create or replace function public.stats_top_food(
  p_from   date,
  p_to     date,
  p_limit  integer default 10,
  p_actor  uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_by_qty jsonb;
  v_by_rev jsonb;
begin
  perform private.stats_require_owner(p_actor);
  perform private.stats_check_range(p_from, p_to);
  if p_limit is null or p_limit not between 1 and 100 then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('limit', jsonb_build_array('1 to 100')));
  end if;

  with items as (
    select l.menu_item_ref as item_id,
           coalesce(mi.name, (array_agg(l.name_snapshot order by d.business_date desc))[1]) as name,
           (mi.id is null or mi.deleted_at is not null) as is_deleted,
           sum(l.qty)::bigint as qty,
           sum(l.line_total_paisa)::bigint as revenue
      from public.daily_sales d
      join public.daily_sales_lines l on l.daily_sales_id = d.id
      left join public.menu_items mi on mi.id = l.menu_item_ref
     where d.business_date between p_from and p_to
     group by l.menu_item_ref, mi.id, mi.name, mi.deleted_at
  ),
  q as (
    select t.*, row_number() over (order by t.qty desc, t.revenue desc, t.name, t.item_id) as rn
      from items t where t.qty > 0
  ),
  r as (
    select t.*, row_number() over (order by t.revenue desc, t.qty desc, t.name, t.item_id) as rn
      from items t where t.revenue > 0
  )
  select (select coalesce(jsonb_agg(jsonb_build_object('rank', q.rn, 'menuItemId', q.item_id, 'name', q.name,
                                                       'isDeleted', q.is_deleted, 'qty', q.qty,
                                                       'revenuePaisa', q.revenue) order by q.rn), '[]'::jsonb)
            from q where q.rn <= p_limit),
         (select coalesce(jsonb_agg(jsonb_build_object('rank', r.rn, 'menuItemId', r.item_id, 'name', r.name,
                                                       'isDeleted', r.is_deleted, 'qty', r.qty,
                                                       'revenuePaisa', r.revenue) order by r.rn), '[]'::jsonb)
            from r where r.rn <= p_limit)
    into v_by_qty, v_by_rev;

  return jsonb_build_object('from', p_from, 'to', p_to, 'limit', p_limit, 'byQty', v_by_qty, 'byRevenue', v_by_rev);
end;
$$;

-- ---------------------------------------------------------------------------
-- stats_best_food_per_day: for every date in the range, the item sold most (qty; ties: revenue, then name).
-- Days without a log: logged = false, item fields null. Logged days with only qty 0: item fields null, qty 0.
-- ---------------------------------------------------------------------------
create or replace function public.stats_best_food_per_day(
  p_from   date,
  p_to     date,
  p_actor  uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_days jsonb;
begin
  perform private.stats_require_owner(p_actor);
  perform private.stats_check_range(p_from, p_to);

  with days as (
    select (p_from + g)::date as d from generate_series(0, p_to - p_from) as g
  ),
  per_item as (
    select d.business_date as d, l.menu_item_ref as item_id,
           (array_agg(l.name_snapshot))[1] as snap_name,
           sum(l.qty)::bigint as qty, sum(l.line_total_paisa)::bigint as rev
      from public.daily_sales d join public.daily_sales_lines l on l.daily_sales_id = d.id
     where d.business_date between p_from and p_to
     group by d.business_date, l.menu_item_ref
  ),
  ranked as (
    select p.*, coalesce(mi.name, p.snap_name) as name,
           row_number() over (partition by p.d order by p.qty desc, p.rev desc, coalesce(mi.name, p.snap_name), p.item_id) as rn
      from per_item p left join public.menu_items mi on mi.id = p.item_id
     where p.qty > 0
  ),
  totals as (
    select d.business_date as d,
           coalesce(sum(l.qty), 0)::bigint as qty, coalesce(sum(l.line_total_paisa), 0)::bigint as rev
      from public.daily_sales d left join public.daily_sales_lines l on l.daily_sales_id = d.id
     where d.business_date between p_from and p_to
     group by d.business_date
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'date',              days.d,
           'logged',            totals.d is not null,
           'menuItemId',        r.item_id,
           'name',              r.name,
           'qty',               case when totals.d is null then null else coalesce(r.qty, 0) end,
           'revenuePaisa',      case when totals.d is null then null else coalesce(r.rev, 0) end,
           'dayItemsSold',      totals.qty,
           'dayFoodRevenuePaisa', totals.rev) order by days.d), '[]'::jsonb)
    into v_days
    from days
    left join totals on totals.d = days.d
    left join ranked r on r.d = days.d and r.rn = 1;

  return jsonb_build_object('from', p_from, 'to', p_to, 'days', v_days);
end;
$$;

-- ---------------------------------------------------------------------------
-- stats_top_merch: units sold in COMPLETED orders (completed_at in range), by product and by variant (size/colour).
-- revenuePaisa here = unit_price_paisa x qty of the order lines (item revenue: no delivery fee). p_limit 1..100.
-- ---------------------------------------------------------------------------
create or replace function public.stats_top_merch(
  p_from   date,
  p_to     date,
  p_limit  integer default 10,
  p_actor  uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_by_product jsonb;
  v_by_variant jsonb;
begin
  perform private.stats_require_owner(p_actor);
  perform private.stats_check_range(p_from, p_to);
  if p_limit is null or p_limit not between 1 and 100 then
    perform private.raise_order_error('VALIDATION', jsonb_build_object('limit', jsonb_build_array('1 to 100')));
  end if;

  with lines as (
    select pv.product_id,
           coalesce(p.name, i.name) as product_name,
           i.product_variant_id as variant_id,
           pv.size,
           pv.colour,
           pv.size_rank,
           i.qty::bigint as qty,
           i.unit_price_paisa::bigint * i.qty as revenue
      from public.orders o
      join public.order_items i on i.order_id = o.id
      join public.product_variants pv on pv.id = i.product_variant_id
      left join public.products p on p.id = pv.product_id
     where o.status = 'completed'
       and o.completed_at >= private.ktm_day_start(p_from) and o.completed_at < private.ktm_day_start(p_to + 1)
  ),
  by_product as (
    select product_id, max(product_name) as name, sum(qty)::bigint as qty, sum(revenue)::bigint as revenue,
           row_number() over (order by sum(qty) desc, sum(revenue) desc, max(product_name), product_id) as rn
      from lines group by product_id
  ),
  by_variant as (
    select variant_id, product_id, max(product_name) as product_name, size, colour,
           sum(qty)::bigint as qty, sum(revenue)::bigint as revenue,
           row_number() over (order by sum(qty) desc, sum(revenue) desc, max(product_name), colour, size_rank, size,
                                       variant_id) as rn
      from lines group by variant_id, product_id, size, colour, size_rank
  )
  select (select coalesce(jsonb_agg(jsonb_build_object('rank', b.rn, 'productId', b.product_id, 'name', b.name,
                                                       'qty', b.qty, 'revenuePaisa', b.revenue) order by b.rn), '[]'::jsonb)
            from by_product b where b.rn <= p_limit),
         (select coalesce(jsonb_agg(jsonb_build_object('rank', v.rn, 'variantId', v.variant_id, 'productId', v.product_id,
                                                       'productName', v.product_name, 'size', v.size, 'colour', v.colour,
                                                       'label', v.size || ' / ' || v.colour,
                                                       'qty', v.qty, 'revenuePaisa', v.revenue) order by v.rn), '[]'::jsonb)
            from by_variant v where v.rn <= p_limit)
    into v_by_product, v_by_variant;

  return jsonb_build_object('from', p_from, 'to', p_to, 'limit', p_limit,
                            'byProduct', v_by_product, 'byVariant', v_by_variant);
end;
$$;

-- ---------------------------------------------------------------------------
-- stats_busy_heatmap: merch orders PLACED (created_at, any status) by Kathmandu weekday x hour: all 168 cells, zeros
-- included. Food logs are daily, so food is per weekday only (7 rows).
-- ---------------------------------------------------------------------------
create or replace function public.stats_busy_heatmap(
  p_from   date,
  p_to     date,
  p_actor  uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_merch jsonb;
  v_food  jsonb;
begin
  perform private.stats_require_owner(p_actor);
  perform private.stats_check_range(p_from, p_to);

  with cells as (
    select w, h from generate_series(0, 6) as w, generate_series(0, 23) as h
  ),
  o as (
    select extract(dow  from (o.created_at at time zone 'Asia/Kathmandu'))::integer as w,
           extract(hour from (o.created_at at time zone 'Asia/Kathmandu'))::integer as h,
           count(*)::bigint as n,
           count(*) filter (where o.status = 'completed')::bigint as n_done
      from public.orders o
     where o.created_at >= private.ktm_day_start(p_from) and o.created_at < private.ktm_day_start(p_to + 1)
     group by 1, 2
  )
  select jsonb_agg(jsonb_build_object('weekday', cells.w, 'hour', cells.h,
                                      'orders', coalesce(o.n, 0), 'completedOrders', coalesce(o.n_done, 0))
                   order by cells.w, cells.h)
    into v_merch
    from cells left join o on o.w = cells.w and o.h = cells.h;

  with wd as (
    select generate_series(0, 6) as w
  ),
  per_day as (
    select extract(dow from d.business_date)::integer as w,
           coalesce(sum(l.qty), 0)::bigint as qty, coalesce(sum(l.line_total_paisa), 0)::bigint as rev
      from public.daily_sales d left join public.daily_sales_lines l on l.daily_sales_id = d.id
     where d.business_date between p_from and p_to
     group by d.business_date
  ),
  f as (
    select w, count(*)::bigint as days, sum(qty)::bigint as qty, sum(rev)::bigint as rev from per_day group by w
  )
  select jsonb_agg(jsonb_build_object(
           'weekday',                wd.w,
           'daysLogged',             coalesce(f.days, 0),
           'itemsSold',              coalesce(f.qty, 0),
           'revenuePaisa',           coalesce(f.rev, 0),
           'avgItemsSoldPerDay',     case when f.days > 0 then round(f.qty::numeric / f.days, 1) end,
           'avgRevenuePaisaPerDay',  case when f.days > 0 then round(f.rev::numeric / f.days) end)
         order by wd.w)
    into v_food
    from wd left join f on f.w = wd.w;

  return jsonb_build_object('from', p_from, 'to', p_to, 'timezone', 'Asia/Kathmandu',
                            'weekdays', '0 = Sunday ... 6 = Saturday',
                            'merch', v_merch, 'foodByWeekday', v_food);
end;
$$;

-- ---------------------------------------------------------------------------
-- stats_cancellations: orders PLACED in the range (created_at) by outcome, cancel rate, and cancel reasons (all 8
-- keys always present). ORDER_REFUSED attempts are NOT stored anywhere in the database: create_order raises and its
-- transaction rolls back; the Worker only writes an `order_refused` security-log line (src/lib/log.ts). So
-- refusedAttempts.recorded = false and count = null until something records them.
-- ---------------------------------------------------------------------------
create or replace function public.stats_cancellations(
  p_from   date,
  p_to     date,
  p_actor  uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r         record;
  v_reasons jsonb;
begin
  perform private.stats_require_owner(p_actor);
  perform private.stats_check_range(p_from, p_to);

  select count(*)::bigint as placed,
         count(*) filter (where o.status = 'completed')::bigint as completed,
         count(*) filter (where o.status = 'cancelled')::bigint as cancelled,
         count(*) filter (where o.status in ('placed', 'confirmed', 'out_for_delivery', 'ready_for_pickup'))::bigint as open
    into r
    from public.orders o
   where o.created_at >= private.ktm_day_start(p_from) and o.created_at < private.ktm_day_start(p_to + 1);

  select jsonb_object_agg(k.reason, coalesce(c.n, 0))
    into v_reasons
    from unnest(array['customer_request', 'auto_unconfirmed', 'no_show', 'refused', 'unreachable',
                      'out_of_stock', 'fake', 'other']) as k(reason)
    left join (select o.cancel_reason, count(*)::bigint as n
                 from public.orders o
                where o.status = 'cancelled'
                  and o.created_at >= private.ktm_day_start(p_from) and o.created_at < private.ktm_day_start(p_to + 1)
                group by o.cancel_reason) c on c.cancel_reason = k.reason;

  return jsonb_build_object(
    'from',              p_from,
    'to',                p_to,
    'ordersPlaced',      r.placed,
    'completed',         r.completed,
    'cancelled',         r.cancelled,
    'open',              r.open,
    'cancelRatePct',     case when r.placed > 0 then round(r.cancelled * 100.0 / r.placed, 1) end,
    'completionRatePct', case when r.placed > 0 then round(r.completed * 100.0 / r.placed, 1) end,
    'byReason',          v_reasons,
    'refusedAttempts',   jsonb_build_object(
                           'recorded', false,
                           'count',    null,
                           'note',     'ORDER_REFUSED attempts are not stored in the database (the order is rolled back; only a Worker security-log line is written).'));
end;
$$;

-- ---------------------------------------------------------------------------
-- stats_stock_alerts: merch variants that are few_left (stock 1..3) or sold_out (0), with units sold in the last 7
-- and 30 days (rolling 7 x 24 h / 30 x 24 h before now) and days of stock left at the 30-day rate.
-- "Sold" = order lines of orders that are NOT cancelled (stock is taken at placement and given back on cancel).
-- Unpublished products are included (isPublished tells). Order: sold_out first, then fewest days left, then stock.
-- ---------------------------------------------------------------------------
create or replace function public.stats_stock_alerts(p_actor uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_items jsonb;
begin
  perform private.stats_require_owner(p_actor);

  with alerts as (
    select pv.id, pv.product_id, p.name as product_name, p.is_published, pv.size, pv.colour, pv.sku, pv.stock,
           pv.stock_state, pv.size_rank
      from public.product_variants pv
      join public.products p on p.id = pv.product_id
     where pv.stock_state in ('few_left', 'sold_out')
  ),
  sold as (
    select i.product_variant_id as id,
           coalesce(sum(i.qty) filter (where o.created_at >= now() - interval '7 days'), 0)::bigint  as s7,
           coalesce(sum(i.qty), 0)::bigint as s30
      from public.order_items i
      join public.orders o on o.id = i.order_id
     where o.status <> 'cancelled'
       and o.created_at >= now() - interval '30 days'
       and i.product_variant_id in (select a.id from alerts a)
     group by i.product_variant_id
  ),
  x as (
    select a.*, coalesce(s.s7, 0) as s7, coalesce(s.s30, 0) as s30,
           case when coalesce(s.s30, 0) > 0 then round(coalesce(s.s30, 0) / 30.0, 2) end as rate,
           case when a.stock <= 0 then 0
                when coalesce(s.s30, 0) > 0 then round(a.stock / (s.s30 / 30.0), 1)
           end as days_left
      from alerts a left join sold s on s.id = a.id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'variantId',        x.id,
           'productId',        x.product_id,
           'productName',      x.product_name,
           'isPublished',      x.is_published,
           'size',             x.size,
           'colour',           x.colour,
           'sku',              x.sku,
           'stock',            x.stock,
           'stockState',       x.stock_state,
           'sold7d',           x.s7,
           'sold30d',          x.s30,
           'dailyRate30d',     x.rate,
           'daysOfStockLeft',  x.days_left)
         order by (x.stock_state = 'sold_out') desc, x.days_left nulls last, x.stock, x.product_name,
                  x.colour, x.size_rank, x.size, x.id), '[]'::jsonb)
    into v_items
    from x;

  return jsonb_build_object('generatedAt', now(), 'fewLeftThreshold', 3, 'items', v_items);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges (SEC-007): service role only.
-- ---------------------------------------------------------------------------
revoke all on function public.stats_overview(date, date, date, date, uuid)   from public, anon, authenticated;
revoke all on function public.stats_timeseries(date, date, text, uuid)       from public, anon, authenticated;
revoke all on function public.stats_top_food(date, date, integer, uuid)      from public, anon, authenticated;
revoke all on function public.stats_best_food_per_day(date, date, uuid)      from public, anon, authenticated;
revoke all on function public.stats_top_merch(date, date, integer, uuid)     from public, anon, authenticated;
revoke all on function public.stats_busy_heatmap(date, date, uuid)           from public, anon, authenticated;
revoke all on function public.stats_cancellations(date, date, uuid)          from public, anon, authenticated;
revoke all on function public.stats_stock_alerts(uuid)                       from public, anon, authenticated;

grant execute on function public.stats_overview(date, date, date, date, uuid)   to service_role;
grant execute on function public.stats_timeseries(date, date, text, uuid)       to service_role;
grant execute on function public.stats_top_food(date, date, integer, uuid)      to service_role;
grant execute on function public.stats_best_food_per_day(date, date, uuid)      to service_role;
grant execute on function public.stats_top_merch(date, date, integer, uuid)     to service_role;
grant execute on function public.stats_busy_heatmap(date, date, uuid)           to service_role;
grant execute on function public.stats_cancellations(date, date, uuid)          to service_role;
grant execute on function public.stats_stock_alerts(uuid)                       to service_role;
