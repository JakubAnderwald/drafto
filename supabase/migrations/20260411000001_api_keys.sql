-- API keys for MCP (Model Context Protocol) server authentication.
-- Users generate keys from the web UI; only hashed values are stored.

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  key_prefix text not null,        -- first 8 chars, for display identification
  key_hash text not null,          -- SHA-256 hex digest of the full key
  name text not null default '',   -- user-provided label
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

-- Fast lookup by hash during authentication
create unique index idx_api_keys_key_hash on public.api_keys (key_hash);

-- List keys for a user
create index idx_api_keys_user_id on public.api_keys (user_id);

-- RLS
alter table public.api_keys enable row level security;

-- Users can read their own keys
create policy "Users can read own api_keys"
  on public.api_keys for select
  using (auth.uid() = user_id and public.is_approved());

-- Users can create their own keys
create policy "Users can create own api_keys"
  on public.api_keys for insert
  with check (auth.uid() = user_id and public.is_approved());

-- Users can update their own keys (for revoking)
create policy "Users can update own api_keys"
  on public.api_keys for update
  using (auth.uid() = user_id and public.is_approved());

-- Users can delete their own keys
create policy "Users can delete own api_keys"
  on public.api_keys for delete
  using (auth.uid() = user_id and public.is_approved());
