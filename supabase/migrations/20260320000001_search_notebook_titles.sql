-- Extend search_notes to also match notebook names.
-- Notes in a matching notebook are returned alongside title/content matches.
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
      nb.name as notebook_name,
      extract_text_from_jsonb(n.content) as extracted_text
    from notes n
    join notebooks nb on nb.id = n.notebook_id
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
    or nt.notebook_name ilike '%' || search_query || '%'
    or nt.extracted_text ilike '%' || search_query || '%'
  order by
    case
      when nt.title ilike '%' || search_query || '%' then 0
      when nt.notebook_name ilike '%' || search_query || '%' then 1
      else 2
    end,
    nt.updated_at desc
  limit 50
$$;
