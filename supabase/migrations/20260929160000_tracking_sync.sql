alter table public.shipments
  add column if not exists last_tracking_synced_at timestamptz,
  add column if not exists last_tracking_location text;

alter table public.tracking_events
  add column if not exists location text;
