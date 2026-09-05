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
    path: "services/raw-evidence",
    scripts: {
      test: "vitest run && bash test/verify-sbi-shinsei-route.test.sh && bash test/verify-mobile-suica-route.test.sh && bash test/verify-global-pass-route.test.sh && bash test/verify-myjcb-route.test.sh && bash test/verify-v-point-route.test.sh && bash test/verify-vpass-route.test.sh",
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
      "cf:check:audit-vpoint": `${dryRun} --config wrangler.audit-v-point.jsonc`,
    },
    checks: ["test", "typecheck", "cf:check", "cf:check:audit-vpoint"],
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
    scripts: { typegen: "wrangler types", typecheck: "tsc --noEmit", "deploy:dry": dryRun },
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
    scripts: { test, typecheck: "tsc --noEmit", build: "vite build" },
    checks: ["typecheck", "build", "test"],
    browser: true,
  },
];

export const STANDALONE_TESTS = [
  "scripts/ci-package.test.ts",
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
