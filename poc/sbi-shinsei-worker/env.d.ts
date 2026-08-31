// Wrangler generates all configured bindings in worker-configuration.d.ts.
// Dashboard secrets are not present in wrangler.jsonc, so this declaration
// only augments the generated Env with their names.
interface Env {
  SBI_SHINSEI_CREDENTIAL_JSON: string;
  ADMIN_TRIGGER_TOKEN: string;
  RELAY_TOKEN: string;
}
