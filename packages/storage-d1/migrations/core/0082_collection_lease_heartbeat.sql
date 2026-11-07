-- When a held collection execution lease last proved its holder alive
-- (ADR 0085). The holder writes it on D1's clock with the claim and every
-- minute while its action runs; the Processor's tick frees a lease whose
-- heartbeat is older than ten minutes. Additive only: a lease held before this
-- migration has NULL here and is judged by `started_at` instead. Releases clear
-- it, but a release written by an older build may leave it behind on a free
-- lease, so it is not tied to `lease_ref` here; a later claim by an older
-- build keeps that heartbeat, which is then older than its `started_at`, and
-- the tick judges such a lease by `started_at` too. The table stays
-- operational-mutable (CORE 0065).
ALTER TABLE collection_execution_leases ADD COLUMN heartbeat_at TEXT
 CHECK(heartbeat_at IS NULL OR length(heartbeat_at)=24);
