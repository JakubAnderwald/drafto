-- Create attachments storage bucket with 25MB file size limit
-- Storage policies: authenticated & approved users can manage their own files

-- =============================================================================
-- BUCKET
-- =============================================================================
insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 26214400) -- 25MB = 25 * 1024 * 1024
on conflict (id) do update
set
  name = excluded.name,
  public = excluded.public,
  file_size_limit = excluded.file_size_limit;

-- =============================================================================
-- STORAGE POLICIES
-- Path convention: {user_id}/{note_id}/{filename}
-- Enforced: folder depth = 2 (user_id + note_id), note ownership verified
-- =============================================================================

-- Users can upload files to their own folder
create policy "Users can upload own attachments"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'attachments'
  and (storage.foldername(name))[1] = auth.uid()::text
  and array_length(storage.foldername(name), 1) = 2
  and exists (
    select 1 from public.notes n
    where n.id::text = (storage.foldername(name))[2]
      and n.user_id = auth.uid()
  )
  and exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_approved = true
  )
);

-- Users can read their own files
create policy "Users can read own attachments"
on storage.objects for select
to authenticated
using (
  bucket_id = 'attachments'
  and (storage.foldername(name))[1] = auth.uid()::text
  and array_length(storage.foldername(name), 1) = 2
  and exists (
    select 1 from public.notes n
    where n.id::text = (storage.foldername(name))[2]
      and n.user_id = auth.uid()
  )
  and exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_approved = true
  )
);

-- Users can update their own files (for upserts)
create policy "Users can update own attachments"
on storage.objects for update
to authenticated
using (
  bucket_id = 'attachments'
  and (storage.foldername(name))[1] = auth.uid()::text
  and array_length(storage.foldername(name), 1) = 2
  and exists (
    select 1 from public.notes n
    where n.id::text = (storage.foldername(name))[2]
      and n.user_id = auth.uid()
  )
  and exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_approved = true
  )
);

-- Users can delete their own files
create policy "Users can delete own attachments"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'attachments'
  and (storage.foldername(name))[1] = auth.uid()::text
  and array_length(storage.foldername(name), 1) = 2
  and exists (
    select 1 from public.notes n
    where n.id::text = (storage.foldername(name))[2]
      and n.user_id = auth.uid()
  )
  and exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_approved = true
  )
);
