-- Staff status requires a Google sign-in, not just a matching email.
--
-- Supabase can also create accounts by email and password. If that provider
-- were ever left on without email confirmation, anyone could sign up with a
-- staff address and receive a token carrying that email. app_metadata is set
-- by Supabase and cannot be edited by the user, so require that the account
-- was created through Google.

create or replace function private.staff_role()
returns public.staff_role
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  claims jsonb := auth.jwt();
  claimed_email text := lower(nullif(claims ->> 'email', ''));
  found public.staff_role;
begin
  if claimed_email is null then
    return null;
  end if;
  if coalesce(claims -> 'app_metadata' ->> 'provider', '') <> 'google' then
    return null;
  end if;
  select s.role into found from public.staff s where s.email = claimed_email;
  return found;
end;
$$;
