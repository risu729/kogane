// Who may do what. This is the placeholder grant loader of addendum 10 §2:
// three grants (owner UI, summary agent, proposal agent) are enough for a
// single user, and no role framework is introduced to get there. A08 replaces
// `staticGrantLoader` with its registry; the `GrantLoader` contract is what
// both sides agree on.
//
// A grant is never read from a request body or from an agent's own assertion.
// The subject comes from the verified identity, and this module decides the
// rest.
import {
  type CommandCapability,
  type GrantLoader,
  type Principal,
  COMMAND_CAPABILITIES,
} from "./contract.ts";

/** What a human operator of this deployment holds. */
export const HUMAN_CAPABILITIES: readonly CommandCapability[] = COMMAND_CAPABILITIES;
/** What an agent holds: it may propose and simulate, never accept. */
export const AGENT_CAPABILITIES: readonly CommandCapability[] = ["interpretation.propose"];

/**
 * `agents` maps a verified subject to an agent grant. Every other subject is
 * the human operator the deployment authenticated. Being unknown therefore
 * never grants more than being known: the authentication boundary already
 * decided that this subject may reach the command path at all.
 */
export function staticGrantLoader(agents: readonly string[]): GrantLoader {
  const agentSet = new Set(agents);
  return {
    principalFor(subject: string): Principal {
      const agent = agentSet.has(subject);
      return {
        id: subject,
        kind: agent ? "agent" : "human",
        verification: "server",
        capabilities: agent ? AGENT_CAPABILITIES : HUMAN_CAPABILITIES,
      };
    },
  };
}

/**
 * Parses the deployment's agent list. The variable is a JSON array of verified
 * subjects; anything else (absent, malformed, not an array of strings) yields
 * no agents, which is the safe direction for a list that only ever *removes*
 * capabilities.
 */
export function agentSubjects(configured: string | undefined): string[] {
  if (!configured) return [];
  try {
    const parsed: unknown = JSON.parse(configured);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.length > 0 && entry.length <= 256,
    );
  } catch {
    return [];
  }
}
