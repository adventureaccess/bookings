-- Milestone 6: traveler documents and the waiver.
--
-- Two kinds of file a traveler uploads: proof of travel insurance and a
-- passport copy. The files themselves go to a restricted Google Shared
-- Drive; this database keeps only the Drive file ID and the review status.
-- Nothing read from a passport is ever stored here.
--
-- The waiver is a PDF staff upload. It is not personal data, so it is kept
-- here and shown to travelers. Once published it cannot change, because a
-- traveler signs that exact file.

create type public.document_kind as enum ('insurance', 'passport');
create type public.document_status as enum ('submitted', 'accepted', 'rejected');

-- Waiver versions. The PDF is stored as base64 text with its SHA-256, so an
-- acceptance can always be tied to the exact bytes that were signed.
create table public.waiver_versions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  version integer not null unique,
  file_name text not null,
  file_base64 text not null,
  file_sha256 text not null,
  byte_size integer not null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint waiver_versions_version_positive check (version >= 1),
  constraint waiver_versions_title_length check (length(btrim(title)) between 1 and 200),
  constraint waiver_versions_file_name_length check (length(file_name) between 1 and 200),
  constraint waiver_versions_size check (byte_size between 1 and 6000000),
  constraint waiver_versions_sha256 check (file_sha256 ~ '^[0-9a-f]{64}$')
);

create function public.block_published_waiver_changes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.published_at is not null then
    raise exception 'waiver version % is published and cannot be changed', old.version
      using errcode = 'check_violation';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger block_published_waiver_changes
  before update or delete on public.waiver_versions
  for each row execute function public.block_published_waiver_changes();

create trigger set_updated_at before update on public.waiver_versions
  for each row execute function public.set_updated_at();

-- What each departure asks of its travelers.
alter table public.departures
  add column waiver_version_id uuid references public.waiver_versions (id) on delete restrict,
  add column required_documents jsonb not null default '["insurance", "passport"]'::jsonb,
  add constraint departures_required_documents_array check (
    jsonb_typeof(required_documents) = 'array'
  );

create index departures_waiver_version_id_idx on public.departures (waiver_version_id);

-- One row per upload. A traveler who is asked to send a file again gets a
-- new row; the newest row for a traveler and kind is the one that counts.
create table public.traveler_documents (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  traveler_id uuid not null references public.travelers (id) on delete cascade,
  kind public.document_kind not null,
  -- Where the file is. The file itself is never stored here.
  drive_file_id text not null,
  file_name text not null,
  status public.document_status not null default 'submitted',
  note text,
  reviewed_by text,
  reviewed_at timestamptz,
  -- Set when staff have deleted the file from the Shared Drive.
  file_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint traveler_documents_file_id_length check (length(drive_file_id) between 1 and 200),
  constraint traveler_documents_file_name_length check (length(file_name) between 1 and 200),
  constraint traveler_documents_note_length check (note is null or length(note) <= 500),
  constraint traveler_documents_reviewed check (status = 'submitted' or reviewed_by is not null)
);

create index traveler_documents_traveler_idx
  on public.traveler_documents (traveler_id, kind, created_at desc);
create index traveler_documents_booking_idx on public.traveler_documents (booking_id);

create trigger set_updated_at before update on public.traveler_documents
  for each row execute function public.set_updated_at();

-- Each traveler's own signature on a waiver version: their typed name, when,
-- and from where.
create table public.waiver_acceptances (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  traveler_id uuid not null references public.travelers (id) on delete cascade,
  waiver_version_id uuid not null references public.waiver_versions (id) on delete restrict,
  signed_name text not null,
  accepted_at timestamptz not null default now(),
  ip inet,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint waiver_acceptances_once unique (traveler_id, waiver_version_id),
  constraint waiver_acceptances_name_length check (length(btrim(signed_name)) between 2 and 160)
);

create index waiver_acceptances_booking_idx on public.waiver_acceptances (booking_id);
create index waiver_acceptances_version_idx on public.waiver_acceptances (waiver_version_id);

create trigger set_updated_at before update on public.waiver_acceptances
  for each row execute function public.set_updated_at();

-- Row-level security: staff read, only the service role writes.
alter table public.waiver_versions enable row level security;
alter table public.traveler_documents enable row level security;
alter table public.waiver_acceptances enable row level security;
alter table public.waiver_versions force row level security;
alter table public.traveler_documents force row level security;
alter table public.waiver_acceptances force row level security;

revoke all on public.waiver_versions, public.traveler_documents, public.waiver_acceptances
  from anon, authenticated;
grant all on public.waiver_versions, public.traveler_documents, public.waiver_acceptances
  to service_role;
grant select on public.waiver_versions, public.traveler_documents, public.waiver_acceptances
  to authenticated;

create policy waiver_versions_staff_read on public.waiver_versions
  for select to authenticated using (private.is_staff());
create policy traveler_documents_staff_read on public.traveler_documents
  for select to authenticated using (private.is_staff());
create policy waiver_acceptances_staff_read on public.waiver_acceptances
  for select to authenticated using (private.is_staff());

-- What a traveler sees about documents on their own booking: what is asked
-- for, and for each traveler on the booking, where each item stands. Found
-- only by reference plus token hash. It never returns a file or a file ID.
create function public.booking_documents(p_reference text, p_access_token_hash text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'booking_id', b.id,
    'reference', b.reference,
    'status', b.status,
    'required', d.required_documents,
    'waiver', (
      select jsonb_build_object('id', w.id, 'version', w.version, 'title', w.title)
      from public.waiver_versions w
      where w.id = d.waiver_version_id and w.published_at is not null
    ),
    'travelers', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', t.id,
          'first_name', t.first_name,
          'last_name', t.last_name,
          'is_lead', t.is_lead,
          'documents', coalesce((
            select jsonb_object_agg(
              latest.kind,
              jsonb_build_object(
                'status', latest.status,
                'note', latest.note,
                'uploaded_at', latest.created_at
              )
            )
            from (
              select distinct on (td.kind) td.kind, td.status, td.note, td.created_at
              from public.traveler_documents td
              where td.traveler_id = t.id
              order by td.kind, td.created_at desc
            ) latest
          ), '{}'::jsonb),
          'waiver_signed_at', (
            select wa.accepted_at
            from public.waiver_acceptances wa
            where wa.traveler_id = t.id and wa.waiver_version_id = d.waiver_version_id
          )
        )
        order by t.is_lead desc, t.created_at, t.id
      )
      from public.travelers t
      where t.booking_id = b.id
    ), '[]'::jsonb)
  )
  from public.bookings b
  join public.departures d on d.id = b.departure_id
  where b.reference = p_reference
    and b.access_token_hash = p_access_token_hash
$$;

-- Records an upload after the file is safely in the Shared Drive.
-- Returns {"ok": true, "document_id"} or {"ok": false, "reason":
--   "not_found" | "closed" | "not_your_traveler" | "not_required"}.
create function public.record_document(
  p_reference text,
  p_access_token_hash text,
  p_traveler_id uuid,
  p_kind public.document_kind,
  p_drive_file_id text,
  p_file_name text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_booking_id uuid;
  v_status public.booking_status;
  v_required jsonb;
  v_document_id uuid;
begin
  select b.id, b.status, d.required_documents
  into v_booking_id, v_status, v_required
  from public.bookings b
  join public.departures d on d.id = b.departure_id
  where b.reference = p_reference and b.access_token_hash = p_access_token_hash;
  if v_booking_id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_status in ('canceled', 'refunded') then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  if not exists (
    select 1 from public.travelers t where t.id = p_traveler_id and t.booking_id = v_booking_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'not_your_traveler');
  end if;
  if not (v_required ? p_kind::text) then
    return jsonb_build_object('ok', false, 'reason', 'not_required');
  end if;

  insert into public.traveler_documents (booking_id, traveler_id, kind, drive_file_id, file_name)
  values (v_booking_id, p_traveler_id, p_kind, p_drive_file_id, left(p_file_name, 200))
  returning id into v_document_id;

  return jsonb_build_object('ok', true, 'document_id', v_document_id);
end;
$$;

-- A traveler signs the waiver attached to their departure. Signing twice
-- keeps the first signature.
-- Returns {"ok": true, "signed_at"} or {"ok": false, "reason":
--   "not_found" | "closed" | "not_your_traveler" | "waiver_changed"}.
create function public.sign_waiver(
  p_reference text,
  p_access_token_hash text,
  p_traveler_id uuid,
  p_waiver_version_id uuid,
  p_signed_name text,
  p_ip inet,
  p_user_agent text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_booking_id uuid;
  v_status public.booking_status;
  v_waiver_id uuid;
  v_signed_at timestamptz;
begin
  select b.id, b.status, w.id
  into v_booking_id, v_status, v_waiver_id
  from public.bookings b
  join public.departures d on d.id = b.departure_id
  left join public.waiver_versions w
    on w.id = d.waiver_version_id and w.published_at is not null
  where b.reference = p_reference and b.access_token_hash = p_access_token_hash;
  if v_booking_id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_status in ('canceled', 'refunded') then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  if not exists (
    select 1 from public.travelers t where t.id = p_traveler_id and t.booking_id = v_booking_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'not_your_traveler');
  end if;
  -- They must sign the waiver that is attached right now.
  if v_waiver_id is null or v_waiver_id is distinct from p_waiver_version_id then
    return jsonb_build_object('ok', false, 'reason', 'waiver_changed');
  end if;

  insert into public.waiver_acceptances (
    booking_id, traveler_id, waiver_version_id, signed_name, ip, user_agent
  )
  values (
    v_booking_id, p_traveler_id, v_waiver_id, btrim(p_signed_name), p_ip, left(p_user_agent, 500)
  )
  on conflict (traveler_id, waiver_version_id) do nothing;

  select wa.accepted_at into v_signed_at
  from public.waiver_acceptances wa
  where wa.traveler_id = p_traveler_id and wa.waiver_version_id = v_waiver_id;

  return jsonb_build_object('ok', true, 'signed_at', v_signed_at);
end;
$$;

-- A published waiver's PDF, for showing to travelers. Drafts are not served.
create function public.waiver_file(p_waiver_version_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('file_name', w.file_name, 'file_base64', w.file_base64)
  from public.waiver_versions w
  where w.id = p_waiver_version_id and w.published_at is not null
$$;

-- Server code only.
revoke all on function public.booking_documents(text, text) from public, anon, authenticated;
revoke all on function public.record_document(
  text, text, uuid, public.document_kind, text, text
) from public, anon, authenticated;
revoke all on function public.sign_waiver(text, text, uuid, uuid, text, inet, text)
  from public, anon, authenticated;
revoke all on function public.waiver_file(uuid) from public, anon, authenticated;

grant execute on function public.booking_documents(text, text) to service_role;
grant execute on function public.record_document(
  text, text, uuid, public.document_kind, text, text
) to service_role;
grant execute on function public.sign_waiver(text, text, uuid, uuid, text, inet, text)
  to service_role;
grant execute on function public.waiver_file(uuid) to service_role;
