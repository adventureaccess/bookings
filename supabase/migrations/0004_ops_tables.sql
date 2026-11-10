-- Staff allowlist, activity log, webhook idempotency, the sync queue and
-- Postgres-backed rate limits.

create type public.sync_job_kind as enum ('hubspot', 'email');

create table public.staff (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  role public.staff_role not null default 'read_only',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint staff_email_lowercase check (email = lower(email)),
  constraint staff_email_domain check (email like '%@adventure-access.com')
);

create table public.activity_log (
  id uuid primary key default gen_random_uuid(),
  actor text not null,
  entity text not null,
  entity_id uuid,
  action text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index activity_log_entity_idx on public.activity_log (entity, entity_id);
create index activity_log_created_at_idx on public.activity_log (created_at desc);

-- The event ID is stored before any work happens; a duplicate insert means
-- the event was already seen.
create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  stripe_event_id text not null unique,
  type text not null,
  processed_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.sync_jobs (
  id uuid primary key default gen_random_uuid(),
  kind public.sync_job_kind not null,
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  last_error text,
  next_run_at timestamptz default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sync_jobs_attempts_non_negative check (attempts >= 0)
);

-- next_run_at is null once a job is finished, so the worker's scan stays small.
create index sync_jobs_next_run_at_idx on public.sync_jobs (next_run_at)
  where next_run_at is not null;

create table public.rate_limits (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rate_limits_key_window unique (key, window_start),
  constraint rate_limits_count_non_negative check (count >= 0)
);

create index rate_limits_window_start_idx on public.rate_limits (window_start);

create trigger set_updated_at before update on public.staff
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.activity_log
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.webhook_events
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.sync_jobs
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.rate_limits
  for each row execute function public.set_updated_at();
