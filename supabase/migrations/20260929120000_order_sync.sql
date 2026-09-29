alter table public.orders
  add column if not exists shopify_created_at timestamptz;

alter table public.order_line_items
  add column if not exists unit_price numeric;

create index if not exists orders_shop_created_idx
  on public.orders (shop_id, shopify_created_at desc);

create table if not exists public.order_sync_states (
  shop_id uuid primary key references public.shops (id) on delete cascade,
  status text not null default 'IDLE'
    check (status in ('IDLE', 'RUNNING', 'COMPLETED', 'FAILED')),
  cursor text,
  processed_count integer not null default 0,
  last_error text,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);

create unique index if not exists background_jobs_one_active_order_sync
  on public.background_jobs (shop_id)
  where status in ('QUEUED', 'RUNNING') and type = 'order-sync';

alter table public.order_sync_states enable row level security;
revoke all on table public.order_sync_states from anon, authenticated;
grant select, insert, update, delete on table public.order_sync_states to service_role;
