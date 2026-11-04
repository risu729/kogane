// Shared GitHub API pagination and Renovate configuration contracts.
import { describe, expect, test } from "bun:test";
import { nextLink, paginate } from "../tasks/_lib/ci/github-api.mjs";
import renovate from "../.github/renovate.json5";

describe("GitHub API pagination fails closed", () => {
  const page = (items: unknown[], next?: string) =>
    new Response(JSON.stringify(items), {
      status: 200,
      headers: next ? { link: `<${next}>; rel="next"` } : {},
    });
  test("Link headers are followed to the end", async () => {
    const pages = new Map([
      ["https://api/a?page=1", page([1, 2], "https://api/a?page=2")],
      ["https://api/a?page=2", page([3])],
    ]);
    const fetchImpl = ((url: string) => Promise.resolve(pages.get(url)!)) as typeof fetch;
    const items = await paginate("https://api/a?page=1", { token: "t", fetchImpl });
    expect(items).toEqual([1, 2, 3]);
    expect(nextLink('<https://api/a?page=2>; rel="next", <https://api/a?page=9>; rel="last"')).toBe(
      "https://api/a?page=2",
    );
    expect(nextLink(null)).toBeUndefined();
  });
  test("a collection longer than the page limit throws instead of returning a prefix", async () => {
    // Release-ledger callers need the complete collection, never a silent prefix.
    const fetchImpl = ((url: string) =>
      Promise.resolve(page([url], "https://api/a?next"))) as typeof fetch;
    await expect(paginate("https://api/a", { token: "t", limit: 2, fetchImpl })).rejects.toThrow(
      "more than 2 pages",
    );
  });
  test("a non-list body is an error, not an empty collection", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "x" }), { status: 200 }),
      )) as typeof fetch;
    await expect(paginate("https://api/a", { token: "t", fetchImpl })).rejects.toThrow(
      "did not return a list",
    );
  });
});

describe("Renovate configuration", () => {
  const rules = renovate.packageRules as {
    matchPackageNames?: string[];
    matchFileNames?: string[];
    groupName?: string;
    addLabels?: string[];
  }[];
  test("extends the shared preset at a concrete version tag and parses as JSON5", () => {
    // Renovate owns the tag; this guard owns the repository and stable version pin.
    expect(renovate.extends).toHaveLength(1);
    expect(renovate.extends[0]).toMatch(
      /^github>risu729\/renovate-config#(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/,
    );
    expect(rules.length).toBeGreaterThan(0);
  });
  test("the typescript group name matches the preset's, so the rules merge instead of competing", () => {
    // risu729/renovate-config declares `matchDepNames: ["typescript",
    // "npm:typescript"], groupName: "typescript"`; a different local name would
    // split one update into two branches.
    const localGroup = rules.find((rule) =>
      rule.matchPackageNames?.includes("typescript"),
    )?.groupName;
    expect(localGroup).toBe("typescript");
  });
  test("dependency groups have distinct names", () => {
    const groups = rules.map((rule) => rule.groupName).filter(Boolean);
    expect(new Set(groups).size).toBe(groups.length);
  });
});
