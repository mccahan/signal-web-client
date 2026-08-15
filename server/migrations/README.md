# Migrations

Applied automatically at startup, in numeric order, each in its own
transaction. Run once and recorded in the `schema_migrations` table.

## Adding one

Create the next-numbered file here:

- `002-add-thing.sql` — executed as-is
- `002-backfill-thing.mjs` — exports `up(db)`, for changes SQL can't express
  (data transforms, conditional `ALTER`, anything needing a query first)

`.mjs`, not `.js`: a `.js` file is only treated as ESM if the nearest
`package.json` says so, which makes loading depend on where the file sits.

## Rules

- **Never edit an applied migration.** Its checksum is recorded, and a change
  is reported on the next boot. Add a new migration instead.
- Ids must be unique; a duplicate is a startup error rather than a coin toss
  about which one runs.
- Write them to be safe against a database that already has the change, so a
  half-finished upgrade can be retried.
- A failure rolls that migration back and aborts the run — the server refuses
  to start rather than serving from a half-migrated database.
- A snapshot is written to the backups directory before any migration is
  applied to an existing database.
