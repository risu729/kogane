declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    EVIDENCE: R2Bucket;
    INGEST_CLIENT_KEYS: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
