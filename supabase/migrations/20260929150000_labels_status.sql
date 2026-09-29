alter table public.labels
  add column if not exists last_error text;

alter table public.labels drop constraint if exists labels_status_check;
alter table public.labels
  add constraint labels_status_check check (status in ('PENDING', 'READY', 'FAILED'));

create index if not exists labels_shop_status_idx on public.labels (shop_id, status, created_at desc);
create index if not exists shipments_shop_status_idx on public.shipments (shop_id, status, created_at desc);
