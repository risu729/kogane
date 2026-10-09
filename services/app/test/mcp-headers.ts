/**
 * The headers an MCP client sends on every POST to `/mcp` (Streamable HTTP,
 * "Sending Messages"): the SDK serving the endpoint refuses a POST without
 * them with `406` or `415`, as the transport specifies.
 */
export const MCP_CLIENT_HEADERS = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
} as const;

/** The `initialize` parameters every MCP client sends (lifecycle, "Initialization"). */
export const INITIALIZE_PARAMS = {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "synthetic-client", version: "0" },
} as const;
