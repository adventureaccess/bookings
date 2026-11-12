-- Milestone 4: money.
--
-- Two ways a payment is recorded. Card payments come only from the Stripe
-- webhook. Offline payments (wire, ACH, check, cash) are recorded by staff.
-- Both go through the same function, apply_booking_money, which adds up
-- what was received and moves the booking's status.
--
-- Also: a system-wide card fee in settings, and credits on a booking.

create type public.payment_method as enum ('card', 'wire', 'ach', 'check', 'cash', 'other');

-- System-wide settings. One row per key.
create table public.settings (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  value jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at before update on public.settings
  for each row execute function public.set_updated_at();

-- The card fee, in hundredths of a percent: 300 is 3%. Added on top of card
-- payments only. Starts at 3% until Will types in the real number.
insert into public.settings (key, value) values ('card_fee_bps', '300'::jsonb);

-- Credits on a booking. A positive amount reduces what the booking owes; a
-- negative one takes a credit back. Rows are never edited or deleted.
create table public.booking_adjustments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  amount_cents integer not null,
  reason text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint booking_adjustments_not_zero check (amount_cents <> 0),
  constraint booking_adjustments_reason check (length(btrim(reason)) between 1 and 500)
);

create index booking_adjustments_booking_id_idx on public.booking_adjustments (booking_id);

create trigger set_updated_at before update on public.booking_adjustments
  for each row execute function public.set_updated_at();

-- Payments learn how the money arrived, the card fee charged on top, and how
-- an offline payment is taken back (voided, never deleted).
alter table public.payments
  add column method public.payment_method not null default 'card',
  add column fee_cents integer not null default 0,
  add column received_on date,
  add column note text,
  add column recorded_by text,
  add column voided_at timestamptz,
  add column void_reason text,
  add constraint payments_fee_non_negative check (fee_cents >= 0),
  add constraint payments_offline_has_recorder check (method = 'card' or recorded_by is not null),
  add constraint payments_void_has_reason check (
    voided_at is null or length(btrim(coalesce(void_reason, ''))) > 0
  ),
  -- A card payment is undone by a refund in Stripe, never by a void here.
  add constraint payments_card_not_voided check (method <> 'card' or voided_at is null),
  add constraint payments_note_length check (note is null or length(note) <= 500);

-- Row-level security, same pattern as every other table.
alter table public.settings enable row level security;
alter table public.booking_adjustments enable row level security;
alter table public.settings force row level security;
alter table public.booking_adjustments force row level security;

revoke all on public.settings, public.booking_adjustments from anon, authenticated;
grant all on public.settings, public.booking_adjustments to service_role;
grant select on public.settings, public.booking_adjustments to authenticated;

create policy settings_staff_read on public.settings
  for select to authenticated using (private.is_staff());
create policy booking_adjustments_staff_read on public.booking_adjustments
  for select to authenticated using (private.is_staff());

-- Adds up a booking's money and moves its status. Every change to payments
-- or credits ends here, so card and offline money follow the same rules.
--
--   paid      = succeeded payments that are not voided, minus refunds
--   discount  = the sum of the booking's credits
--   owed      = total - discount
--
--   paid >= owed            -> paid_in_full
--   paid >= the deposit     -> deposit_paid
--
-- A pending booking is only confirmed if it still has a seat: its hold is
-- live, or the hold ran out but the seats are still free. Otherwise the money
-- is recorded, the booking stays pending and needs_attention is set. Nothing
-- is refunded automatically.
--
-- A confirmed booking never drops back to pending by itself. If its money
-- falls below the deposit (a voided payment, a refund) it shows deposit_paid
-- with needs_attention set, for staff to sort out.
create function public.apply_booking_money(p_booking_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  d public.departures%rowtype;
  b public.bookings%rowtype;
  v_paid integer;
  v_discount integer;
  v_owed integer;
  v_deposit_due integer;
  v_target text;
  v_status public.booking_status;
  v_attention boolean;
  v_confirmed_now boolean := false;
begin
  -- Lock the departure first, then the booking: the same order as
  -- create_booking, so the two can never deadlock.
  select dep.* into d
  from public.departures dep
  join public.bookings bk on bk.departure_id = dep.id
  where bk.id = p_booking_id
  for update of dep;
  if not found then
    raise exception 'booking not found' using errcode = 'no_data_found';
  end if;
  select * into b from public.bookings where id = p_booking_id for update;

  select coalesce(sum(case when p.kind = 'refund' then -p.amount_cents else p.amount_cents end), 0)
  into v_paid
  from public.payments p
  where p.booking_id = b.id and p.status = 'succeeded' and p.voided_at is null;
  v_paid := greatest(v_paid, 0);

  select coalesce(sum(a.amount_cents), 0) into v_discount
  from public.booking_adjustments a
  where a.booking_id = b.id;

  v_owed := b.total_cents - v_discount;
  v_deposit_due := least(d.deposit_cents * b.traveler_count, v_owed);
  v_status := b.status;
  v_attention := b.needs_attention;

  if v_paid >= v_owed then
    v_target := 'paid_in_full';
  elsif v_paid > 0 and v_paid >= v_deposit_due then
    v_target := 'deposit_paid';
  else
    v_target := 'below_deposit';
  end if;

  if b.status in ('canceled', 'refunded') then
    -- Money on a canceled booking is recorded, never acted on.
    if v_paid > 0 then
      v_attention := true;
    end if;
  elsif v_target in ('paid_in_full', 'deposit_paid') then
    if b.status = 'pending' then
      if exists (
        select 1 from public.seat_holds h
        where h.booking_id = b.id and h.expires_at > now()
      ) or public.departure_seats_left(d.id) >= b.traveler_count then
        v_status := v_target::public.booking_status;
        v_confirmed_now := true;
      else
        v_attention := true;
      end if;
    else
      v_status := v_target::public.booking_status;
    end if;
  elsif b.status in ('deposit_paid', 'paid_in_full') then
    v_status := 'deposit_paid';
    v_attention := true;
  end if;

  update public.bookings
  set paid_cents = v_paid,
      discount_cents = v_discount,
      status = v_status,
      needs_attention = v_attention
  where id = b.id;

  return jsonb_build_object(
    'booking_id', b.id,
    'status', v_status,
    'paid_cents', v_paid,
    'discount_cents', v_discount,
    'balance_cents', greatest(v_owed - v_paid, 0),
    'needs_attention', v_attention,
    'confirmed_now', v_confirmed_now
  );
end;
$$;

-- A card payment, from the Stripe webhook. Safe to call twice for the same
-- Checkout Session: the second call records nothing.
-- p_amount_cents is the trip money; p_fee_cents is the card fee on top.
create function public.record_card_payment(
  p_booking_id uuid,
  p_checkout_session_id text,
  p_payment_intent_id text,
  p_amount_cents integer,
  p_fee_cents integer
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_kind public.payment_kind;
  v_rows integer;
begin
  if p_checkout_session_id is null or p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'a card payment needs a session and an amount'
      using errcode = 'invalid_parameter_value';
  end if;

  select case when b.status = 'pending' then 'deposit' else 'balance' end::public.payment_kind
  into v_kind
  from public.bookings b where b.id = p_booking_id;
  if not found then
    raise exception 'booking not found' using errcode = 'no_data_found';
  end if;

  insert into public.payments (
    booking_id, stripe_checkout_session_id, stripe_payment_intent_id,
    amount_cents, fee_cents, kind, status, method, received_on
  )
  values (
    p_booking_id, p_checkout_session_id, p_payment_intent_id,
    p_amount_cents, coalesce(p_fee_cents, 0), v_kind, 'succeeded', 'card', current_date
  )
  on conflict (stripe_checkout_session_id)
    where stripe_checkout_session_id is not null and kind <> 'refund'
  do nothing;
  get diagnostics v_rows = row_count;

  return public.apply_booking_money(p_booking_id) || jsonb_build_object('recorded', v_rows = 1);
end;
$$;

-- A refund made in Stripe, from the charge.refunded webhook. Stripe reports
-- the total refunded so far on the charge; this records whatever part of
-- that is not recorded yet, so a replay records nothing.
create function public.record_card_refund(
  p_payment_intent_id text,
  p_refund_key text,
  p_total_refunded_cents integer
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_booking_id uuid;
  v_recorded integer;
  v_delta integer;
begin
  select p.booking_id into v_booking_id
  from public.payments p
  where p.stripe_payment_intent_id = p_payment_intent_id and p.kind <> 'refund'
  limit 1;
  if v_booking_id is null then
    return jsonb_build_object('recorded', false, 'reason', 'unknown_payment');
  end if;

  select coalesce(sum(p.amount_cents), 0) into v_recorded
  from public.payments p
  where p.stripe_payment_intent_id = p_payment_intent_id and p.kind = 'refund';

  v_delta := coalesce(p_total_refunded_cents, 0) - v_recorded;
  if v_delta > 0 then
    insert into public.payments (
      booking_id, stripe_payment_intent_id, stripe_refund_id,
      amount_cents, kind, status, method, received_on
    )
    values (
      v_booking_id, p_payment_intent_id, p_refund_key,
      v_delta, 'refund', 'succeeded', 'card', current_date
    )
    on conflict (stripe_refund_id) where stripe_refund_id is not null do nothing;
  end if;

  return public.apply_booking_money(v_booking_id) || jsonb_build_object('recorded', v_delta > 0);
end;
$$;

-- An offline payment, recorded by staff.
create function public.record_offline_payment(
  p_booking_id uuid,
  p_method public.payment_method,
  p_amount_cents integer,
  p_received_on date,
  p_note text,
  p_recorded_by text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_kind public.payment_kind;
  v_payment_id uuid;
begin
  if p_method = 'card' then
    raise exception 'card payments are recorded by the Stripe webhook only'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'the amount must be more than zero' using errcode = 'invalid_parameter_value';
  end if;
  if p_recorded_by is null or btrim(p_recorded_by) = '' then
    raise exception 'who recorded it is required' using errcode = 'invalid_parameter_value';
  end if;

  select case when b.status = 'pending' then 'deposit' else 'balance' end::public.payment_kind
  into v_kind
  from public.bookings b where b.id = p_booking_id;
  if not found then
    raise exception 'booking not found' using errcode = 'no_data_found';
  end if;

  insert into public.payments (
    booking_id, amount_cents, kind, status, method, received_on, note, recorded_by
  )
  values (
    p_booking_id, p_amount_cents, v_kind, 'succeeded', p_method,
    coalesce(p_received_on, current_date), nullif(btrim(coalesce(p_note, '')), ''), p_recorded_by
  )
  returning id into v_payment_id;

  return public.apply_booking_money(p_booking_id) || jsonb_build_object('payment_id', v_payment_id);
end;
$$;

-- Takes an offline payment back. The row stays, marked voided, with why.
create function public.void_payment(p_payment_id uuid, p_reason text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_booking_id uuid;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'a reason is required' using errcode = 'invalid_parameter_value';
  end if;

  update public.payments
  set voided_at = now(), void_reason = left(btrim(p_reason), 500)
  where id = p_payment_id and method <> 'card' and voided_at is null
  returning booking_id into v_booking_id;
  if v_booking_id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_voidable');
  end if;

  return public.apply_booking_money(v_booking_id) || jsonb_build_object('ok', true);
end;
$$;

-- Adds a credit to a booking, or takes one back with a negative amount. The
-- booking's credits can never go below zero or above its total.
create function public.add_booking_adjustment(
  p_booking_id uuid,
  p_amount_cents integer,
  p_reason text,
  p_created_by text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_total integer;
  v_credits integer;
begin
  select b.total_cents into v_total
  from public.bookings b where b.id = p_booking_id for update;
  if not found then
    raise exception 'booking not found' using errcode = 'no_data_found';
  end if;

  select coalesce(sum(a.amount_cents), 0) into v_credits
  from public.booking_adjustments a where a.booking_id = p_booking_id;

  if v_credits + p_amount_cents < 0 or v_credits + p_amount_cents > v_total then
    return jsonb_build_object('ok', false, 'reason', 'out_of_range', 'credits_cents', v_credits);
  end if;

  insert into public.booking_adjustments (booking_id, amount_cents, reason, created_by)
  values (p_booking_id, p_amount_cents, btrim(p_reason), p_created_by);

  return public.apply_booking_money(p_booking_id) || jsonb_build_object('ok', true);
end;
$$;

-- Before sending a traveler to pay by card: make sure a pending booking has
-- a live hold that lasts as long as the Stripe session. Reuses the booking's
-- one hold. A booking that is already confirmed needs no hold.
create function public.prepare_payment(p_booking_id uuid, p_hold_minutes integer)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  d public.departures%rowtype;
  b public.bookings%rowtype;
  v_expires_at timestamptz;
begin
  select dep.* into d
  from public.departures dep
  join public.bookings bk on bk.departure_id = dep.id
  where bk.id = p_booking_id
  for update of dep;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  select * into b from public.bookings where id = p_booking_id for update;

  if b.status in ('canceled', 'refunded') then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  if b.status <> 'pending' then
    return jsonb_build_object('ok', true, 'hold_expires_at', null);
  end if;
  if d.status not in ('open', 'full') then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;

  if not exists (
    select 1 from public.seat_holds h where h.booking_id = b.id and h.expires_at > now()
  ) and public.departure_seats_left(d.id) < b.traveler_count then
    return jsonb_build_object('ok', false, 'reason', 'not_enough_seats');
  end if;

  v_expires_at := now() + make_interval(mins => p_hold_minutes);
  insert into public.seat_holds (departure_id, booking_id, seats, expires_at)
  values (d.id, b.id, b.traveler_count, v_expires_at)
  on conflict (booking_id) do update
    set seats = excluded.seats, expires_at = excluded.expires_at;

  return jsonb_build_object('ok', true, 'hold_expires_at', v_expires_at);
end;
$$;

-- Housekeeping for the scheduled job. Expired holds already count for
-- nothing; this only keeps the table small.
create function public.delete_expired_holds()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_rows integer;
begin
  delete from public.seat_holds where expires_at < now() - interval '1 hour';
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- The traveler's booking page now shows money too. Same rule as before: found
-- only by reference plus token hash, and no emails or phone numbers.
create or replace function public.booking_summary(p_reference text, p_access_token_hash text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'booking_id', b.id,
    'reference', b.reference,
    'status', b.status,
    'traveler_count', b.traveler_count,
    'total_cents', b.total_cents,
    'discount_cents', b.discount_cents,
    'paid_cents', b.paid_cents,
    'price_cents', d.price_cents,
    'deposit_cents', d.deposit_cents,
    'deposit_due_cents', d.deposit_cents * b.traveler_count,
    'payment_schedule', d.payment_schedule,
    'balance_due_date', d.balance_due_date,
    'card_fee_bps', coalesce(
      (select (s.value #>> '{}')::integer from public.settings s where s.key = 'card_fee_bps'), 0
    ),
    'payments', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'kind', p.kind,
          'method', p.method,
          'amount_cents', p.amount_cents,
          'fee_cents', p.fee_cents,
          'received_on', coalesce(p.received_on, p.created_at::date)
        )
        order by p.created_at
      )
      from public.payments p
      where p.booking_id = b.id and p.status = 'succeeded' and p.voided_at is null
    ), '[]'::jsonb),
    'hold_expires_at', h.expires_at,
    'hold_active', coalesce(h.expires_at > now(), false),
    'departure_id', d.id,
    'departure_open', d.status in ('open', 'full'),
    'is_private', d.visibility = 'private',
    'start_date', d.start_date,
    'end_date', d.end_date,
    'trip_slug', t.slug,
    'trip_title', t.title,
    'lead_first_name', (
      select tr.first_name from public.travelers tr where tr.id = b.lead_traveler_id
    )
  )
  from public.bookings b
  join public.departures d on d.id = b.departure_id
  join public.trips t on t.id = d.trip_id
  left join public.seat_holds h on h.booking_id = b.id
  where b.reference = p_reference
    and b.access_token_hash = p_access_token_hash
$$;

-- The lead traveler's email, for the Stripe receipt. Server code only, and
-- only with the booking's token hash.
create function public.booking_lead_email(p_reference text, p_access_token_hash text)
returns text
language sql
stable
set search_path = ''
as $$
  select tr.email
  from public.bookings b
  join public.travelers tr on tr.id = b.lead_traveler_id
  where b.reference = p_reference
    and b.access_token_hash = p_access_token_hash
$$;

-- Server code only.
revoke all on function public.apply_booking_money(uuid) from public, anon, authenticated;
revoke all on function public.record_card_payment(uuid, text, text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.record_card_refund(text, text, integer)
  from public, anon, authenticated;
revoke all on function public.record_offline_payment(
  uuid, public.payment_method, integer, date, text, text
) from public, anon, authenticated;
revoke all on function public.void_payment(uuid, text) from public, anon, authenticated;
revoke all on function public.add_booking_adjustment(uuid, integer, text, text)
  from public, anon, authenticated;
revoke all on function public.prepare_payment(uuid, integer) from public, anon, authenticated;
revoke all on function public.delete_expired_holds() from public, anon, authenticated;
revoke all on function public.booking_lead_email(text, text) from public, anon, authenticated;

grant execute on function public.apply_booking_money(uuid) to service_role;
grant execute on function public.record_card_payment(uuid, text, text, integer, integer)
  to service_role;
grant execute on function public.record_card_refund(text, text, integer) to service_role;
grant execute on function public.record_offline_payment(
  uuid, public.payment_method, integer, date, text, text
) to service_role;
grant execute on function public.void_payment(uuid, text) to service_role;
grant execute on function public.add_booking_adjustment(uuid, integer, text, text)
  to service_role;
grant execute on function public.prepare_payment(uuid, integer) to service_role;
grant execute on function public.delete_expired_holds() to service_role;
grant execute on function public.booking_lead_email(text, text) to service_role;
