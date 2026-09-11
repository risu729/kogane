// `kogane-ingest`: the legacy ingest adapter (decision D2). Since U05 it is a
// routing and translation layer only — it authenticates, parses the body, and
// turns an `ApiError` into the status code this API has always returned. The
// registration itself is `packages/application/src/ingest`, over the CORE SQL
// in `packages/storage-d1`, so the Processor can perform exactly the same
// registration without an HTTP hop.
//
// The wire protocol is unchanged and must stay so while any collector still
// uploads through it: test/api.test.ts and the nine per-source route tests
// exercise every path, status and error code below.
import { ContractError } from "../../../packages/evidence-contract/src/validate";
import { ApiError, authenticate, json, readJson, type WorkerEnv } from "./http";
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
    return json({ ok: true, service: "kogane-ingest", apiVersion: "v1", schemaVersion: "0016" });
  }

  const clientId = await authenticate(request, env);
  const objectMatch = /^\/v1\/runs\/(\d+)\/objects\/([0-9a-f]{64})$/.exec(url.pathname);
  if (request.method === "PUT" && objectMatch) {
    const result = await putObject(env, clientId, Number(objectMatch[1]), objectMatch[2], {
      declaredByteSize: request.headers.get("x-kogane-byte-size"),
      transportByteSize: request.headers.get("content-length"),
      body: request.body,
    });
    return json({ ...result }, result.reused ? 200 : 201);
  }
  const verificationMatch = /^\/v1\/runs\/(\d+)\/objects\/([0-9a-f]{64})\/verify$/.exec(
    url.pathname,
  );
  if (request.method === "POST" && verificationMatch) {
    return json(
      { ...(await verifyObject(env, clientId, Number(verificationMatch[1]), verificationMatch[2])) },
      201,
    );
  }
  if (request.method === "POST" && url.pathname === "/v1/runs") {
    return json({ ...(await createRun(env, clientId, await readJson(request))) }, 201);
  }
  const reportMatch = /^\/v1\/runs\/(\d+)\/reports$/.exec(url.pathname);
  if (request.method === "POST" && reportMatch) {
    return json(
      { ...(await addRunReport(env, clientId, Number(reportMatch[1]), await readJson(request))) },
      201,
    );
  }
  const rangeMatch = /^\/v1\/runs\/(\d+)\/ranges$/.exec(url.pathname);
  if (request.method === "POST" && rangeMatch) {
    return json(
      { ...(await addRunRange(env, clientId, Number(rangeMatch[1]), await readJson(request))) },
      201,
    );
  }
  const pageGroupMatch = /^\/v1\/runs\/(\d+)\/page-groups$/.exec(url.pathname);
  if (request.method === "POST" && pageGroupMatch) {
    return json(
      {
        ...(await addPageGroup(
          env,
          clientId,
          Number(pageGroupMatch[1]),
          await readJson(request),
        )),
      },
      201,
    );
  }
  const unitMatch = /^\/v1\/runs\/(\d+)\/units$/.exec(url.pathname);
  if (request.method === "POST" && unitMatch) {
    return json(
      { ...(await addUnit(env, clientId, Number(unitMatch[1]), await readJson(request))) },
      201,
    );
  }
  const unitReportMatch = /^\/v1\/units\/(\d+)\/reports$/.exec(url.pathname);
  if (request.method === "POST" && unitReportMatch) {
    return json(
      {
        ...(await addUnitReport(
          env,
          clientId,
          Number(unitReportMatch[1]),
          await readJson(request),
        )),
      },
      201,
    );
  }
  const artifactMatch = /^\/v1\/runs\/(\d+)\/artifacts$/.exec(url.pathname);
  if (request.method === "POST" && artifactMatch) {
    return json(
      { ...(await addArtifact(env, clientId, Number(artifactMatch[1]), await readJson(request))) },
      201,
    );
  }
  const inventoriesMatch = /^\/v1\/runs\/(\d+)\/inventories$/.exec(url.pathname);
  if (request.method === "POST" && inventoriesMatch) {
    return json(
      {
        ...(await beginInventory(
          env,
          clientId,
          Number(inventoriesMatch[1]),
          await readJson(request),
        )),
      },
      201,
    );
  }
  const inventoryMatch = /^\/v1\/runs\/(\d+)\/inventories\/(\d+)$/.exec(url.pathname);
  if (request.method === "GET" && inventoryMatch) {
    return json({
      ...(await getInventoryStatus(
        env,
        clientId,
        Number(inventoryMatch[1]),
        Number(inventoryMatch[2]),
      )),
    });
  }
  const inventoryItemsMatch = /^\/v1\/runs\/(\d+)\/inventories\/(\d+)\/items$/.exec(url.pathname);
  if (request.method === "POST" && inventoryItemsMatch) {
    return json(
      {
        ...(await addInventoryItems(
          env,
          clientId,
          Number(inventoryItemsMatch[1]),
          Number(inventoryItemsMatch[2]),
          await readJson(request),
        )),
      },
      201,
    );
  }
  const stagedSealMatch = /^\/v1\/runs\/(\d+)\/inventories\/(\d+)\/seal$/.exec(url.pathname);
  if (request.method === "POST" && stagedSealMatch) {
    return json(
      {
        ...(await sealStagedInventory(
          env,
          clientId,
          Number(stagedSealMatch[1]),
          Number(stagedSealMatch[2]),
          await readJson(request),
        )),
      },
      201,
    );
  }
  const attemptMatch = /^\/v1\/runs\/(\d+)\/attempts$/.exec(url.pathname);
  if (request.method === "POST" && attemptMatch) {
    return json(
      {
        ...(await addFailedAttempt(env, clientId, Number(attemptMatch[1]), await readJson(request))),
      },
      201,
    );
  }
  const sealMatch = /^\/v1\/runs\/(\d+)\/seal$/.exec(url.pathname);
  if (request.method === "POST" && sealMatch) {
    return json(
      { ...(await sealRun(env, clientId, Number(sealMatch[1]), await readJson(request))) },
      201,
    );
  }
  throw new ApiError(404, "not_found");
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.code }, error.status);
      // Shared request-schema failures keep their historical 400 codes.
      if (error instanceof ContractError) return json({ error: error.code }, 400);
      const message = error instanceof Error ? error.message : String(error);
      if (/inactive_ingest_(client|route)/.test(message)) {
        return json({ error: "inactive_ingest_route" }, 403);
      }
      if (
        /D1_ERROR/.test(message) &&
        /UNIQUE constraint|CHECK constraint|FOREIGN KEY constraint|append-only|after_seal|already_sealed|incomplete_inventory|inventory_|artifact_relation_|page_index_|terminal_report|required|mismatch|conflict/.test(
          message,
        )
      ) {
        return json({ error: "catalogue_conflict" }, 409);
      }
      return json({ error: "internal_error" }, 500);
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
