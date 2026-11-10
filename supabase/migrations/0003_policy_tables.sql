-- Policy versions (immutable once published) and who accepted which one.

create table public.policy_versions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body_md text not null,
  version integer not null unique,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint policy_versions_version_positive check (version >= 1)
);

-- A traveler agreed to exact words. Once published, those words cannot be
-- edited or deleted; publish a new version instead.
create function public.block_published_policy_changes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.published_at is not null then
    raise exception 'policy version % is published and cannot be changed', old.version
      using errcode = 'check_violation';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger block_published_policy_changes
  before update or delete on public.policy_versions
  for each row execute function public.block_published_policy_changes();

create trigger set_updated_at before update on public.policy_versions
  for each row execute function public.set_updated_at();

alter table public.departures
  add column policy_version_id uuid references public.policy_versions (id) on delete restrict;

create index departures_policy_version_id_idx on public.departures (policy_version_id);

create table public.policy_acceptances (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  traveler_id uuid not null references public.travelers (id) on delete cascade,
  policy_version_id uuid not null references public.policy_versions (id) on delete restrict,
  accepted_at timestamptz not null default now(),
  ip inet,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint policy_acceptances_once unique (booking_id, traveler_id, policy_version_id)
);

create index policy_acceptances_traveler_id_idx on public.policy_acceptances (traveler_id);
create index policy_acceptances_policy_version_id_idx
  on public.policy_acceptances (policy_version_id);

create trigger set_updated_at before update on public.policy_acceptances
  for each row execute function public.set_updated_at();
