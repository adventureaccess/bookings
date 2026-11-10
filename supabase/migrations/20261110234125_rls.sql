-- Row-level security: enabled and forced on every table, with explicit grants.
--
-- Three kinds of caller:
--   anon           the public. Reads active trips, public open or full
--                  departures, and published policies. No writes.
--   authenticated  a signed-in Google account. Gets nothing beyond anon
--                  unless its email is in the staff table. Staff read
--                  everything; admin and staff roles write departures and
--                  policy versions.
--   service_role   server code only (webhook, cron, booking transaction,
--                  admin actions after a role check). Bypasses RLS.

alter table public.trips enable row level security;
alter table public.departures enable row level security;
alter table public.bookings enable row level security;
alter table public.travelers enable row level security;
alter table public.seat_holds enable row level security;
alter table public.payments enable row level security;
alter table public.policy_versions enable row level security;
alter table public.policy_acceptances enable row level security;
alter table public.staff enable row level security;
alter table public.activity_log enable row level security;
alter table public.webhook_events enable row level security;
alter table public.sync_jobs enable row level security;
alter table public.rate_limits enable row level security;

alter table public.trips force row level security;
alter table public.departures force row level security;
alter table public.bookings force row level security;
alter table public.travelers force row level security;
alter table public.seat_holds force row level security;
alter table public.payments force row level security;
alter table public.policy_versions force row level security;
alter table public.policy_acceptances force row level security;
alter table public.staff force row level security;
alter table public.activity_log force row level security;
alter table public.webhook_events force row level security;
alter table public.sync_jobs force row level security;
alter table public.rate_limits force row level security;

-- Grants. Start from nothing, so the table privileges say the same thing as
-- the policies, and a future table is closed until someone opens it.
revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;

grant select on public.trips, public.departures, public.policy_versions to anon;

grant select on all tables in schema public to authenticated;
grant insert, update, delete on public.departures, public.policy_versions to authenticated;

-- Public reads.
create policy trips_read on public.trips
  for select to anon, authenticated
  using (active or public.is_staff());

create policy departures_read on public.departures
  for select to anon, authenticated
  using (
    (visibility = 'public' and status in ('open', 'full'))
    or public.is_staff()
  );

create policy policy_versions_read on public.policy_versions
  for select to anon, authenticated
  using (published_at is not null or public.is_staff());

-- Staff writes: departures and policy versions, admin and staff roles only.
create policy departures_insert on public.departures
  for insert to authenticated
  with check (public.can_write());
create policy departures_update on public.departures
  for update to authenticated
  using (public.can_write())
  with check (public.can_write());
create policy departures_delete on public.departures
  for delete to authenticated
  using (public.can_write());

create policy policy_versions_insert on public.policy_versions
  for insert to authenticated
  with check (public.can_write());
create policy policy_versions_update on public.policy_versions
  for update to authenticated
  using (public.can_write())
  with check (public.can_write());
create policy policy_versions_delete on public.policy_versions
  for delete to authenticated
  using (public.can_write());

-- staff_role() is security definer and runs as the role that owns it. With
-- RLS forced, even the owner needs a policy to read the staff table, unless
-- it happens to bypass RLS. Do not depend on that: let the owner read it.
do $$
begin
  execute format(
    'create policy staff_definer_read on public.staff for select to %I using (true)',
    current_user
  );
end;
$$;

-- Staff reads of everything else. No write policies exist for these tables,
-- so only the service role can write them.
create policy bookings_staff_read on public.bookings
  for select to authenticated using (public.is_staff());
create policy travelers_staff_read on public.travelers
  for select to authenticated using (public.is_staff());
create policy seat_holds_staff_read on public.seat_holds
  for select to authenticated using (public.is_staff());
create policy payments_staff_read on public.payments
  for select to authenticated using (public.is_staff());
create policy policy_acceptances_staff_read on public.policy_acceptances
  for select to authenticated using (public.is_staff());
create policy staff_staff_read on public.staff
  for select to authenticated using (public.is_staff());
create policy activity_log_staff_read on public.activity_log
  for select to authenticated using (public.is_staff());
create policy webhook_events_staff_read on public.webhook_events
  for select to authenticated using (public.is_staff());
create policy sync_jobs_staff_read on public.sync_jobs
  for select to authenticated using (public.is_staff());
create policy rate_limits_staff_read on public.rate_limits
  for select to authenticated using (public.is_staff());
