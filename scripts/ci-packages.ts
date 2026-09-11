// Explicit offline CI policy. Adding a package or changing a selected script
// requires reviewing this list; never discover and execute arbitrary scripts.
const test = "bun test";
const typecheck = "wrangler types && tsc --noEmit";
const dryRun = "wrangler deploy --dry-run";
const strictTypes =
  "wrangler types worker-configuration.d.ts --env-file .dev.vars.example --strict-vars false";

export interface PackagePolicy {
  path: string;
  scripts: Record<string, string>;
  checks: string[];
  container?: string;
  browser?: boolean;
  additionalDryRun?: boolean;
  evidenceAssets?: boolean;
  sharedParserDependencies?: boolean;
}

function worker(path: string): PackagePolicy {
  return {
    path: `poc/${path}`,
    scripts: { test, typecheck, "cf:check": dryRun },
    checks: ["test", "typecheck", "cf:check"],
  };
}

export const CI_PACKAGES: PackagePolicy[] = [
  {
    // Pure domain contracts: no Worker, no build, no browser; tests and types only.
    path: "packages/domain",
    scripts: { test, typecheck: "tsc --noEmit" },
    checks: ["typecheck", "test"],
  },
  {
    // Pure shared contract: no Worker, no network, no wrangler.
    path: "packages/evidence-contract",
    scripts: { test, typecheck: "tsc --noEmit" },
    checks: ["test", "typecheck"],
  },
  {
    // Pure application services (query A08, command A09): no Workers tooling,
    // no database driver, no HTTP; the adapters live in the services.
    path: "packages/application",
    scripts: { test, typecheck: "tsc --noEmit" },
    checks: ["typecheck", "test"],
  },
  {
    // CORE database access (unified plan U05, docs/storage-d1.md): the SQL the
    // services used to keep each to themselves, the row codecs and the guarded
    // atomic commands, plus the CORE and READ migration directories. Pure data
    // access over a structural D1 interface; no Worker, no wrangler, no HTTP.
    path: "packages/storage-d1",
    scripts: { test, typecheck: "tsc --noEmit" },
    checks: ["typecheck", "test"],
  },
  {
    // Pure shared code: no Workers tooling, no browser, no build.
    path: "packages/read-model",
    scripts: { test, typecheck: "tsc --noEmit" },
    checks: ["typecheck", "test"],
  },
  {
    // Promoted from the PoC (design review D07, docs/package-layout.md): the
    // HTTP/UI contracts and value semantics every reader shares. Pure data and
    // predicates; no Worker, no database, no browser.
    path: "packages/observation-shared",
    scripts: { test, typecheck: "tsc --noEmit" },
    checks: ["typecheck", "test"],
  },
  {
    // Promoted from the PoC (design review D07). The deployed parsers and
    // their build digests. parse5 is a real runtime dependency of two HTML
    // parsers, so this is the one shared package with `dependencies`; the
    // services that run the parsers install it (`sharedParserDependencies`).
    path: "packages/parsers",
    scripts: { test, typecheck: "tsc --noEmit" },
    checks: ["typecheck", "test"],
  },
  {
    // Promoted from the PoC (design review D07): identity resolution over
    // stored observations. Pure functions; no Worker, no database.
    path: "packages/identity",
    scripts: { test, typecheck: "tsc --noEmit" },
    checks: ["typecheck", "test"],
  },
  {
    path: "services/observation-pipeline",
    scripts: { test, typecheck, "cf:check": dryRun },
    checks: ["typecheck", "test", "cf:check"],
    sharedParserDependencies: true,
  },
  {
    path: "services/evidence-browser",
    scripts: {
      test: "vitest run",
      typecheck,
      "cf:check": `${dryRun} && ${dryRun} --config wrangler.demo.jsonc`,
    },
    checks: ["typecheck", "test", "cf:check"],
    evidenceAssets: true,
  },
  {
    path: "services/raw-evidence",
    scripts: {
      test: "vitest run && bash test/verify-sbi-shinsei-route.test.sh && bash test/verify-mobile-suica-route.test.sh && bash test/verify-global-pass-route.test.sh && bash test/verify-myjcb-route.test.sh && bash test/verify-moneyforward-route.test.sh && bash test/verify-v-point-route.test.sh && bash test/verify-vpass-route.test.sh && bash test/verify-v-point-pay-email-route.test.sh && bash test/verify-smbc-direct-route.test.sh",
      typecheck,
      "check:importer":
        "bun build scripts/ingest-file.ts --target=bun --outfile=/tmp/kogane-ingest-file-check.js",
      "cf:check": dryRun,
    },
    checks: ["typecheck", "check:importer", "test", "cf:check"],
  },
  {
    path: "services/collector-r2-importer",
    scripts: {
      test,
      typecheck,
      "cf:check": dryRun,
      "cf:check:audit-moneyforward": `${dryRun} --config wrangler.audit-moneyforward.jsonc`,
      "cf:check:audit-vpoint": `${dryRun} --config wrangler.audit-v-point.jsonc`,
      "cf:check:audit-vpoint-pay-email": `${dryRun} --config wrangler.audit-v-point-pay-email.jsonc`,
      "cf:check:audit-sbi-vc": `${dryRun} --config wrangler.audit-sbi-vc.jsonc`,
      "cf:check:audit-myjcb": `${dryRun} --config wrangler.audit-myjcb.jsonc`,
      "cf:check:audit-sony-layer-b": `${dryRun} --config wrangler.audit-sony-layer-b.jsonc`,
      "cf:check:audit-smbc-direct": `${dryRun} --config wrangler.audit-smbc-direct.jsonc`,
      "cf:check:audit-smbc-direct-layer-b": `${dryRun} --config wrangler.audit-smbc-direct-layer-b.jsonc`,
      "cf:check:audit-sbi-shinsei": `${dryRun} --config wrangler.audit-sbi-shinsei.jsonc`,
      "cf:check:audit-global-pass-layer-b": `${dryRun} --config wrangler.audit-global-pass-layer-b.jsonc`,
      "cf:check:audit-v-point-pay-layer-b": `${dryRun} --config wrangler.audit-v-point-pay-layer-b.jsonc`,
      "cf:check:audit-moneyforward-layer-b": `${dryRun} --config wrangler.audit-moneyforward-layer-b.jsonc`,
    },
    checks: [
      "test",
      "typecheck",
      "cf:check",
      "cf:check:audit-moneyforward",
      "cf:check:audit-vpoint",
      "cf:check:audit-vpoint-pay-email",
      "cf:check:audit-sbi-vc",
      "cf:check:audit-myjcb",
      "cf:check:audit-sony-layer-b",
      "cf:check:audit-smbc-direct",
      "cf:check:audit-smbc-direct-layer-b",
      "cf:check:audit-sbi-shinsei",
      "cf:check:audit-global-pass-layer-b",
      "cf:check:audit-v-point-pay-layer-b",
      "cf:check:audit-moneyforward-layer-b",
    ],
  },
  worker("mobile-suica-worker"),
  worker("vpoint-worker"),
  worker("vpoint-pay-worker"),
  worker("sony-bank-worker"),
  worker("sbi-securities-worker"),
  worker("moneyforward-worker"),
  {
    path: "poc/myjcb-worker",
    scripts: {
      test,
      typecheck: `${typecheck} && tsc --noEmit -p tsconfig.scripts.json`,
      "cf:check": dryRun,
    },
    checks: ["test", "typecheck", "cf:check"],
  },
  {
    path: "poc/smbc-direct-backfill-worker",
    scripts: {
      test,
      "cf:types": strictTypes,
      typecheck: "bun run cf:types && tsc --noEmit",
      "cf:check": dryRun,
    },
    checks: ["test", "typecheck", "cf:check"],
  },
  {
    path: "poc/sbi-vc-trade-worker",
    scripts: {
      test: "bun run test:unit && bun run test:workers",
      "test:unit": "bun test ./test/*.test.ts",
      "test:workers": "vitest run",
      "cf:types": strictTypes,
      typecheck: "bun run cf:types && tsc --noEmit",
      "cf:check": dryRun,
    },
    checks: ["test", "typecheck", "cf:check"],
  },
  {
    path: "poc/sbi-shinsei-worker",
    scripts: {
      test: "bun test && bash test/admin-token-sync.test.sh && bun run test:relay",
      "test:relay":
        "node --test container/relay-lifecycle.node-test.mjs container/child-lifecycle.node-test.mjs",
      typecheck,
      "cf:check": dryRun,
    },
    checks: ["test", "typecheck", "cf:check"],
    container: "poc/sbi-shinsei-worker/container",
  },
  {
    path: "poc/globalpass-worker",
    scripts: {
      test: "bun test test/diagnostics.test.ts test/worker-collection.test.ts test/model.test.ts test/sanitize.test.ts test/raw-evidence.test.ts test/backfill-script.test.ts test/analyze-turnstile-capture.test.mjs test/analyze-turnstile-debugger-capture.test.mjs test/compare-turnstile-probes.test.mjs && node --test test/connect-relay.node.mjs",
      typecheck,
      "deploy:dry": dryRun,
    },
    checks: ["test", "typecheck", "deploy:dry"],
    container: "poc/globalpass-worker/container",
  },
  ...["cloudflare-browser-run", "tamia-tcp-bridge"].map((name): PackagePolicy => ({
    path: `poc/${name}`,
    scripts: {
      typegen: "wrangler types",
      typecheck: "tsc --noEmit",
      "deploy:dry": dryRun,
    },
    checks: ["typegen", "typecheck", "deploy:dry"],
  })),
  {
    path: "poc/cloudflare-runtime-probe",
    scripts: {
      typegen: "wrangler types",
      typecheck: "tsc --noEmit",
      "typecheck:container": "tsc -p tsconfig.container.json --noEmit",
      "deploy:dry": dryRun,
    },
    checks: ["typegen", "typecheck", "typecheck:container", "deploy:dry"],
  },
  {
    path: "poc/sbi-vc-trade-client",
    scripts: { test, typecheck: "tsc --noEmit" },
    checks: ["test", "typecheck"],
  },
  {
    path: "poc/vpass-json",
    scripts: {
      test,
      typecheck: "tsc --noEmit",
      "cf:types": "wrangler types",
      "cf:check": dryRun,
    },
    checks: ["test", "cf:types", "typecheck"],
    // Equivalent to cf:check, using the installed CLI without script shadowing.
    additionalDryRun: true,
  },
  {
    path: "poc/observation-pipeline",
    scripts: {
      test,
      typecheck: "tsc --noEmit",
      build: "vite build",
      "build:evidence": "vite build --mode evidence --outDir dist-evidence",
      "build:production": "vite build --mode production --outDir dist-production",
      "export:demo":
        "bun run src/export-demo.ts ../../services/evidence-browser/demo-snapshot.json",
    },
    checks: ["typecheck", "build", "build:evidence", "build:production", "test"],
    browser: true,
    // The compatibility re-export of src/parsers/registry.ts pulls the whole
    // parser registry into this package's type check, and two of those parsers
    // import parse5 from packages/parsers. Without its frozen install the
    // check fails on a clean checkout with "cannot find module 'parse5'".
    sharedParserDependencies: true,
  },
];

export const STANDALONE_TESTS = [
  "scripts/ci-package.test.ts",
  // Repository-wide guards live next to the CI policy they protect; every
  // scripts/*.test.ts must be listed here (scripts/ci-package.test.ts checks).
  "scripts/import-boundaries.test.ts",
  "scripts/publication-gate-predicates.test.ts",
  "poc/collector-diagnostics/test/diagnostics.test.ts",
  "poc/sbi-securities/scripts/prepare-sbi-bitwarden-cli-secret.bun.test.ts",
] as const;
export const SYNTAX_ONLY_PACKAGE = "poc/oci-browser-probe";

export function coveredManifests(): string[] {
  return [
    ...CI_PACKAGES.map((policy) => `${policy.path}/package.json`),
    ...CI_PACKAGES.flatMap((policy) =>
      policy.container ? [`${policy.container}/package.json`] : [],
    ),
    `${SYNTAX_ONLY_PACKAGE}/package.json`,
  ].sort();
}
