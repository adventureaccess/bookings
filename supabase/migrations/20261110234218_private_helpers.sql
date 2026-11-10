-- Move the staff helpers out of the API-exposed public schema.
--
-- Supabase exposes every function in public at /rest/v1/rpc/<name>. These
-- three are security definer, and the security advisor flags them as callable
-- by anyone. They only ever describe the caller, but they have no business
-- being an API. Policies keep working: they reference the functions by
-- identity, not by name, and the API roles keep execute rights.

create schema if not exists private;
grant usage on schema private to anon, authenticated, service_role;

alter function public.staff_role() set schema private;
alter function public.is_staff() set schema private;
alter function public.can_write() set schema private;

-- The bodies called each other through public; point them at private.
create or replace function private.is_staff()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return private.staff_role() is not null;
end;
$$;

create or replace function private.can_write()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return coalesce(private.staff_role() in ('admin', 'staff'), false);
end;
$$;
