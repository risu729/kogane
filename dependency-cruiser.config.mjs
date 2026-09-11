// Resolved-import boundaries (unified plan U04, chapter 07 §3/§6; acceptance
// tests G4-07 and G4-08).
//
// `tasks/_lib/import-boundaries.ts` states the same two rules over the text of
// every tracked file, which is fast and catches a specifier as written.
// dependency-cruiser states them over *resolved* modules, which is what catches
// the forms a text guard cannot see: a bare specifier that resolves into a
// workspace through `node_modules`, an `exports` map, an alias, a dynamic
// `import()`, and a type-only import that disappears at runtime
// (`tsPreCompilationDeps` is what keeps those visible).
//
// TypeScript caveat: dependency-cruiser 18.2.0 supports `typescript` < 7. If it
// cannot resolve a TS 5.x transpiler it still exits 0, having cruised a few
// dozen modules instead of several hundred — a rule that passes because it saw
// almost nothing. `tasks/_lib/depcruise.ts` therefore asserts a minimum module
// count as well as an empty violation list, and the root manifest keeps
// `typescript@5.9.3` (the Workers packages pin 7.x locally; that is fine as
// long as the root one stays resolvable from here).
export default {
  forbidden: [
    {
      name: "no-product-to-experiment",
      comment:
        "services/*/src and packages/*/src must not import poc/, experiments/ or apps/: deployed code cannot be reviewed apart from an experiment it imports.",
      severity: "error",
      from: { path: "^(services|packages)/[^/]+/src/" },
      to: { path: "^(poc|experiments|apps)/" },
    },
    {
      name: "no-web-to-storage",
      comment:
        "apps/web must not import the read model's SQL or packages/storage-d1: the UI reads the HTTP contract, never a query builder.",
      severity: "error",
      from: { path: "^apps/web/" },
      to: { path: "^(packages/read-model/src/|packages/storage-d1/)" },
    },
    {
      name: "no-web-to-service-internals",
      comment:
        "The shipped client (apps/web/src plus index.html) must not import a service's src. apps/web/test is deliberately outside: Vite never sees it, and one Playwright test boots services/evidence-browser's own response helper in-process precisely to prove the client survives the production CSP.",
      severity: "error",
      from: { path: "^apps/web/", pathNot: "^apps/web/test/" },
      to: { path: "^services/[^/]+/src/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(node_modules|dist|dist-evidence|dist-production|\\.claude|data)/" },
    // Without this a `import type { X } from "../../poc/…"` escapes every rule.
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "workerd", "worker", "browser", "default"],
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"],
      mainFields: ["module", "main"],
    },
  },
};
