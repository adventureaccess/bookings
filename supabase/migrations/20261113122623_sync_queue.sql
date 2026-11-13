-- Milestone 7: the sync queue.
--
-- HubSpot updates and emails never happen while a traveler waits. Things
-- that should cause one are noticed by triggers, which add a row to
-- sync_jobs inside the same transaction as the change. A worker takes the
-- rows later, and a failure is retried with a growing delay.
--
-- A job is:
--   waiting    completed_at and failed_at are both null; next_run_at says when
--   done       completed_at is set
--   given up   failed_at is set, after too many attempts; staff can retry it

alter table public.sync_jobs
  add column booking_id uuid references public.bookings (id) on delete set null,
  add column completed_at timestamptz,
  add column failed_at timestamptz;

create index sync_jobs_booking_id_idx on public.sync_jobs (booking_id);
create index sync_jobs_failed_idx on public.sync_jobs (failed_at) where failed_at is not null;

-- Some booking changes are made by Postgres itself, as the owner of the
-- tables: when a traveler row is deleted, the foreign key clears
-- bookings.lead_traveler_id. The triggers below then run as that owner. With
-- row-level security forced, even the owner needs a policy to write the
-- queue, unless it happens to bypass RLS. Do not depend on that.
do $$
begin
  execute format(
    'create policy sync_jobs_owner_write on public.sync_jobs for all to %I using (true) with check (true)',
    current_user
  );
end;
$$;

-- Adds a job. A HubSpot job always sends the booking as it is when it runs,
-- so if one is already waiting and has not started, another is not needed.
create function public.enqueue_sync_job(
  p_kind public.sync_job_kind,
  p_booking_id uuid,
  p_payload jsonb
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_kind = 'hubspot' and exists (
    select 1 from public.sync_jobs j
    where j.kind = 'hubspot'
      and j.booking_id = p_booking_id
      and j.completed_at is null
      and j.failed_at is null
      and j.attempts = 0
  ) then
    return;
  end if;
  insert into public.sync_jobs (kind, booking_id, payload)
  values (p_kind, p_booking_id, coalesce(p_payload, '{}'::jsonb));
end;
$$;

-- A new booking: tell HubSpot and tell staff.
create function public.sync_on_booking_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform public.enqueue_sync_job('hubspot', new.id, '{}'::jsonb);
  perform public.enqueue_sync_job(
    'email', new.id, jsonb_build_object('template', 'staff_new_booking')
  );
  return new;
end;
$$;

create trigger sync_on_booking_insert
  after insert on public.bookings
  for each row execute function public.sync_on_booking_insert();

-- A booking changed: tell HubSpot. Money arrived: thank the traveler and
-- tell staff. The place was confirmed: tell the traveler.
-- Writing the HubSpot deal ID back onto the booking does not count as a
-- change, or the sync would trigger itself forever.
create function public.sync_on_booking_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.status, new.paid_cents, new.discount_cents, new.traveler_count, new.total_cents, new.lead_traveler_id)
     is distinct from
     (old.status, old.paid_cents, old.discount_cents, old.traveler_count, old.total_cents, old.lead_traveler_id)
  then
    perform public.enqueue_sync_job('hubspot', new.id, '{}'::jsonb);
  end if;

  if new.paid_cents > old.paid_cents then
    perform public.enqueue_sync_job('email', new.id, jsonb_build_object(
      'template', 'traveler_payment_received',
      'amount_cents', new.paid_cents - old.paid_cents
    ));
    perform public.enqueue_sync_job('email', new.id, jsonb_build_object(
      'template', 'staff_payment_received',
      'amount_cents', new.paid_cents - old.paid_cents
    ));
  end if;

  if old.status = 'pending' and new.status in ('deposit_paid', 'paid_in_full') then
    perform public.enqueue_sync_job(
      'email', new.id, jsonb_build_object('template', 'traveler_booking_confirmed')
    );
  end if;
  return new;
end;
$$;

create trigger sync_on_booking_update
  after update on public.bookings
  for each row execute function public.sync_on_booking_update();

-- A document was handed in: tell staff. Only the kind goes into the job;
-- nothing about the file.
create function public.sync_on_document_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform public.enqueue_sync_job('email', new.booking_id, jsonb_build_object(
    'template', 'staff_document_received',
    'document_kind', new.kind
  ));
  return new;
end;
$$;

create trigger sync_on_document_insert
  after insert on public.traveler_documents
  for each row execute function public.sync_on_document_insert();

-- The email that carries a traveler's booking link. The link holds their
-- access token, which is stored nowhere else in readable form, so the worker
-- removes it from the job as soon as the email is sent.
create function public.enqueue_booking_link_email(
  p_booking_id uuid,
  p_template text,
  p_url text
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_template not in ('traveler_registered', 'traveler_new_link') then
    raise exception 'unknown link template' using errcode = 'invalid_parameter_value';
  end if;
  insert into public.sync_jobs (kind, booking_id, payload)
  values ('email', p_booking_id, jsonb_build_object('template', p_template, 'url', p_url));
end;
$$;

-- The worker takes one or more waiting jobs. Taking a job counts as an
-- attempt and pushes its next run into the future, so a worker that dies
-- halfway leaves the job to be tried again later, never lost and never run
-- twice at once.
-- Delay after attempt 1, 2, 3...: 2 min, 10 min, 30 min, 2 h, 6 h, 12 h.
create function public.claim_sync_jobs(p_kinds public.sync_job_kind[], p_limit integer)
returns setof public.sync_jobs
language sql
set search_path = ''
as $$
  update public.sync_jobs j
  set attempts = j.attempts + 1,
      next_run_at = now() + make_interval(
        mins => (array[2, 10, 30, 120, 360, 720])[least(j.attempts + 1, 6)]
      )
  where j.id in (
    select w.id
    from public.sync_jobs w
    where w.completed_at is null
      and w.failed_at is null
      and w.next_run_at <= now()
      and w.kind = any (p_kinds)
    order by w.next_run_at, w.created_at
    limit greatest(p_limit, 0)
    for update skip locked
  )
  returning j.*
$$;

-- The job worked. A link email's link is removed from the stored job.
create function public.complete_sync_job(p_job_id uuid)
returns void
language sql
set search_path = ''
as $$
  update public.sync_jobs
  set completed_at = now(), next_run_at = null, last_error = null, payload = payload - 'url'
  where id = p_job_id
$$;

-- The job failed. It stays waiting for its next run, unless it has now been
-- tried p_max_attempts times: then it is given up and staff are told, once.
-- Returns true when the job was given up.
create function public.fail_sync_job(p_job_id uuid, p_error text, p_max_attempts integer)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  j public.sync_jobs%rowtype;
begin
  update public.sync_jobs
  set last_error = left(coalesce(p_error, 'unknown error'), 300)
  where id = p_job_id
  returning * into j;
  if not found or j.attempts < p_max_attempts then
    return false;
  end if;

  update public.sync_jobs
  set failed_at = now(), next_run_at = null, payload = payload - 'url'
  where id = p_job_id;

  -- Do not send a failure notice about a failure notice.
  if j.payload ->> 'template' is distinct from 'staff_sync_failed' then
    insert into public.sync_jobs (kind, booking_id, payload)
    values ('email', j.booking_id, jsonb_build_object(
      'template', 'staff_sync_failed',
      'failed_kind', j.kind,
      'failed_template', j.payload ->> 'template'
    ));
  end if;
  return true;
end;
$$;

-- Staff ask for a job to be tried again from the start.
create function public.retry_sync_job(p_job_id uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_rows integer;
begin
  update public.sync_jobs
  set attempts = 0, failed_at = null, next_run_at = now()
  where id = p_job_id and completed_at is null;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

-- Server code only.
revoke all on function public.enqueue_sync_job(public.sync_job_kind, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.sync_on_booking_insert() from public, anon, authenticated;
revoke all on function public.sync_on_booking_update() from public, anon, authenticated;
revoke all on function public.sync_on_document_insert() from public, anon, authenticated;
revoke all on function public.enqueue_booking_link_email(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.claim_sync_jobs(public.sync_job_kind[], integer)
  from public, anon, authenticated;
revoke all on function public.complete_sync_job(uuid) from public, anon, authenticated;
revoke all on function public.fail_sync_job(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.retry_sync_job(uuid) from public, anon, authenticated;

grant execute on function public.enqueue_sync_job(public.sync_job_kind, uuid, jsonb) to service_role;
grant execute on function public.sync_on_booking_insert() to service_role;
grant execute on function public.sync_on_booking_update() to service_role;
grant execute on function public.sync_on_document_insert() to service_role;
grant execute on function public.enqueue_booking_link_email(uuid, text, text) to service_role;
grant execute on function public.claim_sync_jobs(public.sync_job_kind[], integer) to service_role;
grant execute on function public.complete_sync_job(uuid) to service_role;
grant execute on function public.fail_sync_job(uuid, text, integer) to service_role;
grant execute on function public.retry_sync_job(uuid) to service_role;
