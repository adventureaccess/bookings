-- Milestone 5: a group's own itinerary.
--
-- A tour in the library carries a template itinerary. Staff copy it onto a
-- departure and edit it for that group; from then on it belongs to the
-- departure. Travelers see it on the group's page, through
-- departure_for_booking, never by reading the table.

create type public.itinerary_item_kind as enum ('highlight', 'day');

-- The tour's template: a list of {kind, day_label, title, body_md, image_url}.
alter table public.trips
  add column itinerary jsonb not null default '[]'::jsonb,
  add constraint trips_itinerary_array check (jsonb_typeof(itinerary) = 'array');

-- A staff label for a group trip, such as "Hulsey family". Travelers never see it.
alter table public.departures
  add column group_name text,
  add constraint departures_group_name_length check (
    group_name is null or length(group_name) between 1 and 120
  );

create table public.itinerary_items (
  id uuid primary key default gen_random_uuid(),
  departure_id uuid not null references public.departures (id) on delete cascade,
  position integer not null,
  kind public.itinerary_item_kind not null default 'day',
  -- "Day 1", "Days 3–5". Empty for a highlight.
  day_label text not null default '',
  title text not null,
  body_md text not null default '',
  image_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint itinerary_items_title_length check (length(btrim(title)) between 1 and 200),
  constraint itinerary_items_day_label_length check (length(day_label) <= 40),
  constraint itinerary_items_body_length check (length(body_md) <= 8000),
  constraint itinerary_items_image_absolute check (
    image_url is null or (image_url ~ '^https://' and length(image_url) <= 500)
  )
);

create index itinerary_items_departure_idx on public.itinerary_items (departure_id, position);

create trigger set_updated_at before update on public.itinerary_items
  for each row execute function public.set_updated_at();

alter table public.itinerary_items enable row level security;
alter table public.itinerary_items force row level security;
revoke all on public.itinerary_items from anon, authenticated;
grant all on public.itinerary_items to service_role;
grant select on public.itinerary_items to authenticated;

create policy itinerary_items_staff_read on public.itinerary_items
  for select to authenticated using (private.is_staff());

-- Replaces a departure's whole itinerary in one step, for "copy from the
-- tour" and "copy from another departure". Items keep the order given.
create function public.replace_itinerary(p_departure_id uuid, p_items jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_rows integer;
begin
  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'items must be a list' using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_array_length(p_items) > 60 then
    raise exception 'at most 60 itinerary items' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from public.departures d where d.id = p_departure_id) then
    raise exception 'departure not found' using errcode = 'no_data_found';
  end if;

  delete from public.itinerary_items where departure_id = p_departure_id;

  insert into public.itinerary_items (departure_id, position, kind, day_label, title, body_md, image_url)
  select
    p_departure_id,
    item.ordinality::integer,
    coalesce(nullif(item.value ->> 'kind', ''), 'day')::public.itinerary_item_kind,
    coalesce(item.value ->> 'day_label', ''),
    item.value ->> 'title',
    coalesce(item.value ->> 'body_md', ''),
    nullif(item.value ->> 'image_url', '')
  from jsonb_array_elements(p_items) with ordinality as item (value, ordinality);
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.replace_itinerary(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.replace_itinerary(uuid, jsonb) to service_role;

-- The booking page now carries the departure's itinerary too.
create or replace function public.departure_for_booking(p_departure_id uuid, p_key text)
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
    'itinerary', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'kind', i.kind,
          'day_label', i.day_label,
          'title', i.title,
          'body_md', i.body_md,
          'image_url', i.image_url
        )
        order by i.position, i.created_at
      )
      from public.itinerary_items i
      where i.departure_id = d.id
    ), '[]'::jsonb),
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
