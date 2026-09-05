import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const NOW = 1_788_324_000_000;

async function seed(scope = "a") {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sources (id, provider, display_name) VALUES (?, ?, ?)")
      .bind(`source-${scope}`, "Provider", `Source ${scope}`),
    env.DB.prepare("INSERT INTO producers (id, kind, display_name) VALUES (?, ?, ?)")
      .bind(`producer-${scope}`, "collector", `Producer ${scope}`),
    env.DB.prepare("INSERT INTO producer_sources (producer_id, source_id) VALUES (?, ?)")
      .bind(`producer-${scope}`, `source-${scope}`),
    env.DB.prepare("INSERT INTO ingest_clients (id, display_name) VALUES (?, ?)")
      .bind(`client-${scope}`, `Client ${scope}`),
    env.DB.prepare("INSERT INTO ingest_client_producers (ingest_client_id, producer_id) VALUES (?, ?)")
      .bind(`client-${scope}`, `producer-${scope}`),
    env.DB.prepare(`
      INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id)
      VALUES (?, ?, ?)
    `).bind(`client-${scope}`, `producer-${scope}`, `source-${scope}`),
  ]);
}

async function seedRun(scope = "a") {
  await seed(scope);
  const session = await env.DB.prepare(`
    INSERT INTO acquisition_sessions
      (producer_id, first_recorded_by_client_id, external_id_namespace,
       external_session_id, first_recorded_at_ms)
    VALUES (?, ?, 'test', ?, ?)
    RETURNING id
  `).bind(`producer-${scope}`, `client-${scope}`, `session-${scope}`, NOW)
    .first<{ id: number }>();
  const run = await env.DB.prepare(`
    INSERT INTO fetch_runs
      (acquisition_session_id, producer_id, source_id,
       first_recorded_by_client_id, first_recorded_at_ms)
    VALUES (?, ?, ?, ?, ?)
    RETURNING id
  `).bind(
    session!.id, `producer-${scope}`, `source-${scope}`, `client-${scope}`, NOW
  )
    .first<{ id: number }>();
  return run!.id;
}

async function addTerminal(runId: number, scope: string, declaredCount?: number) {
  await env.DB.prepare(`
    INSERT INTO fetch_run_reports (
      fetch_run_id, report_key, report_kind, recorded_by_client_id,
      normalized_outcome, completed_at_ms, completed_at_basis,
      declared_artifact_count, artifact_count_scope, recorded_at_ms
    ) VALUES (?, 'terminal', 'terminal', ?, 'success', ?, 'manifest', ?, ?, ?)
  `).bind(
    runId,
    `client-${scope}`,
    NOW,
    declaredCount ?? null,
    declaredCount === undefined ? null : "all_catalogued",
    NOW,
  ).run();
}

interface ArtifactFixture {
  key: string;
  sha: string;
  descriptorSha: string;
  role?: string;
  fidelity?: string;
  container?: string;
  lineage?: string;
  pageGroupId?: number;
  pageIndex?: number;
  sequence?: number;
}

async function addArtifact(runId: number, scope: string, fixture: ArtifactFixture) {
  await env.DB.prepare(`
    INSERT INTO raw_objects
      (sha256, byte_size, blob_key, first_stored_at_ms)
    VALUES (?, 3, ?, ?)
  `).bind(fixture.sha, `objects/${fixture.sha.slice(0, 2)}/${fixture.sha}`, NOW).run();
  return (await env.DB.prepare(`
    INSERT INTO fetch_artifacts (
      fetch_run_id, producer_id, source_id, first_ingested_by_client_id,
      page_group_id, page_index, sequence, artifact_key, artifact_role, payload_fidelity, container_kind,
      lineage_disposition, sha256, byte_size, descriptor_version,
      descriptor_sha256, recorded_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 3, 'v1', ?, ?)
    RETURNING id
  `).bind(
    runId,
    `producer-${scope}`,
    `source-${scope}`,
    `client-${scope}`,
    fixture.pageGroupId ?? null,
    fixture.pageIndex ?? null,
    fixture.sequence ?? null,
    fixture.key,
    fixture.role ?? "provider_response",
    fixture.fidelity ?? "exact",
    fixture.container ?? "single",
    fixture.lineage ?? "not_applicable",
    fixture.sha,
    fixture.descriptorSha,
    NOW,
  ).first<{ id: number }>())!.id;
}

async function addInventory(
  runId: number,
  scope: string,
  digest: string,
  items: ArtifactFixture[],
) {
  const inventory = await env.DB.prepare(`
    INSERT INTO run_inventories (
      fetch_run_id, inventory_sha256, expected_artifact_count,
      declaration_basis, created_at_ms, created_by_client_id
    ) VALUES (?, ?, ?, 'directory_scan', ?, ?) RETURNING id
  `).bind(runId, digest, items.length, NOW, `client-${scope}`)
    .first<{ id: number }>();
  for (const item of items) {
    await env.DB.prepare(`
      INSERT INTO run_inventory_items
        (inventory_id, fetch_run_id, artifact_key, sha256, descriptor_sha256)
      VALUES (?, ?, ?, ?, ?)
    `).bind(inventory!.id, runId, item.key, item.sha, item.descriptorSha).run();
  }
  return inventory!.id;
}

async function sealRun(runId: number, inventoryId: number, scope: string) {
  await env.DB.prepare(`
    INSERT INTO fetch_run_seals
      (inventory_id, fetch_run_id, sealed_at_ms, sealed_by_client_id)
    VALUES (?, ?, ?, ?)
  `).bind(inventoryId, runId, NOW, `client-${scope}`).run();
}

describe("0001 raw-evidence schema", () => {
  it("creates the catalogue, integrity indexes, and mutation guards", async () => {
    const rows = await env.DB.prepare(`
      SELECT type, name FROM sqlite_master
      WHERE name IN (
        'fetch_artifacts', 'fetch_run_seals',
        'idx_fetch_run_reports_one_terminal', 'fetch_artifacts_no_update'
      ) ORDER BY name
    `).all<{ type: string; name: string }>();
    expect(rows.results).toEqual([
      { type: "table", name: "fetch_artifacts" },
      { type: "trigger", name: "fetch_artifacts_no_update" },
      { type: "table", name: "fetch_run_seals" },
      { type: "index", name: "idx_fetch_run_reports_one_terminal" },
    ]);
  });

  it("keeps registry rows mutable but acquisition history append-only", async () => {
    const runId = await seedRun("mutation");
    await env.DB.prepare("UPDATE sources SET display_name = ? WHERE id = ?")
      .bind("Renamed", "source-mutation").run();
    await expect(env.DB.prepare("UPDATE fetch_runs SET source_run_key = ? WHERE id = ?")
      .bind("changed", runId).run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("DELETE FROM fetch_runs WHERE id = ?")
      .bind(runId).run()).rejects.toThrow(/append-only/);
  });

  it("rejects producer and ingest-client attribution outside reviewed scopes", async () => {
    await seed("scope-a");
    await seed("scope-b");
    const session = await env.DB.prepare(`
      INSERT INTO acquisition_sessions
        (producer_id, first_recorded_by_client_id, external_id_namespace,
         external_session_id, first_recorded_at_ms)
      VALUES (?, ?, 'test', ?, ?) RETURNING id
    `).bind("producer-scope-a", "client-scope-a", "cross-scope", NOW)
      .first<{ id: number }>();
    await expect(env.DB.prepare(`
      INSERT INTO fetch_runs
        (acquisition_session_id, producer_id, source_id,
         first_recorded_by_client_id, first_recorded_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      session!.id, "producer-scope-a", "source-scope-b", "client-scope-a", NOW
    ).run())
      .rejects.toThrow(/inactive_ingest_route|FOREIGN KEY/);
  });

  it("does not seal an incomplete inventory", async () => {
    const runId = await seedRun("incomplete");
    const inventory = await env.DB.prepare(`
      INSERT INTO run_inventories
        (fetch_run_id, inventory_sha256, expected_artifact_count,
         declaration_basis, created_at_ms, created_by_client_id)
      VALUES (?, ?, 1, 'directory_scan', ?, 'client-incomplete') RETURNING id
    `).bind(runId, "a".repeat(64), NOW).first<{ id: number }>();
    await expect(env.DB.prepare(
      `INSERT INTO fetch_run_seals
        (inventory_id, fetch_run_id, sealed_at_ms, sealed_by_client_id)
       VALUES (?, ?, ?, 'client-incomplete')`
    ).bind(inventory!.id, runId, NOW).run()).rejects.toThrow(/run_inventory_incomplete/);
  });

  it("seals a terminal failed run with a zero-artifact inventory", async () => {
    const runId = await seedRun("empty");
    await env.DB.prepare(`
      INSERT INTO fetch_run_reports (
        fetch_run_id, report_key, report_kind, recorded_by_client_id,
        producer_status, normalized_outcome, completed_at_ms,
        completed_at_basis, recorded_at_ms
      ) VALUES (?, 'terminal', 'terminal', 'client-empty', 'failed',
                'failed', ?, 'manifest', ?)
    `).bind(runId, NOW, NOW).run();
    const inventory = await env.DB.prepare(`
      INSERT INTO run_inventories
        (fetch_run_id, inventory_sha256, expected_artifact_count,
         declaration_basis, created_at_ms, created_by_client_id)
      VALUES (?, ?, 0, 'directory_scan', ?, 'client-empty') RETURNING id
    `).bind(runId, "b".repeat(64), NOW).first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO fetch_run_seals
        (inventory_id, fetch_run_id, sealed_at_ms, sealed_by_client_id)
       VALUES (?, ?, ?, 'client-empty')`
    ).bind(inventory!.id, runId, NOW).run();
    const seal = await env.DB.prepare(
      "SELECT sealed_at_ms FROM fetch_run_seals WHERE inventory_id = ?"
    ).bind(inventory!.id).first<{ sealed_at_ms: number }>();
    expect(seal?.sealed_at_ms).toBe(NOW);
  });

  it("refuses to seal a subset of the run", async () => {
    const scope = "subset";
    const runId = await seedRun(scope);
    await addArtifact(runId, scope, {
      key: "response.json",
      sha: "1".repeat(64),
      descriptorSha: "2".repeat(64),
    });
    await addTerminal(runId, scope, 1);
    const inventory = await env.DB.prepare(`
      INSERT INTO run_inventories (
        fetch_run_id, inventory_sha256, expected_artifact_count,
        declaration_basis, created_at_ms, created_by_client_id
      ) VALUES (?, ?, 0, 'directory_scan', ?, ?) RETURNING id
    `).bind(runId, "3".repeat(64), NOW, `client-${scope}`).first<{ id: number }>();
    await expect(sealRun(runId, inventory!.id, scope))
      .rejects.toThrow(/run_inventory_incomplete/);
  });

  it("models MyJCB redaction followed by re-encoding without retaining secrets", async () => {
    const scope = "myjcb-shape";
    const runId = await seedRun(scope);
    const fixture = {
      key: "statement.html",
      sha: "4".repeat(64),
      descriptorSha: "5".repeat(64),
      role: "sanitized_provider_capture",
      fidelity: "transformed",
      lineage: "source_not_retained_for_security",
    };
    const artifactId = await addArtifact(runId, scope, fixture);
    for (const [index, kind] of ["redacted", "reencoded"].entries()) {
      await env.DB.prepare(`
        INSERT INTO artifact_transform_steps (
          fetch_artifact_id, step_index, step_kind, transformer_id,
          transformer_version, recorded_by_client_id, recorded_at_ms
        ) VALUES (?, ?, ?, 'myjcb-worker', 'v1', ?, ?)
      `).bind(artifactId, index, kind, `client-${scope}`, NOW).run();
    }
    await addTerminal(runId, scope, 1);
    const inventoryId = await addInventory(runId, scope, "6".repeat(64), [fixture]);
    await expect(sealRun(runId, inventoryId, scope)).resolves.toBeUndefined();
  });

  it("models a Vpass self-contained bundle with explicit embedded lineage", async () => {
    const scope = "vpass-shape";
    const runId = await seedRun(scope);
    const fixture = {
      key: "card-001/snapshot.json",
      sha: "7".repeat(64),
      descriptorSha: "8".repeat(64),
      role: "collector_derived",
      fidelity: "transformed",
      container: "bundle",
      lineage: "embedded_source_bytes",
    };
    const artifactId = await addArtifact(runId, scope, fixture);
    for (const [index, kind] of ["bundled", "reencoded"].entries()) {
      await env.DB.prepare(`
        INSERT INTO artifact_transform_steps (
          fetch_artifact_id, step_index, step_kind, transformer_id,
          transformer_version, recorded_by_client_id, recorded_at_ms
        ) VALUES (?, ?, ?, 'vpass-worker', 'v1', ?, ?)
      `).bind(artifactId, index, kind, `client-${scope}`, NOW).run();
    }
    await addTerminal(runId, scope, 1);
    const inventoryId = await addInventory(runId, scope, "9".repeat(64), [fixture]);
    await expect(sealRun(runId, inventoryId, scope)).resolves.toBeUndefined();
  });

  it("keeps unknown legacy provenance representable", async () => {
    const scope = "legacy";
    const runId = await seedRun(scope);
    const fixture = {
      key: "legacy.pdf",
      sha: "a".repeat(64),
      descriptorSha: "b".repeat(64),
      role: "user_capture",
      fidelity: "unknown",
    };
    await addArtifact(runId, scope, fixture);
    await addTerminal(runId, scope, 1);
    const inventoryId = await addInventory(runId, scope, "c".repeat(64), [fixture]);
    await expect(sealRun(runId, inventoryId, scope)).resolves.toBeUndefined();
  });

  it("requires every declared page before sealing", async () => {
    const scope = "pages";
    const runId = await seedRun(scope);
    const group = await env.DB.prepare(`
      INSERT INTO fetch_page_groups (
        fetch_run_id, page_group_key, declared_page_count,
        recorded_by_client_id, recorded_at_ms
      ) VALUES (?, 'history', 2, ?, ?) RETURNING id
    `).bind(runId, `client-${scope}`, NOW).first<{ id: number }>();
    const fixture = {
      key: "page-0.json",
      sha: "d".repeat(64),
      descriptorSha: "e".repeat(64),
      pageGroupId: group!.id,
      pageIndex: 0,
    };
    await addArtifact(runId, scope, fixture);
    await addTerminal(runId, scope, 1);
    const inventoryId = await addInventory(runId, scope, "f".repeat(64), [fixture]);
    await expect(sealRun(runId, inventoryId, scope))
      .rejects.toThrow(/run_inventory_incomplete/);
  });

  it("rejects query values and append-only replacement, but permits guarded replay", async () => {
    const scope = "hardening";
    const runId = await seedRun(scope);
    const fixture = {
      key: "response.json",
      sha: "0".repeat(64),
      descriptorSha: "1".repeat(64),
    };
    const artifactId = await addArtifact(runId, scope, fixture);
    await expect(env.DB.prepare(`
      INSERT INTO artifact_http_metadata (
        fetch_artifact_id, scheme, host, path_template,
        query_names_json, redaction_version
      ) VALUES (?, 'https', 'example.com', '/api', '["token=secret"]', 'v1')
    `).bind(artifactId).run()).rejects.toThrow(/query_name_contains_value/);
    await expect(env.DB.prepare(`
      INSERT OR REPLACE INTO raw_objects
        (sha256, byte_size, blob_key, first_stored_at_ms)
      VALUES (?, 4, 'objects/replaced', ?)
    `).bind(fixture.sha, NOW).run()).rejects.toThrow(/immutable_duplicate_insert/);
    await env.DB.prepare(`
      INSERT INTO raw_objects (sha256, byte_size, blob_key, first_stored_at_ms)
      SELECT ?, 3, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM raw_objects WHERE sha256 = ?)
    `).bind(
      fixture.sha,
      `objects/${fixture.sha.slice(0, 2)}/${fixture.sha}`,
      NOW,
      fixture.sha,
    ).run();
    const count = await env.DB.prepare(
      "SELECT count(*) AS count FROM raw_objects WHERE sha256 = ?"
    ).bind(fixture.sha).first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("blocks OR REPLACE through artifact sequence and page uniqueness", async () => {
    const scope = "replace-secondary";
    const runId = await seedRun(scope);
    await addArtifact(runId, scope, {
      key: "sequence-original.json",
      sha: "2".repeat(64),
      descriptorSha: "3".repeat(64),
      sequence: 0,
    });
    await env.DB.prepare(`
      INSERT INTO raw_objects (sha256, byte_size, blob_key, first_stored_at_ms)
      VALUES (?, 3, ?, ?)
    `).bind("24".repeat(32), `objects/${"24".repeat(32)}`, NOW).run();
    await expect(env.DB.prepare(`
      INSERT OR REPLACE INTO fetch_artifacts (
        fetch_run_id, producer_id, source_id, first_ingested_by_client_id,
        artifact_key, artifact_role, payload_fidelity, container_kind,
        lineage_disposition, sequence, sha256, byte_size,
        descriptor_version, descriptor_sha256, recorded_at_ms
      ) VALUES (?, ?, ?, ?, 'sequence-replacement.json', 'provider_response',
                'exact', 'single', 'not_applicable', 0, ?, 3, 'v1', ?, ?)
    `).bind(
      runId, `producer-${scope}`, `source-${scope}`, `client-${scope}`,
      "24".repeat(32), "25".repeat(32), NOW,
    ).run()).rejects.toThrow(/immutable_duplicate_insert/);

    const group = await env.DB.prepare(`
      INSERT INTO fetch_page_groups (
        fetch_run_id, page_group_key, declared_page_count,
        recorded_by_client_id, recorded_at_ms
      ) VALUES (?, 'history', 2, ?, ?) RETURNING id
    `).bind(runId, `client-${scope}`, NOW).first<{ id: number }>();
    await addArtifact(runId, scope, {
      key: "page-original.json",
      sha: "6".repeat(64),
      descriptorSha: "7".repeat(64),
      pageGroupId: group!.id,
      pageIndex: 0,
    });
    await env.DB.prepare(`
      INSERT INTO raw_objects (sha256, byte_size, blob_key, first_stored_at_ms)
      VALUES (?, 3, ?, ?)
    `).bind("68".repeat(32), `objects/${"68".repeat(32)}`, NOW).run();
    await expect(env.DB.prepare(`
      INSERT OR REPLACE INTO fetch_artifacts (
        fetch_run_id, producer_id, source_id, first_ingested_by_client_id,
        page_group_id, page_index, artifact_key, artifact_role, payload_fidelity,
        container_kind, lineage_disposition, sha256, byte_size,
        descriptor_version, descriptor_sha256, recorded_at_ms
      ) VALUES (?, ?, ?, ?, ?, 0, 'page-replacement.json', 'provider_response',
                'exact', 'single', 'not_applicable', ?, 3, 'v1', ?, ?)
    `).bind(
      runId, `producer-${scope}`, `source-${scope}`, `client-${scope}`,
      group!.id, "68".repeat(32), "69".repeat(32), NOW,
    ).run()).rejects.toThrow(/immutable_duplicate_insert/);

    const artifacts = await env.DB.prepare(`
      SELECT artifact_key FROM fetch_artifacts WHERE fetch_run_id = ? ORDER BY artifact_key
    `).bind(runId).all<{ artifact_key: string }>();
    expect(artifacts.results.map((row) => row.artifact_key)).toEqual([
      "page-original.json", "sequence-original.json",
    ]);
  });

  it("applies the runtime registry migrations and permits reviewed policy revocation", async () => {
    const columns = await env.DB.prepare("PRAGMA table_info(run_inventories)")
      .all<{ name: string }>();
    expect(columns.results.map((row) => row.name)).toContain("inventory_digest_version");
    const aliases = await env.DB.prepare(`
      SELECT external_source_id, source_id FROM source_external_ids
      WHERE producer_id = 'collector-r2-importer' ORDER BY external_source_id
    `).all<{ external_source_id: string; source_id: string }>();
    expect(aliases.results).toEqual([
      { external_source_id: "mobile-suica", source_id: "mobile-suica" },
      { external_source_id: "moneyforward-me", source_id: "moneyforward-me" },
      { external_source_id: "myjcb", source_id: "myjcb" },
      { external_source_id: "prestia-globalpass", source_id: "global-pass" },
      { external_source_id: "sbi-securities", source_id: "sbi-securities" },
      { external_source_id: "sbi-shinsei", source_id: "sbi-shinsei-bank" },
      { external_source_id: "sbi-vc-trade", source_id: "sbi-vc-trade" },
      { external_source_id: "smbc-direct", source_id: "smbc-bank" },
      { external_source_id: "sony-bank", source_id: "sony-bank" },
      { external_source_id: "v-point-pay-email", source_id: "v-point-pay" },
      { external_source_id: "v-point-pay-email-reconciliation", source_id: "v-point" },
    ]);
    const sbiRoute = await env.DB.prepare(`
      SELECT ingest_client_id, producer_id, source_id FROM active_ingest_routes
      WHERE ingest_client_id = 'collector-r2-sbi'
      ORDER BY producer_id, source_id
    `).all<{
      ingest_client_id: string;
      producer_id: string;
      source_id: string;
    }>();
    expect(sbiRoute.results).toEqual([{
      ingest_client_id: "collector-r2-sbi",
      producer_id: "collector-r2-importer",
      source_id: "sbi-securities",
    }]);
    const sbiVcRoute = await env.DB.prepare(`
      SELECT ingest_client_id, producer_id, source_id FROM active_ingest_routes
      WHERE ingest_client_id = 'collector-r2-sbi-vc'
      ORDER BY producer_id, source_id
    `).all<{
      ingest_client_id: string;
      producer_id: string;
      source_id: string;
    }>();
    expect(sbiVcRoute.results).toEqual([{
      ingest_client_id: "collector-r2-sbi-vc",
      producer_id: "collector-r2-importer",
      source_id: "sbi-vc-trade",
    }]);
    const sonyRoute = await env.DB.prepare(`
      SELECT ingest_client_id, producer_id, source_id FROM active_ingest_routes
      WHERE ingest_client_id = 'collector-r2-sony-bank'
      ORDER BY producer_id, source_id
    `).all<{
      ingest_client_id: string;
      producer_id: string;
      source_id: string;
    }>();
    expect(sonyRoute.results).toEqual([{
      ingest_client_id: "collector-r2-sony-bank",
      producer_id: "collector-r2-importer",
      source_id: "sony-bank",
    }]);
    const sbiShinseiRoute = await env.DB.prepare(`
      SELECT ingest_client_id, producer_id, source_id FROM active_ingest_routes
      WHERE ingest_client_id = 'collector-r2-sbi-shinsei'
      ORDER BY producer_id, source_id
    `).all<{
      ingest_client_id: string;
      producer_id: string;
      source_id: string;
    }>();
    expect(sbiShinseiRoute.results).toEqual([{
      ingest_client_id: "collector-r2-sbi-shinsei",
      producer_id: "collector-r2-importer",
      source_id: "sbi-shinsei-bank",
    }]);
    const mobileSuicaRoute = await env.DB.prepare(`
      SELECT ingest_client_id, producer_id, source_id FROM active_ingest_routes
      WHERE ingest_client_id = 'collector-r2-mobile-suica'
      ORDER BY producer_id, source_id
    `).all<{
      ingest_client_id: string;
      producer_id: string;
      source_id: string;
    }>();
    expect(mobileSuicaRoute.results).toEqual([{
      ingest_client_id: "collector-r2-mobile-suica",
      producer_id: "collector-r2-importer",
      source_id: "mobile-suica",
    }]);
    const globalPassRoute = await env.DB.prepare(`
      SELECT ingest_client_id, producer_id, source_id FROM active_ingest_routes
      WHERE ingest_client_id = 'collector-r2-global-pass'
      ORDER BY producer_id, source_id
    `).all<{
      ingest_client_id: string;
      producer_id: string;
      source_id: string;
    }>();
    expect(globalPassRoute.results).toEqual([{
      ingest_client_id: "collector-r2-global-pass",
      producer_id: "collector-r2-importer",
      source_id: "global-pass",
    }]);
    const sbiPolicies = await env.DB.prepare(`
      SELECT template, redaction_version, fingerprint_key_version
      FROM origin_template_policies
      WHERE source_id = 'sbi-securities' AND origin_kind = 'storage' AND active = 1
    `).all<{
      template: string;
      redaction_version: string;
      fingerprint_key_version: string;
    }>();
    expect(sbiPolicies.results).toEqual([{
      template: "raw/sbi-securities/{date}/{run-id}/{artifact}.json",
      redaction_version: "v1",
      fingerprint_key_version: "collector-r2-v1",
    }]);
    const sbiVcPolicies = await env.DB.prepare(`
      SELECT template, redaction_version, fingerprint_key_version
      FROM origin_template_policies
      WHERE source_id = 'sbi-vc-trade' AND origin_kind = 'storage' AND active = 1
    `).all<{
      template: string;
      redaction_version: string;
      fingerprint_key_version: string;
    }>();
    expect(sbiVcPolicies.results).toEqual([{
      template: "raw/sbi-vc-trade/{date}/{run-id}/{artifact}.json",
      redaction_version: "v1",
      fingerprint_key_version: "collector-r2-v1",
    }]);
    const sonyPolicies = await env.DB.prepare(`
      SELECT template, redaction_version, fingerprint_key_version
      FROM origin_template_policies
      WHERE source_id = 'sony-bank' AND origin_kind = 'storage' AND active = 1
    `).all<{
      template: string;
      redaction_version: string;
      fingerprint_key_version: string;
    }>();
    expect(sonyPolicies.results).toEqual([{
      template: "raw/sony-bank/{date}/{run-id}/{artifact}",
      redaction_version: "v1",
      fingerprint_key_version: "collector-r2-v1",
    }]);
    const sbiShinseiPolicies = await env.DB.prepare(`
      SELECT template, redaction_version, fingerprint_key_version
      FROM origin_template_policies
      WHERE source_id = 'sbi-shinsei-bank' AND origin_kind = 'storage' AND active = 1
    `).all<{
      template: string;
      redaction_version: string;
      fingerprint_key_version: string;
    }>();
    expect(sbiShinseiPolicies.results).toEqual([{
      template: "raw/sbi-shinsei/{date}/{run-id}/{artifact}",
      redaction_version: "v1",
      fingerprint_key_version: "collector-r2-v1",
    }]);
    const mobileSuicaPolicies = await env.DB.prepare(`
      SELECT template, redaction_version, fingerprint_key_version
      FROM origin_template_policies
      WHERE source_id = 'mobile-suica' AND origin_kind = 'storage' AND active = 1
    `).all<{
      template: string;
      redaction_version: string;
      fingerprint_key_version: string;
    }>();
    expect(mobileSuicaPolicies.results).toEqual([{
      template: "raw/mobile-suica/{date}/{run-id}/{artifact}",
      redaction_version: "v1",
      fingerprint_key_version: "collector-r2-v1",
    }]);
    const globalPassPolicies = await env.DB.prepare(`
      SELECT template, redaction_version, fingerprint_key_version
      FROM origin_template_policies
      WHERE source_id = 'global-pass' AND origin_kind = 'storage' AND active = 1
    `).all<{
      template: string;
      redaction_version: string;
      fingerprint_key_version: string;
    }>();
    expect(globalPassPolicies.results).toEqual([{
      template: "raw/prestia-globalpass/{date}/{run-id}/{artifact}",
      redaction_version: "v1",
      fingerprint_key_version: "collector-r2-v1",
    }]);
    await env.DB.prepare(`
      UPDATE origin_template_policies SET active = 0
      WHERE source_id = 'kogane-synthetic' AND origin_kind = 'http'
    `).run();
    const policy = await env.DB.prepare(`
      SELECT active FROM origin_template_policies
      WHERE source_id = 'kogane-synthetic' AND origin_kind = 'http'
    `).first<{ active: number }>();
    expect(policy?.active).toBe(0);
  });

  it("excludes both legacy and dedicated synthetic runs from financial views", async () => {
    const clientId = "client-financial-view";
    const producerId = "producer-financial-view";
    const realSourceId = "source-financial-view";
    await env.DB.batch([
      env.DB.prepare("INSERT INTO ingest_clients (id, display_name) VALUES (?, 'Financial view client')")
        .bind(clientId),
      env.DB.prepare("INSERT INTO producers (id, kind, display_name) VALUES (?, 'test', 'Financial view producer')")
        .bind(producerId),
      env.DB.prepare("INSERT INTO ingest_client_producers (ingest_client_id, producer_id) VALUES (?, ?)")
        .bind(clientId, producerId),
      env.DB.prepare("INSERT INTO sources (id, provider, display_name) VALUES (?, 'Fixture', 'Financial view source')")
        .bind(realSourceId),
      env.DB.prepare("INSERT INTO producer_sources (producer_id, source_id) VALUES (?, ?)")
        .bind(producerId, realSourceId),
      env.DB.prepare("INSERT INTO producer_sources (producer_id, source_id) VALUES (?, 'kogane-synthetic')")
        .bind(producerId),
      env.DB.prepare("INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id) VALUES (?, ?, ?)")
        .bind(clientId, producerId, realSourceId),
      env.DB.prepare("INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id) VALUES (?, ?, 'kogane-synthetic')")
        .bind(clientId, producerId),
    ]);
    const addRun = async (sourceId: string, sessionId: string) => {
      const session = await env.DB.prepare(`
        INSERT INTO acquisition_sessions (
          producer_id, first_recorded_by_client_id, external_id_namespace,
          external_session_id, first_recorded_at_ms
        ) VALUES (?, ?, 'test', ?, ?) RETURNING id
      `).bind(producerId, clientId, sessionId, NOW).first<{ id: number }>();
      return env.DB.prepare(`
        INSERT INTO fetch_runs (
          acquisition_session_id, producer_id, source_id,
          first_recorded_by_client_id, first_recorded_at_ms
        ) VALUES (?, ?, ?, ?, ?) RETURNING id
      `).bind(session!.id, producerId, sourceId, clientId, NOW).first<{ id: number }>();
    };
    const realRun = await addRun(realSourceId, "financial-view-real");
    const syntheticRun = await addRun("kogane-synthetic", "financial-view-synthetic");
    const visible = await env.DB.prepare(`
      SELECT id FROM financial_fetch_runs WHERE id IN (?, ?) ORDER BY id
    `).bind(realRun!.id, syntheticRun!.id).all<{ id: number }>();
    expect(visible.results).toEqual([{ id: realRun!.id }]);
  });

  it("rejects inventory chunks beyond the immutable declared count", async () => {
    const scope = "inventory-overflow";
    const runId = await seedRun(scope);
    const first = {
      key: "first.json",
      sha: "ab".repeat(32),
      descriptorSha: "ac".repeat(32),
    };
    const second = {
      key: "second.json",
      sha: "ad".repeat(32),
      descriptorSha: "ae".repeat(32),
    };
    await addArtifact(runId, scope, first);
    await addArtifact(runId, scope, second);
    const inventoryId = await addInventory(runId, scope, "af".repeat(32), [first]);
    await expect(env.DB.prepare(`
      INSERT INTO run_inventory_items (
        inventory_id, fetch_run_id, artifact_key, sha256, descriptor_sha256
      ) VALUES (?, ?, ?, ?, ?)
    `).bind(
      inventoryId, runId, second.key, second.sha, second.descriptorSha,
    ).run()).rejects.toThrow(/inventory_overflow/);
  });
});
