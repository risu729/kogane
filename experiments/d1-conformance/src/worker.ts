import { corpusDigest } from "./corpus.generated.ts";
import { runConformance } from "./runner.ts";

export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
  async scheduled(_controller, env) {
    // The reviewed corpus digest is a non-secret activation pin. No run can
    // start using the committed disabled config; no HTTP path invokes it.
    if (env.RUN_AUTHORIZATION !== corpusDigest) return;
    const reservation = await env.DB.prepare(`INSERT INTO conformance_run(id,corpus_digest,state)
      SELECT 1,?,'running' WHERE NOT EXISTS(SELECT 1 FROM conformance_run WHERE id=1)`)
      .bind(corpusDigest)
      .run();
    if (reservation.meta.changes === 0) return;
    try {
      const report = await runConformance(env.DB, "remote-d1");
      await env.DB.prepare(
        "UPDATE conformance_run SET state=?,report_json=? WHERE id=1 AND corpus_digest=?",
      )
        .bind(report.passed ? "passed" : "failed", JSON.stringify(report), corpusDigest)
        .run();
      console.log(
        JSON.stringify({
          code: "synthetic_d1_conformance_complete",
          passed: report.passed,
          corpusDigest,
        }),
      );
    } catch {
      await env.DB.prepare(
        "UPDATE conformance_run SET state='failed',report_json=? WHERE id=1 AND corpus_digest=?",
      )
        .bind(
          JSON.stringify({ code: "synthetic_d1_conformance_failed", corpusDigest }),
          corpusDigest,
        )
        .run();
      console.log(JSON.stringify({ code: "synthetic_d1_conformance_failed", corpusDigest }));
    }
  },
} satisfies ExportedHandler<Env>;
