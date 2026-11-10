-- Trips, departures, bookings, travelers, seat holds and payments.
-- Money is integer cents with a currency column that is always 'usd'.

create type public.departure_status as enum ('open', 'full', 'closed', 'canceled');
create type public.departure_visibility as enum ('public', 'private');
create type public.booking_status as enum (
  'pending', 'deposit_paid', 'paid_in_full', 'canceled', 'refunded'
);
create type public.payment_kind as enum ('deposit', 'balance', 'refund');
create type public.payment_status as enum ('pending', 'succeeded', 'failed');

-- Trips. Slug, title, destination and hero image come from the website feed.
create table public.trips (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  destination text not null,
  hero_image_url text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trips_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint trips_hero_image_absolute check (
    hero_image_url is null or hero_image_url ~ '^https://'
  )
);

-- Departures. Prices and capacity live only here.
create table public.departures (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete restrict,
  start_date date not null,
  end_date date not null,
  price_cents integer not null,
  deposit_cents integer not null,
  currency text not null default 'usd',
  balance_due_date date not null,
  min_travelers integer not null default 1,
  max_travelers integer not null,
  status public.departure_status not null default 'open',
  visibility public.departure_visibility not null default 'public',
  private_token text unique,
  -- policy_version_id is added in 0003, once policy_versions exists.
  custom_questions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint departures_dates check (end_date >= start_date),
  constraint departures_balance_due check (balance_due_date <= start_date),
  constraint departures_price_non_negative check (price_cents >= 0),
  constraint departures_deposit_non_negative check (deposit_cents >= 0),
  constraint departures_deposit_within_price check (deposit_cents <= price_cents),
  constraint departures_currency_usd check (currency = 'usd'),
  constraint departures_min_travelers check (min_travelers >= 1),
  constraint departures_capacity check (min_travelers <= max_travelers),
  constraint departures_private_needs_token check (
    visibility = 'public' or private_token is not null
  ),
  constraint departures_custom_questions_array check (
    jsonb_typeof(custom_questions) = 'array'
  )
);

create index departures_trip_id_idx on public.departures (trip_id);
create index departures_start_date_idx on public.departures (start_date);

-- Bookings. Addressed from outside by reference plus a signed token; only the
-- token's hash is stored.
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  departure_id uuid not null references public.departures (id) on delete restrict,
  reference text not null unique,
  access_token_hash text not null,
  status public.booking_status not null default 'pending',
  -- lead_traveler_id gets its foreign key below, after travelers exists.
  lead_traveler_id uuid,
  traveler_count integer not null,
  total_cents integer not null,
  discount_cents integer not null default 0,
  paid_cents integer not null default 0,
  currency text not null default 'usd',
  needs_attention boolean not null default false,
  hubspot_deal_id text,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bookings_reference_format check (reference ~ '^AA-[2-9A-HJ-NP-Z]{4,8}$'),
  constraint bookings_traveler_count check (traveler_count >= 1),
  constraint bookings_total_non_negative check (total_cents >= 0),
  constraint bookings_discount_non_negative check (discount_cents >= 0),
  constraint bookings_paid_non_negative check (paid_cents >= 0),
  constraint bookings_currency_usd check (currency = 'usd')
);

create index bookings_departure_id_idx on public.bookings (departure_id);
create index bookings_status_idx on public.bookings (status);
create index bookings_needs_attention_idx on public.bookings (needs_attention)
  where needs_attention;

-- Travelers. Email is required for the lead only.
create table public.travelers (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  first_name text not null,
  last_name text not null,
  email text,
  phone text,
  is_lead boolean not null default false,
  answers jsonb not null default '{}'::jsonb,
  hubspot_contact_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint travelers_lead_has_email check (not is_lead or email is not null),
  constraint travelers_email_lowercase check (email is null or email = lower(email))
);

create index travelers_booking_id_idx on public.travelers (booking_id);
create index travelers_email_idx on public.travelers (email);
create unique index travelers_one_lead_per_booking
  on public.travelers (booking_id) where is_lead;

alter table public.bookings
  add constraint bookings_lead_traveler_id_fkey
  foreign key (lead_traveler_id) references public.travelers (id) on delete set null;

create index bookings_lead_traveler_id_idx on public.bookings (lead_traveler_id);

-- Seat holds. One per booking, ever: a traveler who cancels Checkout and
-- comes back reuses the same hold.
create table public.seat_holds (
  id uuid primary key default gen_random_uuid(),
  departure_id uuid not null references public.departures (id) on delete cascade,
  booking_id uuid not null unique references public.bookings (id) on delete cascade,
  seats integer not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint seat_holds_seats check (seats >= 1)
);

create index seat_holds_departure_expires_idx
  on public.seat_holds (departure_id, expires_at);

-- Payments. Written only by the Stripe webhook, refunds included.
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete restrict,
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  stripe_refund_id text,
  amount_cents integer not null,
  currency text not null default 'usd',
  kind public.payment_kind not null,
  status public.payment_status not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payments_amount_non_negative check (amount_cents >= 0),
  constraint payments_currency_usd check (currency = 'usd'),
  constraint payments_refund_has_id check (kind <> 'refund' or stripe_refund_id is not null)
);

create index payments_booking_id_idx on public.payments (booking_id);
create index payments_payment_intent_idx on public.payments (stripe_payment_intent_id);
-- One row per Checkout Session and one per refund, so a replayed webhook
-- cannot record the same money twice.
create unique index payments_checkout_session_unique
  on public.payments (stripe_checkout_session_id)
  where stripe_checkout_session_id is not null and kind <> 'refund';
create unique index payments_refund_unique
  on public.payments (stripe_refund_id)
  where stripe_refund_id is not null;

create trigger set_updated_at before update on public.trips
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.departures
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.bookings
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.travelers
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.seat_holds
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.payments
  for each row execute function public.set_updated_at();
