-- note_text_chars(content): how many characters of text a note version holds.
--
-- The product metrics (20261112000002_product_metrics.sql, ADR 0075) count a
-- version as real writing by its text length, not by updated_at, which also
-- moves on title, trash and notebook changes. This sums char_length over every
-- string-valued `text` key anywhere in the editor JSON: BlockNote blocks
-- (`content[].text`, link `content[]`, nested `children`, table cells) and
-- TipTap nodes (`content[].text`) alike. Ids, props, styles, marks and URLs
-- don't count. Null content is 0.
--
-- Strict mode on purpose: lax `$.**` visits an array and then its unwrapped
-- elements, so every text would count twice. `.**` skips the structural errors
-- strict mode would raise for nodes without a `text` key.
--
-- Its own file so scripts/__tests__/note-text-chars.test.mjs can run exactly
-- this SQL in PGlite. Only service_role may call it (docs/features/product-metrics.md).

create or replace function public.note_text_chars(content jsonb)
returns int
language sql
immutable
parallel safe
security invoker
set search_path = public, pg_catalog
as $$
  select coalesce(sum(char_length(t #>> '{}')), 0)::int
  from jsonb_path_query(content, 'strict $.**.text ? (@.type() == "string")') as t
$$;

comment on function public.note_text_chars(jsonb) is
  'Characters of text in a note''s editor JSON: the summed length of every string '
  '`text` key, at any depth. Null content is 0. Metrics only (ADR 0075).';

revoke execute on function public.note_text_chars(jsonb) from public, anon, authenticated;
grant execute on function public.note_text_chars(jsonb) to service_role;
