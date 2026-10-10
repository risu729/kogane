// The joined source envelope must survive interleaving of different rule IDs.
import { expect, test, setSystemTime } from "bun:test";
import { fullCoreDatabase, sqliteD1 } from "../../../packages/storage-d1/test/sqlite";
import {
  writeMaintenanceRevision,
  type MaintenanceWrite,
  type MaintenanceWriteOptions,
} from "../src/schedule-store";
import {
  OperationCall,
  executionFor,
  type DelegatedPrincipal,
} from "../../../packages/application/src/index";
const DAY = 86400000,
  REF = "https://maintenance.synthetic.test/notices";
const noRecord = () => ({ statements: [], settle: () => {} });
for (const [days, bound] of [
  [4, "delegated-7d"],
  [20, "confirmed-31d"],
] as const) {
  for (const nativeFirst of [false, true]) {
    test(`${bound}: source snapshot rejects concurrent ${nativeFirst ? "operator" : "delegated"} append`, async () => {
      const sqlite = fullCoreDatabase();
      try {
        sqlite
          .query(
            "INSERT INTO provider_maintenance_rules(id,revision,source,timezone,pattern_json,enabled,reference_url,verified_at,scope,actor,created_at) SELECT id,revision+1,source,timezone,pattern_json,0,?,verified_at,scope,'migration:synthetic','2026-01-01T00:00:00.000Z' FROM provider_maintenance_rules",
          )
          .run(REF);
        sqlite.query("UPDATE provider_maintenance_references SET reference_url=?").run(REF);
        const db = sqliteD1(sqlite);
        let arrivals = 0;
        let release!: () => void;
        const ready = new Promise<void>((resolve) => {
          release = resolve;
        });
        let operatorDone!: () => void;
        const committed = new Promise<void>((resolve) => {
          operatorDone = resolve;
        });
        const wrapped = (operator: boolean) => ({
          ...db,
          batch: async (statements: D1PreparedStatement[]) => {
            const arrival = ++arrivals;
            if (arrival === 2) release();
            await ready;
            // Both writers completed validation. In the native case force the
            // operator's append to happen before the delegated INSERT.
            if (nativeFirst && !operator) await committed;
            const result = await db.batch(statements);
            if (nativeFirst && operator) operatorDone();
            return result;
          },
        });
        const environment = (operator: boolean) =>
          ({
            DB: wrapped(operator),
            SCHEDULE_ALARMS: { getByName: () => ({ reconcile: async () => null }) },
          }) as unknown as Env;
        const start = Date.now() + DAY;
        const write = (i: number): MaintenanceWrite => ({
          source: "vpass",
          ruleId: null,
          expectedRevision: 0,
          change: {
            timezone: "Asia/Tokyo",
            pattern: {
              kind: "once",
              from: new Date(start + i * days * DAY).toISOString(),
              to: new Date(start + (i + 1) * days * DAY).toISOString(),
            },
            enabled: true,
            scope: "collection",
          },
          provenance: {
            referenceUrl: REF,
            verifiedAt: new Date(Date.now() - 60000).toISOString(),
            decisionRef: "delegated-audit:aud_00000000-0000-0000-0000-000000000000",
          },
          actor: { kind: "delegated", id: "mcp-client:synthetic-race" },
          reason: "owner-instructed",
        });
        const first = write(0),
          second = write(1);
        if (nativeFirst) {
          second.actor = { kind: "operator", id: "synthetic-operator" };
          second.reason = "operator-edit";
          delete second.provenance.decisionRef;
        }
        const options: MaintenanceWriteOptions = { deferralBound: bound };
        const answers = await Promise.all([
          writeMaintenanceRevision(environment(false), first, noRecord, options),
          writeMaintenanceRevision(environment(nativeFirst), second, noRecord, options),
        ]);
        expect(answers.filter((x) => x.ok)).toHaveLength(1);
        expect(answers.find((x) => !x.ok)).toMatchObject({
          ok: false,
          code: "revision_conflict",
          status: 409,
        });
        if (nativeFirst) {
          expect(answers[0]?.ok).toBe(false);
          expect(answers[1]?.ok).toBe(true);
        }
        expect(
          sqlite
            .query(
              "SELECT count(*) n FROM provider_maintenance_rules WHERE actor='mcp-client:synthetic-race'",
            )
            .get(),
        ).toEqual({ n: nativeFirst ? 0 : 1 });
        const plan = sqlite
          .query(
            "EXPLAIN QUERY PLAN SELECT count(*) FROM provider_maintenance_rules WHERE source=?",
          )
          .all("vpass");
        expect(JSON.stringify(plan)).toContain("COVERING INDEX maintenance_source");
      } finally {
        sqlite.close();
      }
    });
  }
}

test.each([false, true])(
  "same-millisecond ignored INSERT cannot update provenance (identical ref: %s)",
  async (identical) => {
    const sqlite = fullCoreDatabase(),
      db = sqliteD1(sqlite),
      now = Date.now();
    setSystemTime(now);
    try {
      sqlite.query("UPDATE provider_maintenance_references SET reference_url=?").run(REF);
      let enabled = false,
        arrivals = 0;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      const observed: { insert: number; provenance: number }[] = [];
      const wrapped = {
        ...db,
        batch: async (statements: D1PreparedStatement[]) => {
          if (enabled) {
            if (++arrivals === 2) release();
            await ready;
          }
          const result = await db.batch(statements);
          if (enabled)
            observed.push({ insert: result[0]!.meta.changes, provenance: result[1]!.meta.changes });
          return result;
        },
      };
      const environment = {
        DB: wrapped,
        SCHEDULE_ALARMS: { getByName: () => ({ reconcile: async () => null }) },
      } as unknown as Env;
      const original: MaintenanceWrite = {
        source: "vpass",
        ruleId: null,
        expectedRevision: 0,
        change: {
          timezone: "Asia/Tokyo",
          pattern: {
            kind: "once",
            from: new Date(now + DAY).toISOString(),
            to: new Date(now + 2 * DAY).toISOString(),
          },
          enabled: false,
          scope: "collection",
        },
        provenance: { referenceUrl: REF, verifiedAt: new Date(now - 60000).toISOString() },
        actor: { kind: "operator", id: "synthetic-operator" },
        reason: "operator-edit",
      };
      const created = await writeMaintenanceRevision(environment, original, noRecord);
      if (!created.ok) throw Error("fixture failed");
      const principal: DelegatedPrincipal = {
        kind: "delegated",
        id: "mcp-client:synthetic-provenance",
        delegator: "synthetic-provenance",
        capabilities: ["schedules.maintenance.update"],
        scopes: { sources: [], accounts: [], scheduleSources: ["vpass"] },
        notAfter: new Date(now + 3600000).toISOString(),
        delegationRef: `dlg_${"a".repeat(64)}`,
        budget: { writesPerDay: 100 },
      };
      const sharedRef = `delegated-audit:aud_${crypto.randomUUID()}`;
      enabled = true;
      const answers = await Promise.all(
        ["a", "b"].map(async (suffix) => {
          const audit = new OperationCall("schedules.maintenance.update", {
            path: "mcp",
            principal: principal.id,
            subject: principal.delegator,
            principalKind: "agent",
            correlationId: crypto.randomUUID(),
          });
          audit.delegate(principal, {
            ...executionFor(principal, "schedules.maintenance.update", {
              namespace: "schedule-source",
              source: "vpass",
            }),
            idempotencyKey: identical ? "same" : suffix,
            payloadDigest: (identical ? "a" : suffix).repeat(64),
          });
          const write: MaintenanceWrite = {
            ...original,
            ruleId: created.ruleId,
            expectedRevision: 1,
            actor: { kind: "delegated", id: principal.id },
            reason: "correction",
            provenance: {
              ...original.provenance,
              referenceUrl: `${REF}/${identical ? "a" : suffix}`,
              decisionRef: identical ? sharedRef : `delegated-audit:${audit.reserveAuditId()}`,
            },
          };
          return writeMaintenanceRevision(environment, write, (revision) => {
            const ref = `maintenance-rule:${revision.ruleId}@${revision.revision}`;
            const record = audit.effect(
              {
                targetRef: `maintenance-rule:${revision.ruleId}`,
                refs: [ref],
                scope: { namespace: "schedule-source", source: "vpass" },
                reasonCode: revision.reason,
                diff: {
                  kind: "revision",
                  from: revision.previous,
                  to: revision.revision,
                  fields: revision.fields,
                },
              },
              revision.guard,
              { kind: "target-ref", ref },
            );
            return {
              statements: [environment.DB.prepare(record.sql).bind(...record.binds)],
              settle: (results) => audit.settle(results[0]?.meta.changes),
            };
          });
        }),
      );
      expect(answers.filter((x) => x.ok)).toHaveLength(1);
      expect(answers.find((x) => !x.ok)).toMatchObject({ code: "revision_conflict" });
      expect(
        sqlite
          .query("SELECT reference_url FROM provider_maintenance_references WHERE source='vpass'")
          .get(),
      ).toEqual(
        sqlite
          .query("SELECT reference_url FROM provider_maintenance_rules WHERE id=? AND revision=2")
          .get(created.ruleId),
      );
      expect(
        sqlite.query("SELECT count(*) n FROM audit_records WHERE result='applied'").get(),
      ).toEqual({ n: 1 });
      expect(observed.find((x) => x.insert === 0)).toEqual({ insert: 0, provenance: 0 });
    } finally {
      setSystemTime();
      sqlite.close();
    }
  },
);
