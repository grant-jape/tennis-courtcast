-- Accounts, favorite courts, and live "how many courts are open?" checks.
--
-- Pattern (same as court_votes / court_comments): row-level security decides who can
-- touch which rows, and the database (never the browser) decides who wrote something.
-- Raw check-ins and presence are private; the public only sees the aggregate returned
-- by court_activity(), which never says *who* is at a court and hides a count of one.

-- ---------- profiles: one row per account, with an editable display name ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 40),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "Read your own profile" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
create policy "Edit your own profile" on public.profiles
  for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;   -- only the name is editable

-- New account (Google or email) -> profile, named from what Google or the sign-up form gave us.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, left(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', '')), 40))
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
-- Existing accounts get a profile too.
insert into public.profiles (id, display_name)
select id, left(btrim(coalesce(raw_user_meta_data ->> 'full_name', raw_user_meta_data ->> 'name', '')), 40)
from auth.users on conflict (id) do nothing;

-- Comments are signed with the profile name (first word only, as before).
create or replace function public.stamp_comment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare meta jsonb; pname text;
begin
  select display_name into pname from public.profiles where id = auth.uid();
  select raw_user_meta_data into meta from auth.users where id = auth.uid();
  new.user_id := auth.uid();
  new.user_name := left(split_part(coalesce(nullif(btrim(pname), ''), meta ->> 'full_name', meta ->> 'name', 'Player'), ' ', 1), 40);
  new.created_at := now();
  return new;
end $$;

-- Renaming yourself renames your past comments too.
create function public.rename_comments() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.display_name is distinct from old.display_name and btrim(new.display_name) <> '' then
    update public.court_comments set user_name = left(split_part(btrim(new.display_name), ' ', 1), 40)
    where user_id = new.id;
  end if;
  return new;
end $$;
create trigger rename_comments after update on public.profiles
  for each row execute function public.rename_comments();

-- ---------- favorite courts (private to each player) ----------
create table public.favorite_courts (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  court_id text not null check (char_length(court_id) between 1 and 80),
  created_at timestamptz not null default now(),
  primary key (user_id, court_id)
);
alter table public.favorite_courts enable row level security;
create policy "See your own favorites" on public.favorite_courts
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Add your own favorites" on public.favorite_courts
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Remove your own favorites" on public.favorite_courts
  for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on public.favorite_courts from anon, authenticated;
grant select, insert, delete on public.favorite_courts to authenticated;

-- ---------- court checks: "how many courts are open right now?" ----------
-- Kept as history (it later becomes "usually full by 8:40 on Saturdays"), but only
-- readable by the player who sent it. Written through report_court() only.
create table public.court_reports (
  id bigint generated always as identity primary key,
  court_id text not null check (char_length(court_id) between 1 and 80),
  user_id uuid not null references auth.users(id) on delete cascade,
  open_courts text not null check (open_courts in ('none', 'one', 'some', 'all')),
  created_at timestamptz not null default now()
);
create index court_reports_court_time on public.court_reports (court_id, created_at desc);
create index court_reports_user on public.court_reports (user_id);
alter table public.court_reports enable row level security;
create policy "See your own court checks" on public.court_reports
  for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.court_reports from anon, authenticated;
grant select on public.court_reports to authenticated;

-- Who is at which court right now: one row per player, overwritten, purged after 3 hours.
-- No policies at all: only the functions below can read or write it.
create table public.court_presence (
  user_id uuid primary key references auth.users(id) on delete cascade,
  court_id text not null check (char_length(court_id) between 1 and 80),
  seen_at timestamptz not null default now()
);
create index court_presence_court_time on public.court_presence (court_id, seen_at);
alter table public.court_presence enable row level security;
revoke all on public.court_presence from anon, authenticated;

-- "I'm at this court" (the site calls this when the phone is within ~200 m of a court).
create function public.ping_court(p_court_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return; end if;
  delete from public.court_presence where seen_at < now() - interval '3 hours';
  insert into public.court_presence (user_id, court_id, seen_at) values (auth.uid(), p_court_id, now())
  on conflict (user_id) do update set court_id = excluded.court_id, seen_at = excluded.seen_at;
end $$;

-- One-tap report. A second tap within 10 minutes corrects the first instead of adding another,
-- so one player can't flood a court with reports.
create function public.report_court(p_court_id text, p_open text) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); recent bigint;
begin
  if uid is null then raise exception 'Sign in to report' using errcode = '28000'; end if;
  select id into recent from public.court_reports
   where user_id = uid and court_id = p_court_id and created_at > now() - interval '10 minutes'
   order by created_at desc limit 1;
  if recent is not null then
    update public.court_reports set open_courts = p_open, created_at = now() where id = recent;
  else
    insert into public.court_reports (court_id, user_id, open_courts) values (p_court_id, uid, p_open);
  end if;
  perform public.ping_court(p_court_id);
end $$;

-- What everyone sees: per court, the latest report in the last 90 minutes, how many reports,
-- and how many players are there now (only when 2 or more, so nobody is singled out).
create function public.court_activity()
returns table (court_id text, open_courts text, reported_at timestamptz, reports int, here_now int)
language sql stable security definer set search_path = '' as $$
  with latest as (
    select distinct on (r.court_id) r.court_id, r.open_courts, r.created_at
    from public.court_reports r where r.created_at > now() - interval '90 minutes'
    order by r.court_id, r.created_at desc
  ), counts as (
    select r.court_id, count(*)::int n from public.court_reports r
    where r.created_at > now() - interval '90 minutes' group by r.court_id
  ), here as (
    select p.court_id, count(*)::int n from public.court_presence p
    where p.seen_at > now() - interval '20 minutes' group by p.court_id having count(*) >= 2
  )
  select coalesce(l.court_id, h.court_id), l.open_courts, l.created_at, coalesce(c.n, 0), h.n
  from latest l
  full join here h on h.court_id = l.court_id
  left join counts c on c.court_id = coalesce(l.court_id, h.court_id);
$$;

-- Self-serve account deletion. Every table above (and votes/comments) cascades from auth.users.
create function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '28000'; end if;
  delete from auth.users where id = auth.uid();
end $$;

-- Functions are callable only by the people who should call them.
revoke execute on function public.handle_new_user(), public.rename_comments(),
  public.ping_court(text), public.report_court(text, text), public.court_activity(),
  public.delete_my_account() from public, anon, authenticated;
grant execute on function public.ping_court(text), public.report_court(text, text),
  public.delete_my_account() to authenticated;
grant execute on function public.court_activity() to anon, authenticated;
