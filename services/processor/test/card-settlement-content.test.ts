import { expect, test } from "bun:test";
import { settlementFacts } from "../../../packages/application/test/card-settlement-fixture.ts";
import { cardSettlementContentDigest } from "../src/card-settlement-commands.ts";
import type { EventTimeRecord } from "../../../packages/domain/src/economic-contract.ts";

const times: EventTimeRecord[] = [
  {
    eventId: "event-synthetic",
    revision: 1,
    role: "posting",
    time: { kind: "local-date", value: "2026-09-10", zone: "Asia/Tokyo", basis: "provider" },
  },
];
const content = () => ({
  eventId: "event-synthetic",
  revision: 1,
  withdraw: false,
  facts: settlementFacts(),
  claims: [],
  aliasClass: null,
  times: structuredClone(times),
});

test("the seal content digest commits to typed time role, value, zone, basis and presence", async () => {
  const original = await cardSettlementContentDigest(content());
  const changed: EventTimeRecord[][] = [
    [],
    [{ ...times[0]!, role: "usage" }],
    [
      {
        ...times[0]!,
        time: { kind: "local-date", value: "2026-09-11", zone: "Asia/Tokyo", basis: "provider" },
      },
    ],
    [
      {
        ...times[0]!,
        time: { kind: "local-date", value: "2026-09-10", zone: "UTC", basis: "provider" },
      },
    ],
    [
      {
        ...times[0]!,
        time: { kind: "local-date", value: "2026-09-10", zone: "Asia/Tokyo", basis: "derived" },
      },
    ],
  ];
  const digests = [original];
  for (const value of changed)
    digests.push(await cardSettlementContentDigest({ ...content(), times: value }));
  expect(new Set(digests).size).toBe(6);
  expect(await cardSettlementContentDigest(content())).toBe(original);
});
