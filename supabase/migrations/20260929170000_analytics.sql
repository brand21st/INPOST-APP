create index if not exists shipments_shop_booked_idx
  on public.shipments (shop_id, booked_at);

create index if not exists shipments_shop_operational_idx
  on public.shipments (shop_id, operational_status);

create index if not exists tracking_events_shop_occurred_idx
  on public.tracking_events (shop_id, occurred_at desc);

create index if not exists orders_shop_payment_created_idx
  on public.orders (shop_id, payment_mode, shopify_created_at);

create index if not exists background_jobs_shop_created_idx
  on public.background_jobs (shop_id, created_at desc);

create or replace function public.shop_analytics(
  p_shop_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_prev_from timestamptz,
  p_prev_to timestamptz,
  p_service text,
  p_tz text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  tz text := coalesce(nullif(p_tz, ''), 'UTC');
  svc text := nullif(p_service, '');
  result jsonb;
begin
  if p_shop_id is null then
    raise exception 'shop_id is required';
  end if;

  with shop as (
    select currency, timezone
    from public.shops
    where id = p_shop_id
  ),
  order_base as (
    select
      o.*,
      coalesce(o.shopify_created_at, o.created_at) as order_at,
      s.id as shipment_id,
      s.status as shipment_status,
      s.booked_at,
      s.service_code as shipment_service,
      s.payment_mode as shipment_payment,
      s.cod_amount as shipment_cod,
      coalesce(s.service_code, settings.default_service, 'SP_INLAND_PARCEL') as attributed_service
    from public.orders o
    left join public.shipments s
      on s.shop_id = o.shop_id
      and s.order_id = o.id
      and s.status <> 'CANCELLED'
    left join public.shop_settings settings on settings.shop_id = o.shop_id
    where o.shop_id = p_shop_id
  ),
  orders_cur as (
    select * from order_base
    where order_at >= p_from and order_at < p_to
      and (svc is null or attributed_service = svc)
  ),
  orders_prev as (
    select * from order_base
    where order_at >= p_prev_from and order_at < p_prev_to
      and (svc is null or attributed_service = svc)
  ),
  ship_base as (
    select s.*
    from public.shipments s
    where s.shop_id = p_shop_id
      and (svc is null or s.service_code = svc)
  ),
  ships_cur as (
    select * from ship_base
    where created_at >= p_from and created_at < p_to
  ),
  ships_prev as (
    select * from ship_base
    where created_at >= p_prev_from and created_at < p_prev_to
  ),
  labels_cur as (
    select l.*
    from public.labels l
    join public.shipments s on s.id = l.shipment_id and s.shop_id = l.shop_id
    where l.shop_id = p_shop_id
      and l.kind = 'INDIA_POST'
      and l.status = 'READY'
      and coalesce(l.updated_at, l.created_at) >= p_from
      and coalesce(l.updated_at, l.created_at) < p_to
      and (svc is null or s.service_code = svc)
  ),
  delivery_hours as (
    select extract(epoch from (
      coalesce(
        (
          select min(te.occurred_at)
          from public.tracking_events te
          where te.shop_id = s.shop_id
            and te.shipment_id = s.id
            and (
              coalesce(te.summary, '') ilike '%deliver%'
              and coalesce(te.summary, '') not ilike '%undeliver%'
              and coalesce(te.summary, '') not ilike '%rto%'
            )
        ),
        case when s.status = 'DELIVERED' then s.updated_at end
      ) - s.booked_at
    )) / 3600.0 as hours
    from public.shipments s
    where s.shop_id = p_shop_id
      and s.booked_at is not null
      and s.status = 'DELIVERED'
      and (svc is null or s.service_code = svc)
      and s.updated_at >= p_from and s.updated_at < p_to
  ),
  days as (
    select generate_series(
      (timezone(tz, p_from))::date,
      (timezone(tz, p_to - interval '1 second'))::date,
      interval '1 day'
    )::date as day
  )
  select jsonb_build_object(
    'shopOrderCount', (select count(*)::int from public.orders where shop_id = p_shop_id),
    'currency', coalesce((select currency from shop), 'INR'),
    'timezone', coalesce((select timezone from shop), tz),
    'kpis', jsonb_build_object(
      'ordersReceived', jsonb_build_object(
        'current', (select count(*)::int from orders_cur),
        'previous', (select count(*)::int from orders_prev)
      ),
      'ordersShipped', jsonb_build_object(
        'current', (select count(*)::int from orders_cur where booked_at is not null),
        'previous', (select count(*)::int from orders_prev where booked_at is not null)
      ),
      'inTransit', jsonb_build_object(
        'current', (select count(*)::int from ships_cur where status in ('IN_TRANSIT', 'OUT_FOR_DELIVERY', 'LABEL_READY')),
        'previous', (select count(*)::int from ships_prev where status in ('IN_TRANSIT', 'OUT_FOR_DELIVERY', 'LABEL_READY'))
      ),
      'delivered', jsonb_build_object(
        'current', (select count(*)::int from ships_cur where status = 'DELIVERED'),
        'previous', (select count(*)::int from ships_prev where status = 'DELIVERED')
      ),
      'returned', jsonb_build_object(
        'current', (select count(*)::int from ships_cur where status = 'RTO'),
        'previous', (select count(*)::int from ships_prev where status = 'RTO')
      ),
      'codOrders', jsonb_build_object(
        'current', (select count(*)::int from orders_cur where payment_mode = 'COD'),
        'previous', (select count(*)::int from orders_prev where payment_mode = 'COD')
      )
    ),
    'orders', jsonb_build_object(
      'total', (select count(*)::int from orders_cur),
      'new', (select count(*)::int from orders_cur),
      'shipped', (select count(*)::int from orders_cur where booked_at is not null),
      'pendingShipment', (select count(*)::int from orders_cur where booked_at is null and coalesce(status, '') <> 'CANCELLED' and cancelled_at is null),
      'cancelled', (select count(*)::int from orders_cur where status = 'CANCELLED' or cancelled_at is not null),
      'returned', (select count(*)::int from orders_cur where shipment_status = 'RTO')
    ),
    'shipping', jsonb_build_object(
      'total', (select count(*)::int from ships_cur),
      'created', (select count(*)::int from ships_cur),
      'labelsGenerated', (select count(*)::int from labels_cur),
      'labelsPrinted', null,
      'inTransit', (select count(*)::int from ships_cur where status in ('IN_TRANSIT', 'OUT_FOR_DELIVERY', 'LABEL_READY')),
      'delivered', (select count(*)::int from ships_cur where status = 'DELIVERED'),
      'failedDelivery', (select count(*)::int from ships_cur where status = 'NDR'),
      'returned', (select count(*)::int from ships_cur where status = 'RTO')
    ),
    'services', (
      select jsonb_object_agg(code, payload)
      from (
        select
          code,
          jsonb_build_object(
            'orders', (select count(*)::int from orders_cur oc where oc.attributed_service = code),
            'shipments', (select count(*)::int from ships_cur sc where sc.service_code = code),
            'labelsGenerated', (
              select count(*)::int from labels_cur l
              join public.shipments s on s.id = l.shipment_id
              where s.service_code = code
            ),
            'inTransit', (select count(*)::int from ships_cur sc where sc.service_code = code and sc.status in ('IN_TRANSIT', 'OUT_FOR_DELIVERY', 'LABEL_READY')),
            'delivered', (select count(*)::int from ships_cur sc where sc.service_code = code and sc.status = 'DELIVERED'),
            'returned', (select count(*)::int from ships_cur sc where sc.service_code = code and sc.status = 'RTO'),
            'codOrders', (select count(*)::int from orders_cur oc where oc.attributed_service = code and oc.payment_mode = 'COD')
          ) as payload
        from (values ('SP_INLAND_PARCEL'), ('BUSINESS_PARCEL')) as services(code)
      ) svc_rows
    ),
    'delivery', jsonb_build_object(
      'delivered', (select count(*)::int from ships_cur where status = 'DELIVERED'),
      'inTransit', (select count(*)::int from ships_cur where status in ('IN_TRANSIT', 'OUT_FOR_DELIVERY', 'LABEL_READY')),
      'sampleCount', (select count(*)::int from delivery_hours where hours is not null and hours >= 0),
      'avgHours', (
        select case when count(*) >= 2 then avg(hours) else null end
        from delivery_hours where hours is not null and hours >= 0
      ),
      'fastestHours', (
        select case when count(*) >= 2 then min(hours) else null end
        from delivery_hours where hours is not null and hours >= 0
      ),
      'longestHours', (
        select case when count(*) >= 2 then max(hours) else null end
        from delivery_hours where hours is not null and hours >= 0
      )
    ),
    'cod', jsonb_build_object(
      'orders', (select count(*)::int from orders_cur where payment_mode = 'COD'),
      'orderValue', (select coalesce(sum(cod_amount), 0) from orders_cur where payment_mode = 'COD'),
      'delivered', (select count(*)::int from orders_cur where payment_mode = 'COD' and shipment_status = 'DELIVERED'),
      'returned', (select count(*)::int from orders_cur where payment_mode = 'COD' and shipment_status = 'RTO'),
      'pending', (
        select count(*)::int from orders_cur
        where payment_mode = 'COD'
          and coalesce(shipment_status, '') not in ('DELIVERED', 'RTO')
          and coalesce(status, '') <> 'CANCELLED'
      ),
      'collected', (
        select coalesce(sum(cod_amount), 0) from orders_cur
        where payment_mode = 'COD' and shipment_status = 'DELIVERED'
      ),
      'pendingValue', (
        select coalesce(sum(cod_amount), 0) from orders_cur
        where payment_mode = 'COD'
          and coalesce(shipment_status, '') not in ('DELIVERED', 'RTO')
          and coalesce(status, '') <> 'CANCELLED'
      ),
      'returnedValue', (
        select coalesce(sum(cod_amount), 0) from orders_cur
        where payment_mode = 'COD' and shipment_status = 'RTO'
      )
    ),
    'returns', jsonb_build_object(
      'orders', (select count(*)::int from orders_cur where shipment_status = 'RTO'),
      'shipments', (select count(*)::int from ships_cur where status = 'RTO'),
      'cod', (select count(*)::int from orders_cur where shipment_status = 'RTO' and payment_mode = 'COD'),
      'speedPost', (select count(*)::int from ships_cur where status = 'RTO' and service_code = 'SP_INLAND_PARCEL'),
      'businessParcel', (select count(*)::int from ships_cur where status = 'RTO' and service_code = 'BUSINESS_PARCEL'),
      'booked', (select count(*)::int from orders_cur where booked_at is not null)
    ),
    'pincodes', coalesce((
      select jsonb_agg(row_to_json(p))
      from (
        select coalesce(nullif(o.pincode, ''), 'Unknown') as pincode, count(*)::int as shipments
        from public.shipments s
        join public.orders o on o.id = s.order_id and o.shop_id = s.shop_id
        where s.shop_id = p_shop_id
          and s.created_at >= p_from and s.created_at < p_to
          and (svc is null or s.service_code = svc)
        group by 1
        order by count(*) desc
        limit 20
      ) p
    ), '[]'::jsonb),
    'trends', coalesce((
      select jsonb_agg(row_to_json(t) order by t.day)
      from (
        select
          days.day::text as day,
          (
            select count(*)::int from orders_cur oc
            where (timezone(tz, oc.order_at))::date = days.day
          ) as orders,
          (
            select count(*)::int from ships_cur sc
            where (timezone(tz, sc.created_at))::date = days.day
          ) as shipments,
          (
            select count(*)::int from ships_cur sc
            where sc.status = 'DELIVERED' and (timezone(tz, sc.created_at))::date = days.day
          ) as delivered,
          (
            select count(*)::int from ships_cur sc
            where sc.status = 'RTO' and (timezone(tz, sc.created_at))::date = days.day
          ) as returns
        from days
      ) t
    ), '[]'::jsonb),
    'status', jsonb_build_object(
      'shopifyOrder', jsonb_build_object(
        'READY', (select count(*)::int from orders_cur where status = 'READY' and cancelled_at is null),
        'CANCELLED', (select count(*)::int from orders_cur where status = 'CANCELLED' or cancelled_at is not null)
      ),
      'shopifyFulfillment', (
        select coalesce(jsonb_object_agg(coalesce(fulfillment_status, 'UNFULFILLED'), cnt), '{}'::jsonb)
        from (
          select fulfillment_status, count(*)::int as cnt
          from orders_cur
          group by fulfillment_status
        ) f
      ),
      'inpost', (
        select coalesce(jsonb_object_agg(status, cnt), '{}'::jsonb)
        from (
          select status, count(*)::int as cnt
          from ships_cur
          group by status
        ) st
      ),
      'tracking', (
        select coalesce(jsonb_object_agg(coalesce(operational_status, 'NONE'), cnt), '{}'::jsonb)
        from (
          select operational_status, count(*)::int as cnt
          from ships_cur
          group by operational_status
        ) op
      )
    ),
    'activity', coalesce((
      select jsonb_agg(row_to_json(a) order by a.at desc)
      from (
        (
          select
            'New order synced'::text as event,
            coalesce(o.order_name, o.id::text) as reference,
            coalesce(o.shopify_created_at, o.created_at) as at,
            o.status as status
          from public.orders o
          where o.shop_id = p_shop_id
          order by coalesce(o.shopify_created_at, o.created_at) desc
          limit 8
        )
        union all
        (
          select
            'Shipment created'::text,
            s.id::text,
            s.created_at,
            s.status
          from public.shipments s
          where s.shop_id = p_shop_id
            and (svc is null or s.service_code = svc)
          order by s.created_at desc
          limit 8
        )
        union all
        (
          select
            'India Post label generated'::text,
            l.shipment_id::text,
            coalesce(l.updated_at, l.created_at),
            l.status
          from public.labels l
          join public.shipments s on s.id = l.shipment_id and s.shop_id = l.shop_id
          where l.shop_id = p_shop_id and l.status = 'READY'
            and (svc is null or s.service_code = svc)
          order by coalesce(l.updated_at, l.created_at) desc
          limit 8
        )
        union all
        (
          select
            case
              when s.status = 'IN_TRANSIT' then 'Shipment dispatched'
              when s.status = 'DELIVERED' then 'Shipment delivered'
              when s.status = 'RTO' then 'Shipment returned'
              else 'Shipment updated'
            end,
            s.id::text,
            s.updated_at,
            s.status
          from public.shipments s
          where s.shop_id = p_shop_id
            and s.status in ('IN_TRANSIT', 'DELIVERED', 'RTO')
            and (svc is null or s.service_code = svc)
          order by s.updated_at desc
          limit 8
        )
        union all
        (
          select
            case j.type
              when 'order-sync' then 'New order synced'
              when 'shipment-booking' then 'Shipment created'
              when 'label-generation' then 'India Post label generated'
              else j.type
            end,
            coalesce(j.entity_id::text, j.id::text),
            coalesce(j.updated_at, j.created_at),
            j.status
          from public.background_jobs j
          where j.shop_id = p_shop_id
            and j.type in ('order-sync', 'shipment-booking', 'label-generation')
          order by coalesce(j.updated_at, j.created_at) desc
          limit 8
        )
        order by at desc
        limit 20
      ) a
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.shop_analytics(uuid, timestamptz, timestamptz, timestamptz, timestamptz, text, text)
  from public, anon, authenticated;
grant execute on function public.shop_analytics(uuid, timestamptz, timestamptz, timestamptz, timestamptz, text, text)
  to service_role;
