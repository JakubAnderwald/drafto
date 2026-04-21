-- =============================================================================
-- NEW-SIGNUP WEBHOOK — HARDENING
-- =============================================================================
-- Replaces the function body from 20260421000001 with two improvements:
--   1. Wraps Vault reads in an exception handler so a Vault outage, permission
--      change, or misconfig cannot abort the INSERT on public.profiles. Signup
--      must never fail because the notification side-effect is unhappy.
--   2. Narrows the JSON payload to the explicit columns the webhook consumer
--      reads (id, is_approved, display_name) instead of shipping the full
--      profiles row via to_jsonb(new). Prevents future columns from silently
--      leaking outbound.
-- Trigger itself is unchanged.
-- =============================================================================

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
  begin
    select decrypted_secret into webhook_url
    from vault.decrypted_secrets
    where name = 'webhook_url'
    limit 1;

    select decrypted_secret into webhook_secret
    from vault.decrypted_secrets
    where name = 'webhook_secret'
    limit 1;
  exception when others then
    -- Vault unavailable / misconfigured: skip silently so signup still succeeds.
    return new;
  end;

  if webhook_url is null or webhook_secret is null then
    return new;
  end if;

  perform net.http_post(
    url := webhook_url,
    body := jsonb_build_object(
      'type', 'INSERT',
      'table', 'profiles',
      'schema', 'public',
      'record', jsonb_build_object(
        'id', new.id,
        'is_approved', new.is_approved,
        'display_name', new.display_name
      )
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
