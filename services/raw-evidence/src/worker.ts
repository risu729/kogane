import { ApiError, authenticate, json, type WorkerEnv } from "./http";
import {
  addArtifact,
  addFailedAttempt,
  addInventoryItems,
  addRunReport,
  beginInventory,
  createRun,
  getInventoryStatus,
  putObject,
  sealRun,
  sealStagedInventory,
  verifyObject,
} from "./store";
import { addPageGroup, addRunRange, addUnit, addUnitReport } from "./structure";

async function route(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.search) throw new ApiError(400, "query_string_not_allowed");
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, service: "kogane-ingest", apiVersion: "v1", schemaVersion: "0011" });
  }

  const clientId = await authenticate(request, env);
  const objectMatch = /^\/v1\/runs\/(\d+)\/objects\/([0-9a-f]{64})$/.exec(url.pathname);
  if (request.method === "PUT" && objectMatch) {
    const result = await putObject(
      request,
      env,
      clientId,
      Number(objectMatch[1]),
      objectMatch[2],
    );
    return json(result, result.reused ? 200 : 201);
  }
  const verificationMatch = /^\/v1\/runs\/(\d+)\/objects\/([0-9a-f]{64})\/verify$/.exec(url.pathname);
  if (request.method === "POST" && verificationMatch) {
    return json(await verifyObject(
      env, clientId, Number(verificationMatch[1]), verificationMatch[2],
    ), 201);
  }
  if (request.method === "POST" && url.pathname === "/v1/runs") {
    return json(await createRun(request, env, clientId), 201);
  }
  const reportMatch = /^\/v1\/runs\/(\d+)\/reports$/.exec(url.pathname);
  if (request.method === "POST" && reportMatch) {
    return json(await addRunReport(request, env, clientId, Number(reportMatch[1])), 201);
  }
  const rangeMatch = /^\/v1\/runs\/(\d+)\/ranges$/.exec(url.pathname);
  if (request.method === "POST" && rangeMatch) {
    return json(await addRunRange(request, env, clientId, Number(rangeMatch[1])), 201);
  }
  const pageGroupMatch = /^\/v1\/runs\/(\d+)\/page-groups$/.exec(url.pathname);
  if (request.method === "POST" && pageGroupMatch) {
    return json(await addPageGroup(request, env, clientId, Number(pageGroupMatch[1])), 201);
  }
  const unitMatch = /^\/v1\/runs\/(\d+)\/units$/.exec(url.pathname);
  if (request.method === "POST" && unitMatch) {
    return json(await addUnit(request, env, clientId, Number(unitMatch[1])), 201);
  }
  const unitReportMatch = /^\/v1\/units\/(\d+)\/reports$/.exec(url.pathname);
  if (request.method === "POST" && unitReportMatch) {
    return json(await addUnitReport(request, env, clientId, Number(unitReportMatch[1])), 201);
  }
  const artifactMatch = /^\/v1\/runs\/(\d+)\/artifacts$/.exec(url.pathname);
  if (request.method === "POST" && artifactMatch) {
    return json(await addArtifact(request, env, clientId, Number(artifactMatch[1])), 201);
  }
  const inventoriesMatch = /^\/v1\/runs\/(\d+)\/inventories$/.exec(url.pathname);
  if (request.method === "POST" && inventoriesMatch) {
    return json(await beginInventory(request, env, clientId, Number(inventoriesMatch[1])), 201);
  }
  const inventoryMatch = /^\/v1\/runs\/(\d+)\/inventories\/(\d+)$/.exec(url.pathname);
  if (request.method === "GET" && inventoryMatch) {
    return json(await getInventoryStatus(
      env, clientId, Number(inventoryMatch[1]), Number(inventoryMatch[2]),
    ));
  }
  const inventoryItemsMatch = /^\/v1\/runs\/(\d+)\/inventories\/(\d+)\/items$/.exec(url.pathname);
  if (request.method === "POST" && inventoryItemsMatch) {
    return json(await addInventoryItems(
      request, env, clientId, Number(inventoryItemsMatch[1]), Number(inventoryItemsMatch[2]),
    ), 201);
  }
  const stagedSealMatch = /^\/v1\/runs\/(\d+)\/inventories\/(\d+)\/seal$/.exec(url.pathname);
  if (request.method === "POST" && stagedSealMatch) {
    return json(await sealStagedInventory(
      request, env, clientId, Number(stagedSealMatch[1]), Number(stagedSealMatch[2]),
    ), 201);
  }
  const attemptMatch = /^\/v1\/runs\/(\d+)\/attempts$/.exec(url.pathname);
  if (request.method === "POST" && attemptMatch) {
    return json(await addFailedAttempt(request, env, clientId, Number(attemptMatch[1])), 201);
  }
  const sealMatch = /^\/v1\/runs\/(\d+)\/seal$/.exec(url.pathname);
  if (request.method === "POST" && sealMatch) {
    return json(await sealRun(request, env, clientId, Number(sealMatch[1])), 201);
  }
  throw new ApiError(404, "not_found");
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.code }, error.status);
      const message = error instanceof Error ? error.message : String(error);
      if (/inactive_ingest_(client|route)/.test(message)) {
        return json({ error: "inactive_ingest_route" }, 403);
      }
      if (/D1_ERROR/.test(message) && /UNIQUE constraint|CHECK constraint|FOREIGN KEY constraint|append-only|after_seal|already_sealed|incomplete_inventory|inventory_|artifact_relation_|page_index_|terminal_report|required|mismatch|conflict/.test(message)) {
        return json({ error: "catalogue_conflict" }, 409);
      }
      return json({ error: "internal_error" }, 500);
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
