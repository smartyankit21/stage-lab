-- Stage Lab: watchlists and trade journal.
-- Run once in Supabase: SQL Editor -> New query -> paste all of this -> Run.
-- Safe to run again; it only creates what is missing.
--
-- Every row belongs to the signed-in user (user_id). Row-level security means a
-- person can only ever read or change their own rows, even though the website
-- and its public key are open to anyone.

create table if not exists public.watchlists (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  name        text not null check (char_length(name) between 1 and 60),
  position    int  not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.watchlist_items (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users on delete cascade,
  list_id      uuid not null references public.watchlists on delete cascade,
  key          text not null,                 -- e.g. 'NSE:RELIANCE' or 'BSE:500325'
  note         text,
  added_on     date not null default current_date,
  added_price  numeric,                       -- price on the day it was added
  created_at   timestamptz not null default now(),
  unique (list_id, key)
);

create table if not exists public.trades (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users on delete cascade,
  key          text not null,
  side         text not null default 'long' check (side in ('long', 'short')),
  entry_date   date not null,
  entry_price  numeric not null check (entry_price > 0),
  qty          numeric not null check (qty > 0),
  stop         numeric check (stop > 0),
  target       numeric check (target > 0),
  exit_date    date,
  exit_price   numeric check (exit_price > 0),
  setup        text,                          -- e.g. 'VCP', 'Stage 2 entry'
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (exit_date is null or exit_date >= entry_date),
  check ((exit_date is null) = (exit_price is null))
);

create index if not exists watchlist_items_list on public.watchlist_items (list_id);
create index if not exists trades_user on public.trades (user_id, entry_date desc);

alter table public.watchlists      enable row level security;
alter table public.watchlist_items enable row level security;
alter table public.trades          enable row level security;

drop policy if exists "own rows" on public.watchlists;
drop policy if exists "own rows" on public.watchlist_items;
drop policy if exists "own rows" on public.trades;
create policy "own rows" on public.watchlists      for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own rows" on public.watchlist_items for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid()
    and exists (select 1 from public.watchlists w where w.id = list_id and w.user_id = auth.uid()));
create policy "own rows" on public.trades          for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists trades_touch on public.trades;
create trigger trades_touch before update on public.trades
  for each row execute function public.touch_updated_at();
