-- =============================================================================
-- NEW-SIGNUP WEBHOOK
-- =============================================================================
-- Fires on INSERT into public.profiles, POSTs the new row to the web app so it
-- can send the admin notification email. Idempotent and safe to apply on any
-- project — the trigger no-ops if either 'webhook_url' or 'webhook_secret'
-- is missing from Supabase Vault.
--
-- Setup (one-time per project):
--   select vault.create_secret('<WEBHOOK_URL>',    'webhook_url');
--   select vault.create_secret('<WEBHOOK_SECRET>', 'webhook_secret');
-- Rotate by updating the vault secret; no code change needed.
-- =============================================================================

create extension if not exists pg_net with schema extensions;

create or replace function public.notify_admin_new_signup()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  webhook_url text;
  webhook_secret text;
begin
  select decrypted_secret into webhook_url
  from vault.decrypted_secrets
  where name = 'webhook_url'
  limit 1;

  select decrypted_secret into webhook_secret
  from vault.decrypted_secrets
  where name = 'webhook_secret'
  limit 1;

  if webhook_url is null or webhook_secret is null then
    return new;
  end if;

  perform net.http_post(
    url := webhook_url,
    body := jsonb_build_object(
      'type', 'INSERT',
      'table', 'profiles',
      'schema', 'public',
      'record', to_jsonb(new)
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', webhook_secret
    ),
    timeout_milliseconds := 5000
  );

  return new;
end;
$$;

drop trigger if exists on_profile_insert_notify_admin on public.profiles;
create trigger on_profile_insert_notify_admin
  after insert on public.profiles
  for each row execute function public.notify_admin_new_signup();
