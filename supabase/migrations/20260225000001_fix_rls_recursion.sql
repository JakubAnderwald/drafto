-- Fix infinite RLS recursion on profiles table
-- Problem: "Admins can read all profiles" policy queries profiles, triggering
-- its own RLS evaluation → infinite recursion (PostgreSQL error 42P17).
-- All other tables that check is_approved via subquery on profiles are affected too.
--
-- Solution: SECURITY DEFINER helper functions bypass RLS for admin/approval checks.

-- =============================================================================
-- HELPER FUNCTIONS (SECURITY DEFINER — bypass RLS)
-- =============================================================================

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and is_admin = true
  );
$$;

create or replace function public.is_approved()
returns boolean
language sql
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and is_approved = true
  );
$$;

-- =============================================================================
-- PROFILES — fix admin policies to use helper functions
-- =============================================================================

drop policy if exists "Admins can read all profiles" on public.profiles;
create policy "Admins can read all profiles"
  on public.profiles for select
  using (public.is_admin());

drop policy if exists "Admins can update all profiles" on public.profiles;
create policy "Admins can update all profiles"
  on public.profiles for update
  using (public.is_admin());

-- =============================================================================
-- NOTEBOOKS — replace inline subqueries with is_approved()
-- =============================================================================

drop policy if exists "Users can read own notebooks" on public.notebooks;
create policy "Users can read own notebooks"
  on public.notebooks for select
  using (auth.uid() = user_id and public.is_approved());

drop policy if exists "Users can insert own notebooks" on public.notebooks;
create policy "Users can insert own notebooks"
  on public.notebooks for insert
  with check (auth.uid() = user_id and public.is_approved());

drop policy if exists "Users can update own notebooks" on public.notebooks;
create policy "Users can update own notebooks"
  on public.notebooks for update
  using (auth.uid() = user_id and public.is_approved());

drop policy if exists "Users can delete own notebooks" on public.notebooks;
create policy "Users can delete own notebooks"
  on public.notebooks for delete
  using (auth.uid() = user_id and public.is_approved());

-- =============================================================================
-- NOTES — replace inline subqueries with is_approved()
-- =============================================================================

drop policy if exists "Users can read own notes" on public.notes;
create policy "Users can read own notes"
  on public.notes for select
  using (auth.uid() = user_id and public.is_approved());

drop policy if exists "Users can insert own notes" on public.notes;
create policy "Users can insert own notes"
  on public.notes for insert
  with check (
    auth.uid() = user_id
    and public.is_approved()
    and exists (
      select 1 from public.notebooks n
      where n.id = notebook_id and n.user_id = auth.uid()
    )
  );

drop policy if exists "Users can update own notes" on public.notes;
create policy "Users can update own notes"
  on public.notes for update
  using (auth.uid() = user_id and public.is_approved())
  with check (
    auth.uid() = user_id
    and public.is_approved()
    and exists (
      select 1 from public.notebooks n
      where n.id = notebook_id and n.user_id = auth.uid()
    )
  );

drop policy if exists "Users can delete own notes" on public.notes;
create policy "Users can delete own notes"
  on public.notes for delete
  using (auth.uid() = user_id and public.is_approved());

-- =============================================================================
-- ATTACHMENTS — replace inline subqueries with is_approved()
-- =============================================================================

drop policy if exists "Users can read own attachments" on public.attachments;
create policy "Users can read own attachments"
  on public.attachments for select
  using (auth.uid() = user_id and public.is_approved());

drop policy if exists "Users can insert own attachments" on public.attachments;
create policy "Users can insert own attachments"
  on public.attachments for insert
  with check (
    auth.uid() = user_id
    and public.is_approved()
    and exists (
      select 1 from public.notes n
      where n.id = note_id and n.user_id = auth.uid()
    )
  );

drop policy if exists "Users can delete own attachments" on public.attachments;
create policy "Users can delete own attachments"
  on public.attachments for delete
  using (auth.uid() = user_id and public.is_approved());
