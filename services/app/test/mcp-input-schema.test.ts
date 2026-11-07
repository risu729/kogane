// The published input schema of an MCP tool is one closed object at its root
// (issue #1078), while the Zod schema keeps validating the exact shape.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { delegatedSurveySchema } from "../../../packages/application/src/index";
import { mcpInputSchema } from "../src/mcp-input-schema";

describe("mcpInputSchema", () => {
  it("publishes an object schema as it is, without the meta key", () => {
    expect(mcpInputSchema(z.strictObject({ source: z.string().optional() }))).toEqual({
      type: "object",
      properties: { source: { type: "string" } },
      additionalProperties: false,
    });
  });

  it("publishes the survey decision union as one closed object", () => {
    const published = mcpInputSchema(delegatedSurveySchema);
    expect(Object.keys(published)).toEqual([
      "type",
      "properties",
      "required",
      "additionalProperties",
    ]);
    expect(published).toEqual({
      type: "object",
      properties: {
        decision: { type: "string", enum: ["reject", "accept"] },
        source: { type: "string", pattern: "^[a-z0-9-]{1,100}$" },
        proposalId: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        step: {
          type: "string",
          enum: ["apply", "prepare", "confirm"],
          description:
            'With decision "reject": "apply". With decision "accept": "prepare" or "confirm".',
        },
        idempotencyKey: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
        baseRevision: {
          type: "integer",
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
          description: 'Required with decision "accept"; not allowed otherwise.',
        },
        confirmationDigest: {
          type: "string",
          pattern: "^cfm_[0-9a-f]{64}$",
          description: 'Only with decision "accept".',
        },
      },
      required: ["decision", "source", "proposalId", "step", "idempotencyKey"],
      additionalProperties: false,
    });
  });

  it("leaves the exact shapes to the Zod schema", () => {
    const base = { source: "synthetic-source", proposalId: 1, idempotencyKey: "k-1" };
    // Each of these fits the flat published schema; only one shape is valid.
    expect(
      delegatedSurveySchema.safeParse({ ...base, decision: "reject", step: "apply" }).success,
    ).toBe(true);
    expect(
      delegatedSurveySchema.safeParse({ ...base, decision: "reject", step: "prepare" }).success,
    ).toBe(false);
    expect(
      delegatedSurveySchema.safeParse({ ...base, decision: "accept", step: "prepare" }).success,
    ).toBe(false);
    expect(
      delegatedSurveySchema.safeParse({
        ...base,
        decision: "reject",
        step: "apply",
        baseRevision: 0,
      }).success,
    ).toBe(false);
  });

  it("refuses a schema that is not an object or a discriminated union of objects", () => {
    expect(() => mcpInputSchema(z.string())).toThrow(/one object at its root/u);
    expect(() =>
      mcpInputSchema(
        z.union([z.strictObject({ a: z.string() }), z.strictObject({ b: z.string() })]),
      ),
    ).toThrow();
    expect(() =>
      mcpInputSchema(z.union([z.object({ a: z.literal("x") }), z.object({ a: z.literal("y") })])),
    ).toThrow(/one object at its root/u);
  });
});
