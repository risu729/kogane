// The published `inputSchema` of an MCP tool, generated from the Zod schema
// that validates the tool's arguments (issue #1078).
//
// MCP requires `inputSchema.type` to be `"object"` at the root, and the SDK
// client rejects the whole `tools/list` when one descriptor lacks it. Clients
// that hand a tool to a model also refuse a root `oneOf` / `anyOf` / `allOf`.
// A discriminated union of objects (one tool, several argument shapes) is
// therefore published as one closed object: every property any shape has,
// the discriminator as the enum of its values, and only the properties every
// shape requires as required. Which properties go with which value is stated
// in the descriptions. The Zod schema stays the validator: a call is still
// checked against its exact shape, so the flat schema only describes.
import { z } from "zod";

type JsonSchema = Record<string, unknown>;

const COMBINATORS = ["oneOf", "anyOf", "allOf", "not"] as const;

/** The JSON Schema of `schema` as an MCP tool's `inputSchema`. */
export function mcpInputSchema(schema: z.ZodType): JsonSchema {
  const generated = z.toJSONSchema(schema) as JsonSchema;
  delete generated["$schema"];
  assertPortablePatterns(generated);
  if (generated["type"] === "object" && !COMBINATORS.some((key) => key in generated))
    return generated;
  const keys = Object.keys(generated);
  const branches = generated["oneOf"];
  if (
    keys.length === 1 &&
    keys[0] === "oneOf" &&
    Array.isArray(branches) &&
    branches.length > 0 &&
    branches.every(isClosedObject)
  )
    return flatten(branches);
  throw new Error(`An MCP input schema must be one object at its root (keys: ${keys.join(", ")})`);
}

function isClosedObject(branch: unknown): branch is JsonSchema & {
  properties: Record<string, JsonSchema>;
} {
  if (typeof branch !== "object" || branch === null) return false;
  const value = branch as JsonSchema;
  return (
    value["type"] === "object" &&
    value["additionalProperties"] === false &&
    typeof value["properties"] === "object" &&
    value["properties"] !== null &&
    !COMBINATORS.some((key) => key in value)
  );
}

function required(branch: JsonSchema): readonly string[] {
  return Array.isArray(branch["required"]) ? (branch["required"] as string[]) : [];
}

/** The values a property schema allows when it is a closed set of strings. */
function stringValues(property: JsonSchema): readonly string[] | null {
  if (property["type"] !== "string") return null;
  const rest = Object.keys(property).filter((key) => !["type", "const", "enum"].includes(key));
  if (rest.length > 0) return null;
  if (typeof property["const"] === "string") return [property["const"]];
  if (
    Array.isArray(property["enum"]) &&
    property["enum"].every((value) => typeof value === "string")
  )
    return property["enum"] as string[];
  return null;
}

function flatten(branches: readonly (JsonSchema & { properties: Record<string, JsonSchema> })[]) {
  // The discriminator: required by every shape, one distinct string per shape.
  const discriminator = Object.keys(branches[0]!.properties).find((key) => {
    const values = branches.map((branch) => {
      const property = branch.properties[key];
      return property && required(branch).includes(key) && typeof property["const"] === "string"
        ? property["const"]
        : null;
    });
    return values.every((value) => value !== null) && new Set(values).size === branches.length;
  });
  if (discriminator === undefined)
    throw new Error("An MCP input schema union needs one string discriminator");
  const tag = (branch: JsonSchema & { properties: Record<string, JsonSchema> }) =>
    JSON.stringify(branch.properties[discriminator]!["const"]);

  const names = [...new Set(branches.flatMap((branch) => Object.keys(branch.properties)))];
  const properties: Record<string, JsonSchema> = {};
  for (const name of names) {
    const owners = branches.filter((branch) => name in branch.properties);
    const variants = owners.map((branch) => branch.properties[name]!);
    const distinct = [...new Map(variants.map((v) => [JSON.stringify(v), v])).values()];
    let merged: JsonSchema;
    if (distinct.length === 1) merged = { ...distinct[0] };
    else {
      const values = distinct.map(stringValues);
      merged = values.every((set) => set !== null)
        ? { type: "string", enum: [...new Set(values.flat() as string[])] }
        : { anyOf: distinct };
    }
    const notes: string[] = [];
    const needed = owners.filter((branch) => required(branch).includes(name));
    const only = owners.length < branches.length;
    if (name !== discriminator && only && needed.length === owners.length)
      notes.push(
        `Required with ${discriminator} ${owners.map(tag).join(" or ")}; not allowed otherwise.`,
      );
    else {
      if (name !== discriminator && only)
        notes.push(`Only with ${discriminator} ${owners.map(tag).join(" or ")}.`);
      if (needed.length > 0 && needed.length < branches.length)
        notes.push(`Required with ${discriminator} ${needed.map(tag).join(" or ")}.`);
    }
    if (name !== discriminator && distinct.length > 1)
      for (const branch of owners)
        notes.push(`With ${discriminator} ${tag(branch)}: ${describe(branch.properties[name]!)}.`);
    if (notes.length > 0)
      merged["description"] = [merged["description"], ...notes].filter(Boolean).join(" ");
    properties[name] = merged;
  }
  return {
    type: "object",
    properties,
    required: names.filter((name) => branches.every((branch) => required(branch).includes(name))),
    additionalProperties: false,
  };
}

function describe(property: JsonSchema): string {
  const values = stringValues(property);
  return values
    ? values.map((value) => JSON.stringify(value)).join(" or ")
    : JSON.stringify(property);
}

/**
 * A `pattern` is read by each client's own regular-expression engine. ChatGPT
 * refuses a tool whose pattern uses a Unicode property escape (`\p{Cc}`) and
 * then imports none of the server's tools; spell the ranges out instead.
 */
function assertPortablePatterns(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) assertPortablePatterns(item);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "pattern" && typeof value === "string" && /\\[pP]\{/u.test(value))
      throw new Error(`An MCP input schema pattern must not use \\p{…}: ${value}`);
    assertPortablePatterns(value);
  }
}
