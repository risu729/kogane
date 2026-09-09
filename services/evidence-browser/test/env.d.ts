declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    /** JSON object of the host process' KOGANE_LOAD* variables; see test/load.test.ts. */
    KOGANE_LOAD_CONFIG: string;
  }
}
