// The operation record the browser validates
// (`packages/observation-shared/src/operation-contract.ts`) restates the
// application's vocabularies, because the shared package may not import this
// one. This test pins the two to the same values. Records built over the real
// migrations are validated in services/app/test/ops-api.test.ts (acceptance
// and read) and services/processor/test/collector-dispatch.test.ts (the whole
// collector trail).
import { describe, expect, test } from "bun:test";
import {
  DISPATCH_STATES,
  OPERATION_KINDS,
  OPERATION_STAGES,
  OPERATION_STATUSES,
  STAGE_STATES,
  STAGES_BY_KIND,
} from "../src/operations/requests.ts";
import {
  COLLECTOR_ACTIONS,
  COLLECTOR_EXECUTION_STATES,
  RUN_TRAIL_STATES,
} from "../src/operations/collector-trail.ts";
import {
  OPERATION_RECORD_COLLECTOR_ACTIONS,
  OPERATION_RECORD_DISPATCH_STATES,
  OPERATION_RECORD_EXECUTION_STATES,
  OPERATION_RECORD_KINDS,
  OPERATION_RECORD_RUN_STATES,
  OPERATION_RECORD_STAGE_STATES,
  OPERATION_RECORD_STAGES,
  OPERATION_RECORD_STAGES_BY_KIND,
  OPERATION_RECORD_STATUSES,
} from "../../observation-shared/src/operation-contract.ts";

describe("operation record vocabulary", () => {
  test("restates the application's lists exactly, in order", () => {
    expect([...OPERATION_RECORD_KINDS]).toEqual([...OPERATION_KINDS]);
    expect([...OPERATION_RECORD_STATUSES]).toEqual([...OPERATION_STATUSES]);
    expect([...OPERATION_RECORD_DISPATCH_STATES]).toEqual([...DISPATCH_STATES]);
    expect([...OPERATION_RECORD_STAGES]).toEqual([...OPERATION_STAGES]);
    expect([...OPERATION_RECORD_STAGE_STATES]).toEqual([...STAGE_STATES]);
    expect(OPERATION_RECORD_STAGES_BY_KIND).toEqual(STAGES_BY_KIND);
    expect([...OPERATION_RECORD_COLLECTOR_ACTIONS]).toEqual([...COLLECTOR_ACTIONS]);
    expect([...OPERATION_RECORD_EXECUTION_STATES]).toEqual([...COLLECTOR_EXECUTION_STATES]);
    expect([...OPERATION_RECORD_RUN_STATES]).toEqual([...RUN_TRAIL_STATES]);
  });
});
