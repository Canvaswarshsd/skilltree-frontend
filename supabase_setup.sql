-- Run this in Supabase SQL Editor (one-time).
-- Table that stores shared maps as JSON + metadata for LRU eviction.

create table if not exists public.taskmap_shares (
  id text primary key,
  state jsonb not null,
  bytes_total bigint not null default 0,
  created_at timestamptz not null default now(),
  last_access_at timestamptz not null default now(),
  access_count bigint not null default 0
);

create index if not exists taskmap_shares_last_access_idx
  on public.taskmap_shares (last_access_at asc);

