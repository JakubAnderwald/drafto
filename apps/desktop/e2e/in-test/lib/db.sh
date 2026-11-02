#!/bin/bash
# Read-only queries against the app's WatermelonDB (the sandbox container of
# the TestFlight build, eu.drafto.mobile). Never opened for writing.

WDB="$HOME/Library/Containers/eu.drafto.mobile/Data/Documents/watermelon.db"

db_q() { sqlite3 -readonly -cmd ".timeout 3000" "file:$WDB?mode=ro" "$1" 2> /dev/null; }

# Empty when this database has never completed a pull.
db_last_pulled() { db_q "select value from local_storage where key = '__watermelon_last_pulled_at'"; }

db_count() { db_q "select count(*) from $1"; }

# Local changes the server does not have yet. An attachment whose file has not
# uploaded counts too: its row is skipped by the push yet still marked synced,
# and sign-out deletes local attachment files.
db_pending() {
  db_q "select (select count(*) from notes where _status != 'synced')
             + (select count(*) from notebooks where _status != 'synced')
             + (select count(*) from attachments
                where _status != 'synced' or coalesce(upload_status, '') != 'uploaded')"
}

db_note_title() { db_q "select title from notes where id = '$1' or remote_id = '$1' limit 1"; }

# Markers are [a-z0-9] only, so they are safe inside LIKE.
db_has_marker() { [ "$(db_q "select count(*) from notes where content like '%$1%'")" -gt 0 ] 2> /dev/null; }

# db_marker_in_notebook <marker> <notebook name> — the marker's note sits in that notebook.
db_marker_in_notebook() {
  [ "$(db_q "select count(*) from notes n join notebooks b on b.id = n.notebook_id
             where b.name = '$2' and n.content like '%$1%'")" -gt 0 ] 2> /dev/null
}
