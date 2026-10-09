-- Apply only to the newly approved throwaway synthetic database, after CORE.
-- Not a CORE migration and never part of the production migration directory.
CREATE TABLE conformance_run (
 id INTEGER PRIMARY KEY CHECK(id=1),
 corpus_digest TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('running','passed','failed')),
 report_json TEXT
);
