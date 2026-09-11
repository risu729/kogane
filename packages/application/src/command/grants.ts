// Who may do what. One resolver, two configured allow-lists, and a refusal
// for every subject they do not name.
//
// This is the deployment's whole authorization table for the command routes,
// the operations routes and the operations MCP tools (addendum 10 §2):
// `OPERATOR_SUBJECTS` names the human operator, `AGENT_GRANTS` names the
// agents. A verified subject in neither list holds *nothing* — no capability,
// no principal, no forwarded actor.
//
// It is deliberately an allow-list on both sides. An earlier version of this
// module graded every unlisted subject as the human operator, so an
// `AGENT_GRANTS` that was absent, unparsable or the wrong shape (an object
// instead of an array) silently promoted an agent to approve and commit. The
// direction that "only ever removes capabilities" is the one where a
// configuration nobody can read grants nobody anything, which is what this
// module now does: an unreadable list denies everyone rather than shrinking.
//
// A grant is never read from a request body or from an agent's own assertion.
// The subject comes from the verified identity, and this module decides the
// rest.
import {
  type CommandCapability,
  type GrantConfigProblem,
  type GrantLoader,
  type PrincipalResolution,
  COMMAND_CAPABILITIES,
} from "./contract.ts";

/** What a human operator of this deployment holds. */
export const HUMAN_CAPABILITIES: readonly CommandCapability[] = COMMAND_CAPABILITIES;
/** What an agent holds: it may propose and simulate, never accept. */
export const AGENT_CAPABILITIES: readonly CommandCapability[] = ["interpretation.propose"];

/**
 * The actor shape the decision log accepts. A verified subject outside it is
 * refused before it is graded, so no adapter has to re-derive the pattern.
 */
export const ACTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;

/** Largest either list may be. A longer one is a configuration mistake. */
export const MAX_SUBJECTS_PER_LIST = 64;
/** Longest subject either list may carry. */
export const MAX_SUBJECT_LENGTH = 256;

/**
 * The two variables this resolver reads. Typed on the variables rather than on
 * a Worker `Env`, because a generated `Env` narrows a var declared in
 * wrangler.jsonc to its configured literal.
 */
export interface SubjectGrantVars {
  /** JSON array of verified subjects that are the human operator. */
  OPERATOR_SUBJECTS?: string | undefined;
  /** JSON array of verified subjects that are agents. */
  AGENT_GRANTS?: string | undefined;
}

export interface SubjectGrants {
  ok: true;
  operators: ReadonlySet<string>;
  agents: ReadonlySet<string>;
}
export interface GrantConfigError {
  ok: false;
  code: "grants_misconfigured";
  problem: GrantConfigProblem;
}
export type SubjectGrantTable = SubjectGrants | GrantConfigError;

/**
 * Parses one subject list, or `null` when it cannot be read.
 *
 * Absent, empty or whitespace is the empty list. That is the committed default
 * of both variables and it denies everyone — intended, and the state a
 * deployment stays in until it names its operator. Anything *present* but
 * unreadable (not a string, not JSON, not an array, an entry that is not a
 * non-empty bounded string, more entries than the bound) is `null`, never a
 * silently shorter list: dropping an unreadable entry from `AGENT_GRANTS` used
 * to promote that subject to the operator role, and reading a var declared as
 * a JSON array or object (rather than the string that carries one) as *empty*
 * would deny everyone without ever reporting why.
 */
export function parseSubjectList(configured: string | undefined | null): string[] | null {
  if (configured === undefined || configured === null) return [];
  if (typeof configured !== "string") return null;
  if (configured.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(configured);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_SUBJECTS_PER_LIST) return null;
  const subjects: string[] = [];
  for (const entry of parsed as unknown[]) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > MAX_SUBJECT_LENGTH)
      return null;
    subjects.push(entry);
  }
  // A duplicate inside one list names the same role twice; the set absorbs it.
  return [...new Set(subjects)];
}

/**
 * The deployment's grant table, or the reason it cannot be used.
 *
 * An overlap between the lists is a refusal rather than a precedence rule: a
 * subject that is both the operator and an agent has no defined role, and
 * picking one would be exactly the guess this module exists not to make.
 */
export function subjectGrantTable(vars: SubjectGrantVars): SubjectGrantTable {
  const operators = parseSubjectList(vars.OPERATOR_SUBJECTS);
  if (operators === null)
    return { ok: false, code: "grants_misconfigured", problem: "operator_subjects_invalid" };
  const agents = parseSubjectList(vars.AGENT_GRANTS);
  if (agents === null)
    return { ok: false, code: "grants_misconfigured", problem: "agent_grants_invalid" };
  const agentSet = new Set(agents);
  if (operators.some((subject) => agentSet.has(subject)))
    return { ok: false, code: "grants_misconfigured", problem: "subject_in_both_lists" };
  return { ok: true, operators: new Set(operators), agents: agentSet };
}

/**
 * Grades one verified subject against one deployment's configuration. This is
 * the single resolver every command surface uses — the HTTP command routes,
 * the operations routes and the operations MCP tools — so one deployment has
 * one answer to "what is this subject".
 *
 * A denied subject never becomes a `Principal`: there is no capability-less
 * principal that could leak into a forwarded actor header or a decision row.
 */
export function resolvePrincipal(vars: SubjectGrantVars, subject: string): PrincipalResolution {
  const table = subjectGrantTable(vars);
  if (!table.ok) return { ok: false, code: table.code, problem: table.problem };
  return principalIn(table, subject);
}

/** The same grading against an already parsed table. */
export function principalIn(grants: SubjectGrants, subject: string): PrincipalResolution {
  if (grants.operators.has(subject))
    return {
      ok: true,
      principal: {
        id: subject,
        kind: "human",
        verification: "server",
        capabilities: HUMAN_CAPABILITIES,
      },
    };
  if (grants.agents.has(subject))
    return {
      ok: true,
      principal: {
        id: subject,
        kind: "agent",
        verification: "server",
        capabilities: AGENT_CAPABILITIES,
      },
    };
  return { ok: false, code: "subject_not_granted" };
}

/**
 * A loader over one deployment's configuration, parsed once. `GrantLoader` is
 * the contract A08's registry must satisfy; this is the two-list
 * implementation of it.
 */
export function configuredGrantLoader(vars: SubjectGrantVars): GrantLoader {
  const table = subjectGrantTable(vars);
  return {
    principalFor(subject: string): PrincipalResolution {
      return table.ok
        ? principalIn(table, subject)
        : { ok: false, code: table.code, problem: table.problem };
    },
  };
}
