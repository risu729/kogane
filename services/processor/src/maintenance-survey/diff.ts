// What a page's windows would change in the current maintenance rules
// (ADR 0050). Pure: the result is a list of proposal drafts, and a draft is
// only a proposal. Nothing here, and nothing the lane does with it, writes a
// rule; an operator's acceptance goes through the maintenance writer.
import type {
  ProposalKind,
  ProposalReason,
} from "../../../../packages/collection/src/maintenance-survey-model.ts";
import { PROPOSAL_REASONS } from "../../../../packages/collection/src/maintenance-survey-model.ts";
import type {
  MaintenancePattern,
  MaintenanceRule,
} from "../../../../packages/collection/src/schedule-model.ts";
import { clockOverlap, patternKey, type Extraction, type WindowCandidate } from "./extract.ts";

export interface ProposalDraft {
  kind: ProposalKind;
  /** The rule a `changed`/`absent` draft revises; null for `new`. */
  ruleId: string | null;
  /** That rule's current revision; 0 for `new`. */
  baseRevision: number;
  timezone: string;
  pattern: MaintenancePattern;
  enabled: boolean;
  scope: MaintenanceRule["scope"];
  reasons: ProposalReason[];
}
export interface Diff {
  drafts: ProposalDraft[];
  /** Windows that equal an enabled current rule: nothing to propose. */
  unchanged: number;
}

function sorted(reasons: Iterable<ProposalReason>): ProposalReason[] {
  const set = new Set(reasons);
  return PROPOSAL_REASONS.filter((r) => set.has(r));
}
function same(w: WindowCandidate, rule: MaintenanceRule): boolean {
  return patternKey(w.timezone, w.pattern) === patternKey(rule.timezone, rule.pattern);
}
/**
 * Whether a window plausibly restates `rule` with other times: the same kind,
 * and an overlapping weekday set or the same monthly position with times that
 * overlap, or an overlapping dated interval. A match is a guess about which rule a window revises, which
 * is why every `changed` draft still needs an operator's acceptance.
 */
function corresponds(w: WindowCandidate, rule: MaintenanceRule): boolean {
  const p = w.pattern,
    q = rule.pattern;
  if (p.kind === "weekly" && q.kind === "weekly")
    return (
      w.timezone === rule.timezone &&
      p.weekdays.some((d) => q.weekdays.includes(d)) &&
      clockOverlap(p, q)
    );
  if (p.kind === "monthly" && q.kind === "monthly")
    return (
      w.timezone === rule.timezone &&
      p.weekday === q.weekday &&
      p.nth === q.nth &&
      p.offsetDays === q.offsetDays &&
      clockOverlap(p, q)
    );
  if (p.kind === "once" && q.kind === "once")
    return Date.parse(p.from) < Date.parse(q.to) && Date.parse(q.from) < Date.parse(p.to);
  return false;
}

/**
 * The drafts one page's reading implies against the source's current rules
 * (latest revision of each, enabled or not).
 *
 * - A window equal to an enabled rule is unchanged; equal only to a disabled
 *   one, it is a `changed` draft re-enabling it, for review.
 * - A window that corresponds to exactly one enabled rule is a `changed`
 *   draft against that rule's current revision, keeping the rule's scope; to
 *   several, a `new` draft for review; to none, a `new` draft with the
 *   target's scope.
 * - An enabled rule recorded from this page's URL that no window equals or
 *   corresponds to is an `absent` draft that would disable it — always for
 *   review, and only when the page yielded a window of the same family
 *   (recurring or dated), so a page the grammar cannot read never proposes
 *   removing anything. A dated rule that has ended is not absent, only past.
 */
export function diffWindows(
  extraction: Extraction,
  rules: readonly MaintenanceRule[],
  target: { url: string; scope: MaintenanceRule["scope"] },
  fetchedAt: number,
): Diff {
  const drafts: ProposalDraft[] = [];
  let unchanged = 0;
  const matched = new Set<string>();
  const revises = new Map<string, number>();
  const plans = extraction.windows.map((w) => {
    const equal = rules.filter((rule) => same(w, rule));
    for (const rule of equal) matched.add(rule.id);
    if (equal.some((rule) => rule.enabled)) return { w, equal, near: [] as MaintenanceRule[] };
    const near = rules.filter((rule) => rule.enabled && corresponds(w, rule));
    for (const rule of near) matched.add(rule.id);
    if (equal.length === 0 && near.length === 1)
      revises.set(near[0]!.id, (revises.get(near[0]!.id) ?? 0) + 1);
    return { w, equal, near };
  });
  for (const { w, equal, near } of plans) {
    if (equal.some((rule) => rule.enabled)) {
      unchanged++;
      continue;
    }
    const base = { timezone: w.timezone, pattern: w.pattern, enabled: true };
    if (equal.length > 0) {
      const rule = equal[0]!;
      drafts.push({
        ...base,
        kind: "changed",
        ruleId: rule.id,
        baseRevision: rule.revision,
        scope: rule.scope,
        reasons: sorted([...w.reasons, "rule_disabled_by_operator"]),
      });
    } else if (near.length === 1) {
      const rule = near[0]!;
      // Two windows revising one rule cannot both be accepted against its revision.
      const extra: ProposalReason[] =
        (revises.get(rule.id) ?? 0) > 1 ? ["ambiguous_rule_match"] : [];
      drafts.push({
        ...base,
        kind: "changed",
        ruleId: rule.id,
        baseRevision: rule.revision,
        scope: rule.scope,
        reasons: sorted([...w.reasons, ...extra]),
      });
    } else
      drafts.push({
        ...base,
        kind: "new",
        ruleId: null,
        baseRevision: 0,
        scope: target.scope,
        reasons: sorted([
          ...w.reasons,
          ...(near.length > 1 ? ["ambiguous_rule_match" as const] : []),
        ]),
      });
  }
  for (const rule of rules) {
    if (!rule.enabled || matched.has(rule.id) || rule.referenceUrl !== target.url) continue;
    const dated = rule.pattern.kind === "once";
    if (dated ? !extraction.datedSeen : !extraction.recurringSeen) continue;
    if (rule.pattern.kind === "once" && Date.parse(rule.pattern.to) <= fetchedAt) continue;
    drafts.push({
      kind: "absent",
      ruleId: rule.id,
      baseRevision: rule.revision,
      timezone: rule.timezone,
      pattern: rule.pattern,
      enabled: false,
      scope: rule.scope,
      reasons: ["rule_absent_from_page"],
    });
  }
  return { drafts, unchanged };
}
