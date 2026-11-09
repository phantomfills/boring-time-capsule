-- The 10pm Room: database setup.
-- Paste this whole file into the Supabase SQL editor and press Run.
-- It's safe to run again later; it replaces the functions and policies each time.
--
-- Everything time-related happens here, on the server's clock, so changing the
-- clock on your own computer doesn't let you in early.


-- When the door opens (UK wall-clock time) and for how long.
-- To test at another time of day, change '22:00' here, re-run just this
-- function, then change it back afterwards.
create or replace function public.door_open_time()
returns time language sql immutable as $$ select time '22:00' $$;

create or replace function public.door_length()
returns interval language sql immutable as $$ select interval '15 minutes' $$;


-- Where the door stands at instant t: open or not, the current or next opening,
-- and which "night" that opening belongs to. Times come back as epoch
-- milliseconds so the browser can use them directly.
create or replace function public.door_status_at(t timestamptz)
returns json language plpgsql stable as $$
declare
  local_now timestamp := t at time zone 'Europe/London';
  opens_l   timestamp;
  closes_l  timestamp;
begin
  -- the most recent opening at or before now
  opens_l := date_trunc('day', local_now) + (public.door_open_time() - time '00:00');
  if local_now < opens_l then
    opens_l := opens_l - interval '1 day';
  end if;
  closes_l := opens_l + public.door_length();

  -- already closed again? then look at the next one
  if local_now >= closes_l then
    opens_l  := opens_l + interval '1 day';
    closes_l := opens_l + public.door_length();
  end if;

  return json_build_object(
    'open',         local_now >= opens_l and local_now < closes_l,
    'now_ms',       floor(extract(epoch from t) * 1000),
    'opens_at_ms',  floor(extract(epoch from (opens_l  at time zone 'Europe/London')) * 1000),
    'closes_at_ms', floor(extract(epoch from (closes_l at time zone 'Europe/London')) * 1000),
    'night',        opens_l::date
  );
end $$;

create or replace function public.door_status()
returns json language sql stable as $$ select public.door_status_at(now()) $$;

create or replace function public.is_open()
returns boolean language sql stable as $$
  select (public.door_status()->>'open')::boolean
$$;


-- The notes people leave.
create table if not exists public.messages (
  id         bigint generated always as identity primary key,
  body       text not null check (char_length(body) between 1 and 140),
  created_at timestamptz not null default now(),
  night      date not null
);

-- No posting the exact same note twice in one night.
create unique index if not exists messages_once_per_night
  on public.messages (night, lower(body));


-- Runs before every new note: tidies it, stamps the time and night from the
-- server, and stops the wall growing past 300 notes a night.
create or replace function public.prepare_message()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.body       := btrim(new.body);
  new.created_at := now();
  new.night      := (public.door_status()->>'night')::date;

  if (select count(*) from public.messages where night = new.night) >= 300 then
    raise exception 'The wall is full for tonight.' using errcode = 'P0001';
  end if;

  return new;
end $$;

drop trigger if exists prepare_message on public.messages;
create trigger prepare_message
  before insert on public.messages
  for each row execute function public.prepare_message();


-- Who can do what. The website uses the public "anon" key, so these rules are
-- the only thing standing between a visitor and the table.
alter table public.messages enable row level security;

revoke all on public.messages from anon, authenticated;
grant select (id, body, created_at, night) on public.messages to anon, authenticated;
grant insert (body) on public.messages to anon, authenticated;

grant execute on function public.door_status() to anon, authenticated;

-- Notes can only be read while the door is open, and only the ones from the
-- last day (so tonight's and last night's).
drop policy if exists "read while open" on public.messages;
create policy "read while open" on public.messages
  for select to anon, authenticated
  using ((select public.is_open()) and created_at > now() - interval '25 hours');

-- Notes can only be written while the door is open.
drop policy if exists "write while open" on public.messages;
create policy "write while open" on public.messages
  for insert to anon, authenticated
  with check ((select public.is_open()));
