-- Per-request client tagging for note_content_history.archived_by.
--
-- ADR 0023 (docs/adr/0023-per-request-client-tagging.md): every Supabase
-- client sends an x-drafto-client HTTP header (e.g. 'web', 'desktop-macos',
-- 'mobile-ios', 'mobile-android', 'web-cron', 'web-mcp'). PostgREST runs
-- the function below before each request, copying the header into the
-- transaction-local GUC `app.client`. The trigger from
-- 20260425000001_note_content_history.sql then reads that GUC into
-- note_content_history.archived_by, giving every future content overwrite
-- a client attribution.
--
-- Soft-failure semantics: a missing or empty header leaves app.client
-- unset (still NULL via nullif in the trigger). We do not error on
-- untagged requests — observability must not block legitimate writes.

-- =============================================================================
-- PRE-REQUEST FUNCTION
-- =============================================================================

create or replace function public.set_request_app_client()
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  client_tag text;
begin
  -- request.headers is a JSON object PostgREST exposes per request.
  -- current_setting(..., true) returns NULL if the GUC is unset (e.g. when
  -- the function is invoked outside a PostgREST context, like a direct
  -- psql session); we treat that as 'no tag' rather than erroring.
  begin
    client_tag := current_setting('request.headers', true)::jsonb->>'x-drafto-client';
  exception when others then
    client_tag := null;
  end;

  -- Transaction-local: scoped to the current PostgREST transaction, never
  -- leaks across requests. Empty string and NULL both result in app.client
  -- staying empty, which the trigger normalizes to NULL via nullif.
  perform set_config('app.client', coalesce(client_tag, ''), true);
end;
$$;

comment on function public.set_request_app_client() is
  'PostgREST pre_request hook. Copies x-drafto-client request header into '
  'app.client GUC for the current transaction so the note_content_history '
  'trigger can record which client wrote a content overwrite. See ADR 0023.';

-- =============================================================================
-- WIRE INTO POSTGREST
-- =============================================================================

-- The authenticator role is the one PostgREST connects as; setting the
-- pgrst.db_pre_request GUC on it makes PostgREST invoke the function on
-- every incoming request.
alter role authenticator set pgrst.db_pre_request = 'public.set_request_app_client';

-- Ask PostgREST to reload its config so the change applies without a
-- restart. Idempotent and safe to run multiple times.
notify pgrst, 'reload config';
