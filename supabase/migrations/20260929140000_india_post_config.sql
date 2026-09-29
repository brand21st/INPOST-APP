-- India Post configuration fields and per-shop barcode overlap protection.

alter table public.india_post_connections
  add column if not exists last_error text,
  add column if not exists drop_office_name text,
  add column if not exists drop_office_pincode text;

alter table public.india_post_connections
  drop constraint if exists india_post_connections_status_check;

alter table public.india_post_connections
  add constraint india_post_connections_status_check
  check (status in ('DISCONNECTED', 'CONNECTED', 'FAILED'));

create extension if not exists btree_gist;

alter table public.barcode_ranges
  drop constraint if exists barcode_ranges_prefix_no_overlap;

alter table public.barcode_ranges
  add constraint barcode_ranges_prefix_no_overlap
  exclude using gist (
    shop_id with =,
    prefix with =,
    int8range(start_number, end_number, '[]') with &&
  );
