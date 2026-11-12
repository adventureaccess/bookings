-- Booking functions: seat counting, the public booking reads, and the one
-- transaction that creates a pending booking with its seat hold.
--
-- All of these run as the caller (security invoker) and only the service
-- role may execute them. Server code calls them; the public API roles cannot.
-- They exist as functions because the Supabase client cannot run a
-- multi-statement transaction, and because seat counts need bookings and
-- holds, which the public role must never read directly.

-- Seats left = capacity - confirmed travelers - unexpired holds.
-- A hold only counts while its booking is still pending: once the booking is
-- paid it is counted as confirmed travelers, and a canceled booking frees it.
-- Never depends on a cleanup job having run.
create function public.departure_seats_left(p_departure_id uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select (
    d.max_travelers
    - coalesce((
        select sum(b.traveler_count)
        from public.bookings b
        where b.departure_id = d.id
          and b.status in ('deposit_paid', 'paid_in_full')
      ), 0)
    - coalesce((
        select sum(h.seats)
        from public.seat_holds h
        join public.bookings b on b.id = h.booking_id
        where h.departure_id = d.id
          and h.expires_at > now()
          and b.status = 'pending'
      ), 0)
  )::integer
  from public.departures d
  where d.id = p_departure_id
$$;

-- The public departure list: public, open or full, in the future, on an
-- active trip, with a policy attached (without one it cannot be booked).
create function public.bookable_departures()
returns table (
  departure_id uuid,
  trip_slug text,
  trip_title text,
  destination text,
  hero_image_url text,
  start_date date,
  end_date date,
  price_cents integer,
  deposit_cents integer,
  status public.departure_status,
  seats_left integer
)
language sql
stable
set search_path = ''
as $$
  select
    d.id, t.slug, t.title, t.destination, t.hero_image_url,
    d.start_date, d.end_date, d.price_cents, d.deposit_cents, d.status,
    greatest(public.departure_seats_left(d.id), 0)
  from public.departures d
  join public.trips t on t.id = d.trip_id
  where d.visibility = 'public'
    and d.status in ('open', 'full')
    and t.active
    and d.start_date > current_date
    and d.policy_version_id is not null
  order by d.start_date, t.title
$$;

-- Everything the booking page needs for one departure, or null when the
-- traveler may not see it. A private departure needs its key.
create function public.departure_for_booking(p_departure_id uuid, p_key text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', d.id,
    'trip_slug', t.slug,
    'trip_title', t.title,
    'destination', t.destination,
    'hero_image_url', t.hero_image_url,
    'start_date', d.start_date,
    'end_date', d.end_date,
    'price_cents', d.price_cents,
    'deposit_cents', d.deposit_cents,
    'balance_due_date', d.balance_due_date,
    'payment_schedule', d.payment_schedule,
    'custom_questions', d.custom_questions,
    'status', d.status,
    'is_private', d.visibility = 'private',
    'is_past', d.start_date <= current_date,
    'seats_left', greatest(public.departure_seats_left(d.id), 0),
    'policy', (
      select jsonb_build_object(
        'id', p.id, 'version', p.version, 'title', p.title, 'body_md', p.body_md
      )
      from public.policy_versions p
      where p.id = d.policy_version_id and p.published_at is not null
    )
  )
  from public.departures d
  join public.trips t on t.id = d.trip_id
  where d.id = p_departure_id
    and t.active
    and d.status in ('open', 'full')
    and (
      d.visibility = 'public'
      or (p_key is not null and d.private_token = p_key)
    )
$$;

-- Creates a pending booking, its travelers, the policy acceptance and a seat
-- hold, all or nothing. The departure row is locked first, so two travelers
-- going for the last seat are handled one after the other: the second one
-- sees the first one's hold and is refused.
--
-- p_resume_booking_id: a traveler who comes back and submits again reuses
-- their pending booking and its hold. Never a second hold.
--
-- Returns {"ok": true, booking_id, reference, expires_at, resumed}
-- or {"ok": false, "reason": "not_found" | "closed" | "policy_changed" |
--     "not_enough_seats", "seats_left"?}. Nothing is written on a refusal.
create function public.create_booking(
  p_departure_id uuid,
  p_key text,
  p_policy_version_id uuid,
  p_travelers jsonb,
  p_access_token_hash text,
  p_ip inet,
  p_user_agent text,
  p_source text,
  p_resume_booking_id uuid default null,
  p_hold_minutes integer default 30
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  d public.departures%rowtype;
  v_count integer;
  v_seats_left integer;
  v_booking_id uuid;
  v_reference text;
  v_lead_id uuid;
  v_expires_at timestamptz;
  v_resumed boolean := false;
begin
  if jsonb_typeof(p_travelers) is distinct from 'array' then
    raise exception 'travelers must be a list' using errcode = 'invalid_parameter_value';
  end if;
  v_count := jsonb_array_length(p_travelers);
  if v_count < 1 or v_count > 20 then
    raise exception 'between 1 and 20 travelers' using errcode = 'invalid_parameter_value';
  end if;
  if (
    select count(*) from jsonb_array_elements(p_travelers) t
    where coalesce((t ->> 'is_lead')::boolean, false)
  ) <> 1 then
    raise exception 'exactly one lead traveler' using errcode = 'invalid_parameter_value';
  end if;
  if p_hold_minutes < 1 or p_hold_minutes > 120 then
    raise exception 'hold of 1 to 120 minutes' using errcode = 'invalid_parameter_value';
  end if;

  -- The lock. Everything below sees a settled picture of this departure.
  select * into d from public.departures where id = p_departure_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if d.visibility = 'private'
     and (p_key is null or d.private_token is distinct from p_key) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if not exists (select 1 from public.trips t where t.id = d.trip_id and t.active) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if d.status <> 'open' or d.start_date <= current_date or d.policy_version_id is null then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  -- The traveler must accept the policy that is attached right now.
  if d.policy_version_id is distinct from p_policy_version_id then
    return jsonb_build_object('ok', false, 'reason', 'policy_changed');
  end if;

  if p_resume_booking_id is not null then
    select b.id, b.reference into v_booking_id, v_reference
    from public.bookings b
    where b.id = p_resume_booking_id
      and b.departure_id = p_departure_id
      and b.status = 'pending'
    for update;
    v_resumed := v_booking_id is not null;
  end if;

  v_seats_left := public.departure_seats_left(p_departure_id);
  if v_resumed then
    -- The traveler's own live hold is theirs to reuse.
    v_seats_left := v_seats_left + coalesce((
      select h.seats from public.seat_holds h
      where h.booking_id = v_booking_id and h.expires_at > now()
    ), 0);
  end if;
  if v_count > v_seats_left then
    return jsonb_build_object(
      'ok', false, 'reason', 'not_enough_seats', 'seats_left', greatest(v_seats_left, 0)
    );
  end if;

  v_expires_at := now() + make_interval(mins => p_hold_minutes);

  if v_resumed then
    delete from public.policy_acceptances where booking_id = v_booking_id;
    delete from public.travelers where booking_id = v_booking_id;
    update public.bookings
    set traveler_count = v_count,
        total_cents = d.price_cents * v_count
    where id = v_booking_id;
  else
    -- References skip 0, O, 1 and I. The unique constraint is the backstop.
    loop
      select 'AA-' || string_agg(
        substr('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 1 + floor(random() * 32)::integer, 1), ''
      )
      into v_reference
      from generate_series(1, 4);
      exit when not exists (select 1 from public.bookings b where b.reference = v_reference);
    end loop;

    insert into public.bookings (
      departure_id, reference, access_token_hash, status,
      traveler_count, total_cents, source
    )
    values (
      p_departure_id, v_reference, p_access_token_hash, 'pending',
      v_count, d.price_cents * v_count, left(p_source, 40)
    )
    returning id into v_booking_id;
  end if;

  insert into public.travelers (booking_id, first_name, last_name, email, phone, is_lead, answers)
  select
    v_booking_id,
    t ->> 'first_name',
    t ->> 'last_name',
    nullif(lower(t ->> 'email'), ''),
    nullif(t ->> 'phone', ''),
    coalesce((t ->> 'is_lead')::boolean, false),
    coalesce(t -> 'answers', '{}'::jsonb)
  from jsonb_array_elements(p_travelers) t;

  select tr.id into v_lead_id
  from public.travelers tr
  where tr.booking_id = v_booking_id and tr.is_lead;

  update public.bookings set lead_traveler_id = v_lead_id where id = v_booking_id;

  insert into public.policy_acceptances (booking_id, traveler_id, policy_version_id, ip, user_agent)
  values (v_booking_id, v_lead_id, d.policy_version_id, p_ip, left(p_user_agent, 500));

  insert into public.seat_holds (departure_id, booking_id, seats, expires_at)
  values (p_departure_id, v_booking_id, v_count, v_expires_at)
  on conflict (booking_id) do update
    set seats = excluded.seats, expires_at = excluded.expires_at;

  return jsonb_build_object(
    'ok', true,
    'booking_id', v_booking_id,
    'reference', v_reference,
    'expires_at', v_expires_at,
    'resumed', v_resumed
  );
end;
$$;

-- What a traveler sees about their own booking, found by reference plus the
-- hash of their access token. No emails or phone numbers.
create function public.booking_summary(p_reference text, p_access_token_hash text)
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
    'paid_cents', b.paid_cents,
    'deposit_due_cents', d.deposit_cents * b.traveler_count,
    'hold_expires_at', h.expires_at,
    'hold_active', coalesce(h.expires_at > now(), false),
    'departure_id', d.id,
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

-- Server code only. Supabase grants execute on new public functions to the
-- API roles by default; take that away.
revoke all on function public.departure_seats_left(uuid) from public, anon, authenticated;
revoke all on function public.bookable_departures() from public, anon, authenticated;
revoke all on function public.departure_for_booking(uuid, text) from public, anon, authenticated;
revoke all on function public.create_booking(
  uuid, text, uuid, jsonb, text, inet, text, text, uuid, integer
) from public, anon, authenticated;
revoke all on function public.booking_summary(text, text) from public, anon, authenticated;

grant execute on function public.departure_seats_left(uuid) to service_role;
grant execute on function public.bookable_departures() to service_role;
grant execute on function public.departure_for_booking(uuid, text) to service_role;
grant execute on function public.create_booking(
  uuid, text, uuid, jsonb, text, inet, text, text, uuid, integer
) to service_role;
grant execute on function public.booking_summary(text, text) to service_role;
