-- Milestone 8: rate limits.
--
-- A counter per key per fixed window of time, kept in the rate_limits table
-- from milestone 1. The key is a scope plus a hash of the caller's address,
-- never the address itself. Counting and checking happen in one statement,
-- so two requests at the same instant cannot both slip under the limit.

-- Counts this request and says whether it is allowed.
-- Returns true while the caller is at or under p_limit in the current window.
create function public.check_rate_limit(p_key text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_window timestamptz;
  v_count integer;
begin
  if p_key is null or p_key = '' or p_limit < 1 or p_window_seconds < 1 then
    raise exception 'a rate limit needs a key, a limit and a window'
      using errcode = 'invalid_parameter_value';
  end if;

  v_window := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into public.rate_limits as r (key, window_start, count)
  values (left(p_key, 200), v_window, 1)
  on conflict (key, window_start) do update set count = r.count + 1
  returning r.count into v_count;

  return v_count <= p_limit;
end;
$$;

-- Housekeeping: counters older than a day are of no use.
create function public.delete_old_rate_limits()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_rows integer;
begin
  delete from public.rate_limits where window_start < now() - interval '1 day';
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.check_rate_limit(text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.delete_old_rate_limits() from public, anon, authenticated;
grant execute on function public.check_rate_limit(text, integer, integer) to service_role;
grant execute on function public.delete_old_rate_limits() to service_role;
