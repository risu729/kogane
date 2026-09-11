# READ migrations

The READ database (`kogane-read`, binding `READ`) is built from its own
versioned SQL, kept apart from CORE so that no job can apply or reset the
wrong database (unified plan 06 §2, 09 §2, decision D3).

This directory is empty on purpose. The first READ migration,
`0001_read_baseline.sql`, lands with the read/write split (U11); until then the
projection keeps living in CORE and there is nothing to apply here.

Rules that already hold:

- CORE migrations live in `../core/` and are immutable once applied. READ
  migrations start again at `0001` and never renumber CORE.
- Only the deploy job applies migrations to production. Tests apply them from
  these directories, never from a checked-in schema dump.
- A destructive READ change rebuilds an empty READ from the latest schema; it
  never edits an applied file.
