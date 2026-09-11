# READ migrations

The READ database (`kogane-read`, binding `READ`) is built from its own
versioned SQL, kept apart from CORE so that no job can apply or reset the
wrong database (unified plan 06 §2, 09 §2, decision D3).

`0001_read_baseline.sql` is that schema: the rebuildable balance projection of
U11, its snapshot-scoped relations and copied CORE references, and the
operational state of the builds. It is applied through
`services/processor/wrangler.read-migrations.jsonc`, a configuration
that exists only for this step, because wrangler takes one `migrations_dir` per
configuration and the processor's own points at CORE. See
`docs/read-model-d1.md` and `docs/read-rebuild-runbook.md`.

Rules that already hold:

- CORE migrations live in `../core/` and are immutable once applied. READ
  migrations start again at `0001` and never renumber CORE.
- Only the deploy job applies migrations to production. Tests apply them from
  these directories, never from a checked-in schema dump.
- A destructive READ change rebuilds an empty READ from the latest schema; it
  never edits an applied file.
