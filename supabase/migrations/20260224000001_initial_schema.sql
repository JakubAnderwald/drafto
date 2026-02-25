-- Drafto initial schema
-- Tables: profiles, notebooks, notes, attachments
-- RLS policies for row-level security
-- Trigger: auto-create profile on auth.users insert

-- =============================================================================
-- PROFILES
-- Extends auth.users with app-specific fields
-- =============================================================================
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  is_approved boolean not null default false,
  is_admin boolean not null default false,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Users can read their own profile
create policy "Users can read own profile"
  on public.profiles for select
  using (auth.uid() = id);

-- Users can update their own profile (but not is_approved or is_admin)
create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Admins can read all profiles (for approval flow)
create policy "Admins can read all profiles"
  on public.profiles for select
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_admin = true
    )
  );

-- Admins can update all profiles (for approval)
create policy "Admins can update all profiles"
  on public.profiles for update
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_admin = true
    )
  );

-- =============================================================================
-- NOTEBOOKS
-- =============================================================================
create table public.notebooks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.notebooks enable row level security;

-- Only approved users can access their own notebooks
create policy "Users can read own notebooks"
  on public.notebooks for select
  using (
    auth.uid() = user_id
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_approved = true
    )
  );

create policy "Users can insert own notebooks"
  on public.notebooks for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_approved = true
    )
  );

create policy "Users can update own notebooks"
  on public.notebooks for update
  using (
    auth.uid() = user_id
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_approved = true
    )
  );

create policy "Users can delete own notebooks"
  on public.notebooks for delete
  using (
    auth.uid() = user_id
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_approved = true
    )
  );

-- =============================================================================
-- NOTES
-- =============================================================================
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  notebook_id uuid not null references public.notebooks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Untitled',
  content jsonb,
  is_trashed boolean not null default false,
  trashed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.notes enable row level security;

create policy "Users can read own notes"
  on public.notes for select
  using (
    auth.uid() = user_id
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_approved = true
    )
  );

create policy "Users can insert own notes"
  on public.notes for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_approved = true
    )
    and exists (
      select 1 from public.notebooks n
      where n.id = notebook_id and n.user_id = auth.uid()
    )
  );

create policy "Users can update own notes"
  on public.notes for update
  using (
    auth.uid() = user_id
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_approved = true
    )
  )
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_approved = true
    )
    and exists (
      select 1 from public.notebooks n
      where n.id = notebook_id and n.user_id = auth.uid()
    )
  );

create policy "Users can delete own notes"
  on public.notes for delete
  using (
    auth.uid() = user_id
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_approved = true
    )
  );

-- =============================================================================
-- ATTACHMENTS
-- =============================================================================
create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.notes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  file_name text not null,
  file_path text not null,
  file_size bigint not null,
  mime_type text not null,
  created_at timestamptz not null default now()
);

alter table public.attachments enable row level security;

create policy "Users can read own attachments"
  on public.attachments for select
  using (
    auth.uid() = user_id
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_approved = true
    )
  );

create policy "Users can insert own attachments"
  on public.attachments for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_approved = true
    )
    and exists (
      select 1 from public.notes n
      where n.id = note_id and n.user_id = auth.uid()
    )
  );

create policy "Users can delete own attachments"
  on public.attachments for delete
  using (
    auth.uid() = user_id
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_approved = true
    )
  );

-- =============================================================================
-- INDEXES
-- =============================================================================
create index idx_notebooks_user_id on public.notebooks(user_id);
create index idx_notes_notebook_id on public.notes(notebook_id);
create index idx_notes_user_id on public.notes(user_id);
create index idx_notes_trashed on public.notes(is_trashed, trashed_at) where is_trashed = true;
create index idx_attachments_note_id on public.attachments(note_id);
create index idx_attachments_user_id on public.attachments(user_id);

-- =============================================================================
-- UPDATED_AT TRIGGER
-- =============================================================================
create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger on_profiles_updated
  before update on public.profiles
  for each row execute function public.handle_updated_at();

create trigger on_notebooks_updated
  before update on public.notebooks
  for each row execute function public.handle_updated_at();

create trigger on_notes_updated
  before update on public.notes
  for each row execute function public.handle_updated_at();

-- =============================================================================
-- AUTO-CREATE PROFILE ON SIGNUP
-- =============================================================================
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id)
  values (new.id);
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_catalog;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
