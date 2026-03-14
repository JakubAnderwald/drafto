-- Helper: extract all text values from JSONB content (BlockNote/TipTap JSON)
create or replace function extract_text_from_jsonb(content jsonb)
returns text
language sql
immutable
as $$
  select coalesce(
    string_agg(value::text, ' '),
    ''
  )
  from jsonb_path_query(content, 'strict $.**.text') as value
$$;

-- RPC: search notes for the authenticated user
create or replace function search_notes(search_query text)
returns table (
  id uuid,
  title text,
  notebook_id uuid,
  is_trashed boolean,
  trashed_at timestamptz,
  updated_at timestamptz,
  content_snippet text
)
language sql
security invoker
stable
as $$
  select
    n.id,
    n.title,
    n.notebook_id,
    n.is_trashed,
    n.trashed_at,
    n.updated_at,
    substring(
      extract_text_from_jsonb(n.content::jsonb),
      greatest(1, position(lower(search_query) in lower(extract_text_from_jsonb(n.content::jsonb))) - 40),
      100
    ) as content_snippet
  from notes n
  where n.user_id = auth.uid()
    and (
      n.title ilike '%' || search_query || '%'
      or extract_text_from_jsonb(n.content::jsonb) ilike '%' || search_query || '%'
    )
  order by
    case when n.title ilike '%' || search_query || '%' then 0 else 1 end,
    n.updated_at desc
  limit 50
$$;
