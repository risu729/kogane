// This Worker's one adapter over the shared principal resolver.
//
// The decision itself lives in `packages/application/src/command/grants.ts`;
// what this file adds is the three things only a transport can do: turn a
// refusal into the HTTP status the code carries, log the misconfiguration
// *code* (never the configured value), and check the verified subject against
// the actor shape before it is graded.
//
// Every command surface of this Worker calls `principalFor` — the change
// lifecycle routes (`command-api.ts`), the operations routes and the
// operations MCP tools (`ops-api.ts`, `ops-tools.ts`). There is no second
// grading anywhere, so a deployment cannot answer one thing on HTTP and
// another on MCP.
import {
  ACTOR_PATTERN,
  type GrantConfigProblem,
  type Principal,
  resolvePrincipal,
  statusForCommandError,
  subjectGrantTable,
  type SubjectGrantVars,
} from "../../../packages/application/src/index";
import { HttpError } from "./http";

export type { SubjectGrantVars };

/**
 * A misconfigured deployment is an operator's problem, so it has to be
 * visible in the logs — as a code. The variable's value, the subjects it
 * named and the parser's own message never appear: a grant list can carry an
 * identity, and a log line is not the place to learn one.
 */
function reportProblem(problem: GrantConfigProblem): void {
  try {
    console.log(JSON.stringify({ event: "grants_misconfigured", problem }));
  } catch {
    /* Observability never changes the answer. */
  }
}

/**
 * The principal of a verified subject, or a refusal.
 *
 * Three outcomes, all closed: a subject outside the actor shape is
 * `403 actor_not_supported`, a subject neither list names is
 * `403 subject_not_granted`, and a deployment whose lists cannot be read is
 * `503 grants_misconfigured` for *everyone* — including a subject that a
 * readable configuration would have graded an agent. Nothing widens.
 */
export function principalFor(env: SubjectGrantVars, subject: string): Principal {
  if (!ACTOR_PATTERN.test(subject)) throw new HttpError(403, "actor_not_supported");
  const resolved = resolvePrincipal(env, subject);
  if (resolved.ok) return resolved.principal;
  if (resolved.problem !== undefined) reportProblem(resolved.problem);
  throw new HttpError(statusForCommandError(resolved.code), resolved.code);
}

/**
 * Whether this deployment's grant lists can be read at all. Used to decide
 * whether the operations MCP tools are *published*: a deployment that grades
 * nobody cannot authorize any of them, and advertising a tool that answers
 * `grants_misconfigured` to every caller is the same mistake in the
 * capability description. A client that calls one anyway still gets the code.
 */
export function grantsUsable(env: SubjectGrantVars): boolean {
  const table = subjectGrantTable(env);
  if (!table.ok) reportProblem(table.problem);
  return table.ok;
}
