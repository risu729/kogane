interface Env {
  MONEYFORWARD_CREDENTIAL_JSON: string;
  ADMIN_TRIGGER_TOKEN: string;
  /** Optional: the account identity key (ADR 0027), 64 lowercase hex. */
  MONEYFORWARD_ACCOUNT_IDENTITY_KEY?: string;
}
