// The deployment ledger guard (unified plan 11 §4, acceptance G5-09, G5-10,
// G5-11, G5-14, G5-15, G5-17).
//
// `infra/deploy-order.json` answers three questions that CD cannot work out for
// itself: which Wrangler configurations are deployed at all, in what order, and
// how a deployed Worker is checked afterwards. It is hand-maintained, so the
// helpers here keep it honest:
//
//   * every configuration the CI ledger validates appears exactly once, so a
//     new Worker cannot be dry-run in CI and then silently never deployed (or
//     the reverse). Configurations the CI ledger excludes with a reason —
//     bootstrap, test-harness and `wrangler dev` helpers — must stay
//     non-deployable here too;
//   * consumers precede producers. A new protocol is deployed to the side that
//     reads it before the side that writes it (plan 11 §4, G5-14);
//   * the deploy steps of `.github/workflows/_deploy-workers.yml` are exactly
//     the `deploy: true` entries, in the ledger's order. The workflow cannot
//     iterate a JSON array over `uses:` steps, so this is what makes the file
//     the ledger's order rather than a second, drifting one (G5-15);
//   * no workflow builds a preview or staging deployment (G5-10), and no bank
//     secret is ever named in an Actions file (plan 12 §5, G5-17).
import { readFileSync } from "node:fs";
import { REPO_ROOT, trackedFiles } from "./repo-root.ts";

/** One Worker the release pipeline knows about. */
export interface DeployEntry {
  name: string;
  path: string;
  config: string;
  worker: string;
  role: "consumer" | "producer" | "probe";
  deploy: boolean;
  /**
   * The route the release postcheck requests, or "" when CD checks the Worker
   * another way — the Processor answers through the App's service binding
   * (`services/processor/src/internal-health.ts`) — or not at all.
   */
  healthPath: string;
  /**
   * How CD authenticates that route: `access` sends the Cloudflare Access
   * service token of the `production` Environment, `none` is an
   * unauthenticated route. Meaningless, and therefore `none`, when there is no
   * route to request.
   */
  healthAuth: "access" | "none";
  /**
   * The field of the JSON answer the postcheck requires to be present and
   * non-empty — the Worker's own identity in its health body. Absent exactly
   * when `healthPath` is "".
   */
  healthIdentity?: string;
  bundleTask?: string;
  bundleDir?: string;
}

/** A database whose migrations the release applies. */
export interface SchemaTarget {
  database: string;
  binding: string;
  path: string;
  config: string;
}

export interface DeployOrder {
  workersDevSubdomain: string;
  schema: { core: SchemaTarget; read: SchemaTarget | null };
  workers: DeployEntry[];
}

/** A `<path>/<config>` pair, the identity of a Wrangler configuration. */
export function configOf(entry: { path: string; config: string }): string {
  return `${entry.path}/${entry.config}`;
}

const ROLES = new Set(["consumer", "producer", "probe"]);

/** Whatever is wrong with one entry of the ledger. */
export function entryViolations(entry: DeployEntry): string[] {
  const errors: string[] = [];
  const where = `infra/deploy-order.json: ${entry.name}`;
  if (!ROLES.has(entry.role)) errors.push(`${where}: unknown role ${entry.role}`);
  if (typeof entry.deploy !== "boolean") errors.push(`${where}: deploy must be true or false`);
  if (typeof entry.healthPath !== "string") errors.push(`${where}: healthPath must be a string`);
  else if (entry.healthPath !== "" && !entry.healthPath.startsWith("/"))
    errors.push(`${where}: healthPath must be empty or start with "/"`);
  if (entry.healthAuth !== "access" && entry.healthAuth !== "none")
    errors.push(`${where}: healthAuth must be "access" or "none"`);
  if (entry.healthPath === "") {
    // Nothing is requested, so there is nothing to authenticate and no field to
    // assert. An entry that names one would be describing a check CD does not
    // make (unified plan 11 §6).
    if (entry.healthAuth !== "none")
      errors.push(`${where}: healthAuth must be "none" without a healthPath`);
    if (entry.healthIdentity !== undefined)
      errors.push(`${where}: healthIdentity needs a healthPath`);
  } else if (
    entry.healthIdentity === undefined ||
    !/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(entry.healthIdentity)
  ) {
    errors.push(`${where}: a health route needs a healthIdentity field name`);
  }
  if (entry.deploy) {
    if (entry.bundleTask === undefined || entry.bundleDir === undefined)
      errors.push(`${where}: a deployed Worker needs a bundleTask and a bundleDir`);
    else if (entry.bundleDir !== `dist/${entry.name}`)
      errors.push(`${where}: bundleDir must be dist/${entry.name}`);
  } else if (entry.bundleTask !== undefined || entry.bundleDir !== undefined) {
    errors.push(`${where}: a Worker that is not deployed needs no bundle`);
  }
  return errors;
}

/**
 * The ledger against the CI worker ledger: one entry per validated
 * configuration, no duplicates, and nothing deployable that CI excluded.
 */
export function coverageViolations(
  order: readonly DeployEntry[],
  workers: readonly { name: string; path: string; config: string }[],
  excluded: readonly { path: string; config: string }[],
): string[] {
  const errors: string[] = [];
  const seen = new Map<string, number>();
  for (const entry of order) seen.set(configOf(entry), (seen.get(configOf(entry)) ?? 0) + 1);
  for (const [config, count] of seen) {
    if (count > 1)
      errors.push(`infra/deploy-order.json: ${config} is listed ${String(count)} times`);
  }
  const listed = new Set(order.map(configOf));
  for (const worker of workers) {
    if (!listed.has(configOf(worker)))
      errors.push(
        `infra/deploy-order.json: ${configOf(worker)} is validated by CI but has no deploy decision`,
      );
  }
  const validated = new Set(workers.map(configOf));
  for (const entry of order) {
    if (!validated.has(configOf(entry)))
      errors.push(`infra/deploy-order.json: ${configOf(entry)} is not in infra/workers-ci.json`);
  }
  const skipped = new Set(excluded.map(configOf));
  for (const entry of order) {
    if (entry.deploy && skipped.has(configOf(entry)))
      errors.push(
        `infra/deploy-order.json: ${configOf(entry)} is excluded from CI and must not be deployed`,
      );
  }
  const names = new Set<string>();
  for (const entry of order) {
    if (names.has(entry.name)) errors.push(`infra/deploy-order.json: duplicate name ${entry.name}`);
    names.add(entry.name);
  }
  return errors;
}

/**
 * Consumers before producers, probes last (plan 11 §4). Producers write the
 * shared contract; deploying them first would hand a reader a message it cannot
 * yet understand.
 */
export function orderViolations(order: readonly DeployEntry[]): string[] {
  const rank = { consumer: 0, producer: 1, probe: 2 } as const;
  const errors: string[] = [];
  for (let index = 1; index < order.length; index += 1) {
    const previous = order[index - 1] as DeployEntry;
    const current = order[index] as DeployEntry;
    const before = rank[previous.role];
    const after = rank[current.role];
    if (before !== undefined && after !== undefined && after < before) {
      errors.push(
        `infra/deploy-order.json: ${current.name} (${current.role}) is listed after ${previous.name} (${previous.role}); consumers deploy first`,
      );
    }
  }
  return errors;
}

/** One `risu729/wrangler-deploy-action` step of a workflow. */
export interface DeployStep {
  name: string;
  /** Step id, which `release-ledger.mjs progress` reads per Worker. */
  id: string;
  mode: string;
  workingDirectory: string;
  config: string;
  usesToken: boolean;
}

function field(text: string, key: string): string {
  return new RegExp(`^\\s*${key}:[ \\t]*(\\S+)[ \\t]*$`, "mu").exec(text)?.[1] ?? "";
}

/** Steps of a workflow file, split on the `- name:` that opens each one. */
export function workflowSteps(text: string): { name: string; body: string }[] {
  const steps: { name: string; body: string }[] = [];
  for (const body of text.split(/\n(?=[ \t]*- name: )/u)) {
    if (!body.trimStart().startsWith("- name:")) continue;
    steps.push({ name: (/^[ \t]*- name:[ \t]*(.+)$/mu.exec(body)?.[1] ?? "").trim(), body });
  }
  return steps;
}

/** The production deploy steps of `_deploy-workers.yml`, in file order. */
export function deploySteps(text: string): DeployStep[] {
  return workflowSteps(text)
    .filter((step) => step.body.includes("risu729/wrangler-deploy-action@"))
    .map((step) => ({
      name: step.name,
      id: field(step.body, "id"),
      mode: field(step.body, "mode"),
      workingDirectory: field(step.body, "working-directory"),
      config: field(step.body, "config"),
      usesToken: step.body.includes("secrets.CLOUDFLARE_API_TOKEN"),
    }));
}

/**
 * The deploy steps against the ledger: same configurations, same order, every
 * one in `production` mode with the environment token, and each one identified
 * as `deploy-<ledger name>` so the release record can say what happened to that
 * Worker.
 */
export function deployStepMismatches(
  order: readonly DeployEntry[],
  steps: readonly DeployStep[],
): string[] {
  const expected = order.filter((entry) => entry.deploy);
  const errors: string[] = [];
  if (expected.length !== steps.length) {
    errors.push(
      `.github/workflows/_deploy-workers.yml: ${String(steps.length)} deploy steps for ${String(expected.length)} deployed Workers`,
    );
  }
  const length = Math.min(expected.length, steps.length);
  for (let index = 0; index < length; index += 1) {
    const entry = expected[index] as DeployEntry;
    const step = steps[index] as DeployStep;
    if (step.workingDirectory !== entry.path || step.config !== entry.config) {
      errors.push(
        `.github/workflows/_deploy-workers.yml: step ${String(index + 1)} deploys ${step.workingDirectory}/${step.config}, the ledger expects ${configOf(entry)}`,
      );
    }
    if (step.mode !== "production")
      errors.push(
        `.github/workflows/_deploy-workers.yml: step ${String(index + 1)} is not mode: production`,
      );
    if (!step.usesToken)
      errors.push(
        `.github/workflows/_deploy-workers.yml: step ${String(index + 1)} passes no deploy token`,
      );
    if (step.id !== `deploy-${entry.name}`)
      errors.push(
        `.github/workflows/_deploy-workers.yml: step ${String(index + 1)} must set "id: deploy-${entry.name}", not "${step.id}"; release-ledger.mjs reads that id to record what happened to ${entry.name}`,
      );
  }
  return errors;
}

/** The reusable workflow that owns the production credentials. */
export const DEPLOY_WORKFLOW = ".github/workflows/_deploy-workers.yml";

/**
 * Every caller of the release workflow must pass `secrets: inherit`.
 *
 * The Cloudflare credentials are scoped to the `production` Environment, which
 * only the called workflow's job declares. GitHub resolves a called workflow's
 * `secrets.*` from what the caller passed, and an unpassed secret is an empty
 * string, not an error — so a caller without `secrets: inherit` produces a
 * release that builds everything, opens a deployment record and then fails on
 * `wrangler`'s "necessary to set a CLOUDFLARE_API_TOKEN environment variable"
 * with nothing applied (run 34635388395). Named pass-through is not an
 * alternative: it resolves in the caller, where the environment is not in
 * scope.
 */
export function credentialWiringViolations(
  files: readonly { file: string; text: string }[],
): string[] {
  const errors: string[] = [];
  for (const { file, text } of files) {
    if (file === DEPLOY_WORKFLOW) continue;
    if (!/^[ \t]*uses:[ \t]*\.\/\.github\/workflows\/_deploy-workers\.yml\b/mu.test(text)) continue;
    if (!/^[ \t]*secrets:[ \t]*inherit[ \t]*$/mu.test(text))
      errors.push(
        `${file}: calls ${DEPLOY_WORKFLOW} without "secrets: inherit"; the production environment secret would be empty`,
      );
  }
  return errors;
}

/** Modes the pinned deploy Action may run in. There is no preview lane. */
const ALLOWED_MODES = new Set(["dry-run", "production"]);

/**
 * No workflow may build a preview deployment or name an environment other than
 * `production` (unified plan 11 §1, acceptance G5-10), and no workflow or
 * automation script may name a collector secret (plan 12 §5, G5-17).
 */
export function automationViolations(
  files: readonly { file: string; text: string }[],
  secretNames: readonly string[],
): string[] {
  const errors: string[] = [];
  for (const { file, text } of files) {
    // The YAML shape rules apply to workflows; the secret rule applies to every
    // file an Actions run executes, scripts included.
    const workflow = file.endsWith(".yml") || file.endsWith(".yaml");
    for (const step of workflow ? workflowSteps(text) : []) {
      if (!step.body.includes("risu729/wrangler-deploy-action@")) continue;
      const mode = field(step.body, "mode");
      if (!ALLOWED_MODES.has(mode))
        errors.push(`${file}: deploy mode ${mode || "(unset)"} is not allowed`);
      if (/^[ \t]*preview-alias[ \t]*:/mu.test(step.body))
        errors.push(`${file}: a preview alias deployment is out of scope`);
    }
    if (workflow) {
      for (const match of text.matchAll(/^[ \t]*environment:[ \t]*(\S+)[ \t]*$/gmu)) {
        if (match[1] !== "production")
          errors.push(`${file}: environment ${String(match[1])} is not part of this repository`);
      }
      if (/^[ \t]*secrets-json[ \t]*:/mu.test(text))
        errors.push(`${file}: the deploy Action's secrets-json input must not be used`);
    }
    for (const name of secretNames) {
      if (new RegExp(`\\b${name}\\b`, "u").test(text))
        errors.push(`${file}: names the collector secret ${name}; CD never synchronises one`);
    }
  }
  return errors;
}

/** Every distinct secret name the resource ledger records for any Worker. */
export function collectorSecretNames(resources: unknown): string[] {
  const names = new Set<string>();
  const directories = (
    resources as { directories?: { workers?: { requiredSecretNames?: string[] }[] }[] }
  ).directories;
  for (const directory of directories ?? []) {
    for (const worker of directory.workers ?? []) {
      for (const name of worker.requiredSecretNames ?? []) names.add(name);
    }
  }
  return [...names].sort();
}

/** The ledger and the workflows as they are in this checkout. */
export function readDeployOrder(root: string = REPO_ROOT): DeployOrder {
  return JSON.parse(readFileSync(`${root}/infra/deploy-order.json`, "utf8")) as DeployOrder;
}

/** Tracked Actions files (workflows and automation scripts) with their text. */
export function automationFiles(root: string = REPO_ROOT): { file: string; text: string }[] {
  return trackedFiles(".github/workflows", ".github/scripts").map((file) => ({
    file,
    text: readFileSync(`${root}/${file}`, "utf8"),
  }));
}
