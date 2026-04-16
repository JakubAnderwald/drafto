-- Performance: composite index for the main note list query
--
-- Query: SELECT id, title, created_at, updated_at FROM notes
--        WHERE user_id = ? AND notebook_id = ? AND is_trashed = false
--        ORDER BY updated_at DESC
--
-- Partial index (WHERE is_trashed = false) matches the filter exactly.
-- updated_at DESC in the index avoids a separate sort step.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notes_notebook_user_active
  ON public.notes (user_id, notebook_id, updated_at DESC)
  WHERE is_trashed = false;

-- Performance: mark RLS helper functions as STABLE so PostgreSQL caches
-- the result within a single statement instead of calling per-row.
CREATE OR REPLACE FUNCTION public.is_approved()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND is_approved = true
  );
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND is_admin = true
  );
$$;
