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
  with note_text as (
    select
      n.*,
      extract_text_from_jsonb(n.content) as extracted_text
    from notes n
    where n.user_id = auth.uid()
  )
  select
    nt.id,
    nt.title,
    nt.notebook_id,
    nt.is_trashed,
    nt.trashed_at,
    nt.updated_at,
    substring(
      nt.extracted_text,
      greatest(1, position(lower(search_query) in lower(nt.extracted_text)) - 40),
      100
    ) as content_snippet
  from note_text nt
  where
    nt.title ilike '%' || search_query || '%'
    or nt.extracted_text ilike '%' || search_query || '%'
  order by
    case when nt.title ilike '%' || search_query || '%' then 0 else 1 end,
    nt.updated_at desc
  limit 50
$$;
