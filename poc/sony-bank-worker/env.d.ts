// Wrangler generates configured bindings in worker-configuration.d.ts.
// Dashboard secrets are intentionally absent from wrangler.jsonc, so declare
// only their names here.
interface Env {
  SONY_BANK_CREDENTIAL_JSON: string;
  ADMIN_TRIGGER_TOKEN: string;
}
