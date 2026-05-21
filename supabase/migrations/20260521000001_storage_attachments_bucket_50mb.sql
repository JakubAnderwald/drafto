-- Raise the attachments bucket per-file limit from 25MB to 50MB
-- (50 * 1024 * 1024 = 52428800). 50MB is the Supabase Free tier per-file
-- ceiling, so this is the largest bump available without a paid plan change.
update storage.buckets
  set file_size_limit = 52428800
  where id = 'attachments';
