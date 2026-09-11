export default {
  async fetch(): Promise<Response> {
    return Response.json(
      { enabled: false, reason: "probe secrets and final code not deployed" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  },
} satisfies ExportedHandler;
