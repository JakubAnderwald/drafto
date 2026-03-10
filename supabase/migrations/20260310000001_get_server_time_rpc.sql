-- RPC function to return the current server timestamp.
-- Used by mobile sync to avoid clock skew between client and server.
CREATE OR REPLACE FUNCTION get_server_time()
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT now();
$$;
