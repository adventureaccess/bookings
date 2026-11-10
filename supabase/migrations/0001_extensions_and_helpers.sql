-- Extensions, the updated_at trigger, and the staff helpers used by RLS.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- Keeps updated_at honest on every table.
create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create type public.staff_role as enum ('admin', 'staff', 'read_only');

-- The role of the signed-in user, or null if they are not in the staff table.
-- Security definer so policies can call it without granting anyone read
-- access to the staff table itself. plpgsql, so the staff table (created in
-- 0004) only has to exist when the function first runs.
create function public.staff_role()
returns public.staff_role
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  claimed_email text := lower(nullif(auth.jwt() ->> 'email', ''));
  found public.staff_role;
begin
  if claimed_email is null then
    return null;
  end if;
  select s.role into found from public.staff s where s.email = claimed_email;
  return found;
end;
$$;

create function public.is_staff()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return public.staff_role() is not null;
end;
$$;

-- True for the roles allowed to change departures and policy versions.
create function public.can_write()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return coalesce(public.staff_role() in ('admin', 'staff'), false);
end;
$$;
