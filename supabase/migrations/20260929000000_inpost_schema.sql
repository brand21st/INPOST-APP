-- InPost operational schema. Apply only to a new InPost Supabase project.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.shops (
  id uuid primary key default gen_random_uuid(),
  shop_domain text not null unique,
  shop_gid text,
  name text,
  email text,
  currency text,
  timezone text,
  encrypted_offline_token text,
  token_expires_at timestamptz,
  refresh_token text,
  scopes text,
  status text not null default 'INSTALLED' check (status in ('INSTALLED', 'UNINSTALLED')),
  installed_at timestamptz,
  uninstalled_at timestamptz,
  webhooks_registered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.shopify_sessions (
  id text primary key,
  shop_id uuid references public.shops (id) on delete cascade,
  shop text not null,
  state text not null,
  is_online boolean not null default false,
  scope text,
  expires timestamptz,
  access_token text,
  refresh_token text,
  refresh_token_expires timestamptz,
  user_id bigint,
  first_name text,
  last_name text,
  email text,
  account_owner boolean not null default false,
  locale text,
  collaborator boolean,
  email_verified boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index shopify_sessions_shop_idx on public.shopify_sessions (shop);
create index shopify_sessions_expires_idx on public.shopify_sessions (expires);

create table public.shop_settings (
  shop_id uuid primary key references public.shops (id) on delete cascade,
  auto_book boolean not null default false,
  default_service text not null default 'SP_INLAND_PARCEL'
    check (default_service in ('SP_INLAND_PARCEL', 'BUSINESS_PARCEL')),
  drop_off_office_id text,
  sender_name text,
  sender_mobile text,
  sender_pincode text,
  sender_address text,
  default_parcel_grams integer not null default 500,
  brand_logo_url text,
  brand_color text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.india_post_connections (
  shop_id uuid primary key references public.shops (id) on delete cascade,
  encrypted_username text,
  encrypted_password text,
  encrypted_access_token text,
  encrypted_refresh_token text,
  token_expires_at timestamptz,
  bulk_customer_id text,
  environment text not null default 'UAT' check (environment in ('UAT', 'PRODUCTION')),
  office_id text,
  inbound_token_hash text unique,
  status text not null default 'DISCONNECTED',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.india_post_contracts (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  service_code text not null,
  contract_id text not null,
  is_default boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, service_code)
);

create table public.barcode_ranges (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  prefix text not null,
  suffix text not null default 'IN',
  start_number bigint not null,
  end_number bigint not null,
  next_number bigint not null,
  service_code text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (prefix ~ '^[A-Z]{2}$'),
  check (start_number <= end_number),
  check (next_number >= start_number)
);

create unique index barcode_ranges_one_active
  on public.barcode_ranges (shop_id, coalesce(service_code, ''))
  where active;

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  shopify_order_gid text not null,
  order_name text,
  financial_status text,
  fulfillment_status text,
  payment_gateway_names text[] not null default '{}',
  total_amount numeric,
  amount_outstanding numeric,
  payment_mode text check (payment_mode in ('COD', 'PREPAID')),
  cod_amount numeric not null default 0,
  shipping_name text,
  shipping_address text,
  phone text,
  pincode text,
  cancelled_at timestamptz,
  status text not null default 'READY',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, shopify_order_gid)
);

create table public.order_line_items (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  order_id uuid not null references public.orders (id) on delete cascade,
  shopify_line_item_gid text not null,
  title text,
  sku text,
  quantity integer not null default 1,
  grams integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, shopify_line_item_gid)
);

create table public.shipments (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  order_id uuid not null references public.orders (id) on delete cascade,
  service_code text not null,
  payment_mode text not null check (payment_mode in ('COD', 'PREPAID')),
  cod_amount numeric not null default 0,
  weight_grams integer not null,
  length_cm numeric,
  width_cm numeric,
  height_cm numeric,
  submitted_s10 text,
  accepted_article_number text,
  tracking_number text,
  barcode text,
  status text not null default 'DRAFT',
  operational_status text,
  tariff numeric,
  last_error text,
  booked_at timestamptz,
  shopify_fulfillment_gid text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status in (
    'DRAFT', 'QUEUED', 'BOOKING', 'BOOKED', 'LABEL_READY',
    'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'NDR', 'RTO',
    'FAILED', 'CANCELLED'
  ))
);

create unique index shipments_one_open_per_order
  on public.shipments (shop_id, order_id)
  where status <> 'CANCELLED';

create unique index shipments_barcode_unique
  on public.shipments (shop_id, barcode)
  where barcode is not null;

create unique index shipments_tracking_unique
  on public.shipments (shop_id, tracking_number)
  where tracking_number is not null;

create table public.barcode_allocations (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  range_id uuid not null references public.barcode_ranges (id) on delete cascade,
  serial bigint not null,
  s10 text not null,
  shipment_id uuid references public.shipments (id) on delete set null,
  status text not null check (status in ('RESERVED', 'COMMITTED', 'ABANDONED')),
  abandon_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, s10)
);

create table public.booking_attempts (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  shipment_id uuid not null references public.shipments (id) on delete cascade,
  idempotency_key text not null,
  s10_submitted text,
  request_hash text,
  response_hash text,
  status text not null,
  error_class text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.labels (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  shipment_id uuid not null references public.shipments (id) on delete cascade,
  kind text not null default 'INDIA_POST',
  storage_key text,
  sha256 text,
  status text not null default 'PENDING',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shipment_id, kind)
);

create table public.tracking_events (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  shipment_id uuid not null references public.shipments (id) on delete cascade,
  event_key text not null,
  occurred_at timestamptz not null,
  status text,
  summary text,
  raw_payload text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, shipment_id, event_key, occurred_at)
);

create table public.webhook_inbox (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('SHOPIFY', 'INDIA_POST')),
  shop_id uuid references public.shops (id) on delete cascade,
  topic text not null,
  external_id text not null,
  payload jsonb,
  payload_hash text,
  status text not null default 'RECEIVED'
    check (status in ('RECEIVED', 'PROCESSED', 'FAILED', 'DEAD')),
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, external_id)
);

create table public.idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  scope text not null,
  key text not null,
  result jsonb,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (shop_id, scope, key)
);

create table public.background_jobs (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  type text not null,
  entity_id uuid,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'QUEUED'
    check (status in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD', 'CANCELLED')),
  attempts integer not null default 0,
  run_after timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index background_jobs_one_active_booking
  on public.background_jobs (shop_id, type, entity_id)
  where status in ('QUEUED', 'RUNNING') and type = 'shipment-booking';

create index background_jobs_claim_idx
  on public.background_jobs (status, run_after);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  shipment_id uuid references public.shipments (id) on delete set null,
  invoice_number text not null,
  storage_key text,
  totals jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, invoice_number)
);

create table public.compliance_requests (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid references public.shops (id) on delete set null,
  topic text not null,
  shop_domain text not null,
  payload jsonb,
  status text not null default 'RECEIVED',
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid references public.shops (id) on delete cascade,
  action text not null,
  entity_type text,
  entity_id uuid,
  detail jsonb,
  created_at timestamptz not null default now()
);

create table public.rate_limit_buckets (
  shop_id uuid not null references public.shops (id) on delete cascade,
  bucket_key text not null,
  window_start timestamptz not null,
  hit_count integer not null default 0,
  primary key (shop_id, bucket_key, window_start)
);

create or replace function public.s10_check_digit(serial bigint)
returns integer
language plpgsql
immutable
as $$
declare
  digits text := lpad(serial::text, 8, '0');
  weights int[] := array[8, 6, 4, 2, 3, 5, 9, 7];
  i int;
  total int := 0;
  check_digit int;
begin
  if length(digits) <> 8 then
    raise exception 'INVALID_BARCODE';
  end if;
  for i in 1..8 loop
    total := total + (substr(digits, i, 1)::int * weights[i]);
  end loop;
  check_digit := 11 - (total % 11);
  if check_digit = 11 then
    return 5;
  elsif check_digit = 10 then
    return 0;
  end if;
  return check_digit;
end;
$$;

create or replace function public.allocate_barcode(p_shop_id uuid, p_service_code text)
returns table (allocation_id uuid, serial bigint, s10 text, status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  range_row public.barcode_ranges%rowtype;
  allocated bigint;
  env text;
  article text;
  alloc_status text;
  new_id uuid;
begin
  select * into range_row
  from public.barcode_ranges
  where shop_id = p_shop_id
    and active
    and service_code is not distinct from p_service_code
  limit 1
  for update;

  if not found then
    select * into range_row
    from public.barcode_ranges
    where shop_id = p_shop_id
      and active
      and service_code is null
    limit 1
    for update;
  end if;

  if not found then
    status := 'NO_RANGE';
    return next;
    return;
  end if;

  update public.barcode_ranges
  set next_number = next_number + 1,
      updated_at = now()
  where id = range_row.id
    and next_number <= end_number
  returning next_number - 1 into allocated;

  if allocated is null then
    status := 'EXHAUSTED';
    return next;
    return;
  end if;

  select environment into env
  from public.india_post_connections
  where shop_id = p_shop_id;

  article := range_row.prefix
    || lpad(allocated::text, 8, '0')
    || public.s10_check_digit(allocated)::text
    || coalesce(range_row.suffix, 'IN');

  if coalesce(env, 'PRODUCTION') = 'PRODUCTION'
     and allocated between 21433001 and 21434000 then
    alloc_status := 'ABANDONED';
    status := 'REJECTED_UAT';
  else
    alloc_status := 'RESERVED';
    status := 'ALLOCATED';
  end if;

  insert into public.barcode_allocations (shop_id, range_id, serial, s10, status, abandon_reason)
  values (
    p_shop_id,
    range_row.id,
    allocated,
    article,
    alloc_status,
    case when alloc_status = 'ABANDONED' then 'CEPT UAT test series' else null end
  )
  returning id into new_id;

  allocation_id := new_id;
  serial := allocated;
  s10 := article;
  return next;
end;
$$;

create or replace function public.claim_background_jobs(p_limit integer)
returns setof public.background_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with picked as (
    select id
    from public.background_jobs
    where status = 'QUEUED'
      and run_after <= now()
    order by run_after
    limit p_limit
    for update skip locked
  )
  update public.background_jobs as job
  set status = 'RUNNING',
      locked_until = now() + interval '5 minutes',
      attempts = job.attempts + 1,
      updated_at = now()
  from picked
  where job.id = picked.id
  returning job.*;
end;
$$;

create or replace function public.consume_rate_limit(
  p_shop_id uuid,
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  window_start timestamptz;
  hits integer;
begin
  window_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );
  insert into public.rate_limit_buckets (shop_id, bucket_key, window_start, hit_count)
  values (p_shop_id, p_key, window_start, 1)
  on conflict (shop_id, bucket_key, window_start)
  do update set hit_count = public.rate_limit_buckets.hit_count + 1
  returning hit_count into hits;
  return hits <= p_limit;
end;
$$;

do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'shops', 'shopify_sessions', 'shop_settings', 'india_post_connections',
    'india_post_contracts', 'barcode_ranges', 'orders', 'order_line_items',
    'shipments', 'barcode_allocations', 'booking_attempts', 'labels',
    'tracking_events', 'webhook_inbox', 'idempotency_keys', 'background_jobs',
    'invoices', 'compliance_requests', 'audit_logs', 'rate_limit_buckets'
  ]
  loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('revoke all on table public.%I from anon, authenticated', tbl);
    execute format('grant select, insert, update, delete on table public.%I to service_role', tbl);
  end loop;
end;
$$;

revoke all on function public.allocate_barcode(uuid, text) from public, anon, authenticated;
revoke all on function public.claim_background_jobs(integer) from public, anon, authenticated;
revoke all on function public.consume_rate_limit(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.allocate_barcode(uuid, text) to service_role;
grant execute on function public.claim_background_jobs(integer) to service_role;
grant execute on function public.consume_rate_limit(uuid, text, integer, integer) to service_role;

insert into storage.buckets (id, name, public)
values ('labels', 'labels', false), ('invoices', 'invoices', false)
on conflict (id) do nothing;
