// The own-transfer planners for the four economic-event command kinds (ADR
// 0057, G3-a; ADR 0054's G2 vocabulary). Each is an `EconomicEventPlanner`,
// the existing contract of `targets.ts`: it reads the store and either
// resolves a plan (targets, expected revisions, a counts-only simulation) or
// refuses with a closed code as its second ref.
//
// They are NOT registered. `ECONOMIC_EVENT_PLANNERS` stays empty and the
// processor's writer slot answers null, so the change lifecycle refuses every
// economic-event command exactly as before G3-a. The reason is ADR 0054's
// production gate (remote D1 conformance and the unlogged-revision check are
// not done), not a rule about who may act. Registering them, and a writer, is
// a later change behind that gate (ADR 0057, Rollback: unregistered is off).
//
// What they read, by key, never through the UNION views a trigger avoids:
// the proposal and its retirement (CORE 0072), the cited rows (re-deriving
// each 5-tuple and alias class), the live holders of each key and alias class
// in book `cash-movement` (`economic_claims` and accepted card settlements,
// CORE 0070), each event's head revision, seal and commit, and the current
// identity epoch. A plan pins each event head (`economic-event:<id>`), which
// the commit re-verifies in its first statement.
//
// Counts and identifiers only: no amount, no provider text.
import {
  aliasClassText,
  bookClaimId,
  consumptionKeyText,
  economicEventSubject,
  releasedBookClaims,
  sameBookClaims,
  type AliasClass,
  type BookClaim,
} from "../../../domain/src/economic-contract.ts";
import type {
  EconomicEventCorrectPayload,
  EconomicEventMovePayload,
  EconomicEventWithdrawPayload,
  RestatedRevision,
} from "../../../domain/src/economic-event-commands.ts";
import {
  OWN_TRANSFER_FAMILY,
  OWN_TRANSFER_WRITER_RELEASE,
  ownTransferEventId,
  ownTransferProposalRef,
} from "../../../domain/src/own-transfer-proposals.ts";
import { humanAdoptedRowIdentity } from "../../../domain/src/row-identity.ts";
import type {
  ChangePayload,
  CommandStore,
  EconomicEventCommandKind,
  PlanTarget,
} from "../command/contract.ts";
import { commandError, type CommandError, type CommandResult } from "../command/errors.ts";
import type { EconomicEventPlanner, ResolvedPlan } from "./targets.ts";

/** The closed codes a refusal carries as its second ref. */
export const OWN_TRANSFER_PLAN_REFUSALS = [
  "family_unsupported",
  "proposal_missing",
  "proposal_not_in_force",
  "proposal_needs_review",
  "proposal_adopted",
  "withdrawn_readoption",
  "evidence_changed",
  "identity_rekeyed",
  "identity_epoch_changed",
  "identity_absent",
  "identity_fingerprint_only",
  "identity_digest_not_provider",
  "identity_origin_unrecorded",
  "identity_resolver_missing",
  "alias_conflict",
  "economic_claim_held",
  "economic_claim_conflict_unresolved",
  "event_not_own_transfer",
  "knowledge_unlogged",
  "revision_not_head",
  "already_withdrawn",
  "decision_epoch_mismatch",
  "released_claims_mismatch",
  "restatement_unsupported",
  "claim_without_leg",
  "move_claim_not_held",
  "move_restates_other_claims",
  "row_new_to_event",
  "leg_account_changed",
] as const;
type OwnTransferPlanRefusal = (typeof OWN_TRANSFER_PLAN_REFUSALS)[number];

const CURRENT_EPOCH = `(SELECT e.identity_epoch FROM economic_identity_epochs e ORDER BY e.ordinal DESC LIMIT 1)`;

const OWN_TRANSFER_PROPOSAL_SQL = `SELECT p.proposal_id,p.status,p.identity_epoch,
 p.debit_observation_id,p.debit_parse_run_id,p.debit_consumption_key,p.debit_alias_class,p.debit_account_id,
 p.credit_observation_id,p.credit_parse_run_id,p.credit_consumption_key,p.credit_alias_class,p.credit_account_id,
 (SELECT r.reason_code FROM own_transfer_proposal_retirements r WHERE r.proposal_id=p.proposal_id) AS retired,
 ${CURRENT_EPOCH} AS current_epoch
 FROM own_transfer_proposals p WHERE p.proposal_id=?1`;

/** Another unretired proposal citing either alias class (served by 0072's alias indexes). */
const OWN_TRANSFER_COMPETING_SQL = `SELECT count(*) AS n FROM own_transfer_proposals o
 WHERE o.proposal_id<>?1 AND (o.debit_alias_class IN (?2,?3) OR o.credit_alias_class IN (?2,?3))
 AND NOT EXISTS(SELECT 1 FROM own_transfer_proposal_retirements r WHERE r.proposal_id=o.proposal_id)`;

/** One cited row with its own key, as CORE 0070's claim trigger derives it. */
const OWN_TRANSFER_ROW_SQL = `SELECT a.source_id,p.parser_name,t.source_account,t.external_id,t.extra_json,
 json_array(a.source_id,fr.producer_id,ses.external_id_namespace,t.source_account,t.external_id) AS consumption_key
 FROM transaction_observations t JOIN parse_runs p ON p.id=t.parse_run_id
 JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id JOIN fetch_runs fr ON fr.id=a.fetch_run_id
 JOIN acquisition_sessions ses ON ses.id=fr.acquisition_session_id
 WHERE t.id=?1 AND t.parse_run_id=?2 AND t.external_id IS NOT NULL AND t.external_id<>''`;

/** Live holders of one key in book cash-movement, each source by its own key index. */
const OWN_TRANSFER_KEY_HOLDERS_SQL = `SELECT x.event_id FROM economic_claims x
 JOIN economic_event_revisions r ON r.event_id=x.event_id AND r.revision=x.revision
 WHERE x.book='cash-movement' AND x.consumption_key=?1 AND r.superseded_by IS NULL
 UNION ALL
 SELECT d.event_id FROM card_settlement_candidates k
 JOIN card_settlement_decisions d ON d.proposal_id=k.id AND d.status='accepted'
 JOIN economic_event_revisions r ON r.event_id=d.event_id AND r.revision=d.revision
 WHERE k.bank_key=?1 AND r.superseded_by IS NULL`;

/** Live holders of one alias class in book cash-movement, with the key they hold it under. */
const OWN_TRANSFER_ALIAS_HOLDERS_SQL = `SELECT x.event_id,x.consumption_key FROM economic_claims x
 JOIN economic_event_revisions r ON r.event_id=x.event_id AND r.revision=x.revision
 WHERE x.book='cash-movement' AND x.alias_class=?1 AND r.superseded_by IS NULL`;

/** An event's highest revision, its seal and whether a commit row logs it. */
const OWN_TRANSFER_HEAD_SQL = `SELECT r.revision,r.kind,r.state,r.superseded_by,r.decision_revision_id,
 s.writer_release,s.identity_epoch AS seal_epoch,
 EXISTS(SELECT 1 FROM economic_commit_log l WHERE l.core_epoch=s.core_epoch AND l.commit_seq=s.commit_seq) AS logged,
 ${CURRENT_EPOCH} AS current_epoch
 FROM economic_event_revisions r
 LEFT JOIN economic_revision_seals s ON s.event_id=r.event_id AND s.revision=r.revision
 WHERE r.event_id=?1 ORDER BY r.revision DESC LIMIT 1`;

const OWN_TRANSFER_CLAIMS_SQL = `SELECT book,consumption_key,alias_class FROM economic_claims
 WHERE event_id=?1 AND revision=?2 ORDER BY book,consumption_key`;

interface ProposalRow {
  proposal_id: string;
  status: string;
  identity_epoch: string;
  debit_observation_id: number;
  debit_parse_run_id: number;
  debit_consumption_key: string;
  debit_alias_class: string;
  debit_account_id: string;
  credit_observation_id: number;
  credit_parse_run_id: number;
  credit_consumption_key: string;
  credit_alias_class: string;
  credit_account_id: string;
  retired: string | null;
  current_epoch: string | null;
}
interface RowRow {
  source_id: string;
  parser_name: string;
  source_account: string;
  external_id: string;
  extra_json: string | null;
  consumption_key: string;
}
interface HeadRow {
  revision: number;
  kind: string;
  state: string;
  superseded_by: string | null;
  decision_revision_id: string;
  writer_release: string | null;
  seal_epoch: string | null;
  logged: number;
  current_epoch: string | null;
}
interface ClaimRow {
  book: string;
  consumption_key: string;
  alias_class: string | null;
}

type Refusal = CommandError;
const refuse = (
  error: Parameters<typeof commandError>[0],
  subject: string,
  code: OwnTransferPlanRefusal,
): Refusal => commandError(error, [subject, code]);

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A cited row, re-derived: its key must be the one stated, its alias class recomputed. */
async function rederive(
  store: CommandStore,
  subject: string,
  leg: { observationId: number; parseRunId: number; key: string; accountId: string },
): Promise<{ ok: true; aliasClass: AliasClass; sourceId: string } | Refusal> {
  const row = await store.first<RowRow>(OWN_TRANSFER_ROW_SQL, [leg.observationId, leg.parseRunId]);
  if (!row || row.consumption_key !== leg.key)
    return refuse("stale_context", subject, "evidence_changed");
  return admitStoredRow(subject, row, leg.accountId);
}

/** A row already read, admitted under an account through ADR 0054's identity rules. */
function admitStoredRow(
  subject: string,
  row: RowRow,
  accountId: string,
): { ok: true; aliasClass: AliasClass; sourceId: string } | Refusal {
  const identity = humanAdoptedRowIdentity({
    sourceId: row.source_id,
    parserName: row.parser_name,
    sourceAccount: row.source_account,
    externalId: row.external_id,
    extra: parseJson(row.extra_json),
    accountId,
  });
  if (!identity.admitted) return refuse("needs_scope_resolution", subject, identity.refusal);
  return { ok: true, aliasClass: identity.aliasClass, sourceId: row.source_id };
}

/**
 * Whether a key or an alias class has a live holder outside `own` (the event
 * ids whose priors the plan supersedes). The alias class is checked first,
 * as CORE 0070 reports it first.
 */
async function heldElsewhere(
  store: CommandStore,
  subject: string,
  key: string,
  aliasClass: string,
  own: ReadonlySet<string>,
): Promise<Refusal | null> {
  const aliases = await store.all<{ event_id: string; consumption_key: string }>(
    OWN_TRANSFER_ALIAS_HOLDERS_SQL,
    [aliasClass],
  );
  if (aliases.some((holder) => !own.has(holder.event_id) || holder.consumption_key !== key))
    return refuse("stale_context", subject, "alias_conflict");
  const keys = await store.all<{ event_id: string }>(OWN_TRANSFER_KEY_HOLDERS_SQL, [key]);
  if (keys.some((holder) => !own.has(holder.event_id)))
    return refuse("stale_context", subject, "economic_claim_held");
  return null;
}

/** A released key that another live holder keeps: a double holder no release may wash. */
async function releaseConflict(
  store: CommandStore,
  subject: string,
  released: readonly BookClaim[],
  own: ReadonlySet<string>,
): Promise<Refusal | null> {
  for (const claim of released) {
    const holders = await store.all<{ event_id: string }>(OWN_TRANSFER_KEY_HOLDERS_SQL, [
      consumptionKeyText(claim.key),
    ]);
    if (holders.some((holder) => !own.has(holder.event_id)))
      return refuse("needs_scope_resolution", subject, "economic_claim_conflict_unresolved");
  }
  return null;
}

function claimsOf(rows: readonly ClaimRow[]): BookClaim[] {
  return rows.map((row) => ({
    book: row.book as BookClaim["book"],
    key: JSON.parse(row.consumption_key) as BookClaim["key"],
  }));
}

/**
 * The head of an own-transfer event, checked for a plan that supersedes
 * `revision`: it exists, the own-transfer writer sealed it and a commit row
 * logs it, it is the live head, and it is not withdrawn. A stale identity
 * epoch routes the event to review when the plan restates claims.
 */
async function ownTransferHead(
  store: CommandStore,
  eventId: string,
  revision: number,
  options: { restates: boolean },
): Promise<
  { ok: true; head: HeadRow; claims: BookClaim[]; accounts: Map<string, string> } | Refusal
> {
  const subject = economicEventSubject(eventId);
  const head = await store.first<HeadRow>(OWN_TRANSFER_HEAD_SQL, [eventId]);
  if (!head) return commandError("target_missing", [subject]);
  if (head.writer_release !== OWN_TRANSFER_WRITER_RELEASE || head.kind !== "transfer")
    return refuse("unsupported_semantics", subject, "event_not_own_transfer");
  if (head.logged !== 1) return refuse("needs_scope_resolution", subject, "knowledge_unlogged");
  if (head.revision !== revision || head.superseded_by !== null)
    return refuse("stale_context", subject, "revision_not_head");
  if (head.state === "unknown")
    return options.restates
      ? refuse("needs_scope_resolution", subject, "withdrawn_readoption")
      : refuse("stale_context", subject, "already_withdrawn");
  if (options.restates && head.seal_epoch !== head.current_epoch)
    return refuse("needs_scope_resolution", subject, "identity_epoch_changed");
  const rows = await store.all<ClaimRow>(OWN_TRANSFER_CLAIMS_SQL, [eventId, head.revision]);
  return {
    ok: true,
    head,
    claims: claimsOf(rows),
    accounts: await knownAccounts(store, eventId, rows),
  };
}

/**
 * The account each row the event already cites was adopted under, by its
 * 5-tuple: from the prior revision's claims (the account their alias class
 * carries) and from the proposal the event adopted. A restated leg must keep
 * that account; a row the event never cited has no account to keep, and is
 * refused until an ownership read exists (ADR 0057, Limits).
 */
async function knownAccounts(
  store: CommandStore,
  eventId: string,
  claims: readonly ClaimRow[],
): Promise<Map<string, string>> {
  const accounts = new Map<string, string>();
  for (const claim of claims) {
    const alias = parseJson(claim.alias_class);
    if (Array.isArray(alias) && typeof alias[2] === "string")
      accounts.set(claim.consumption_key, alias[2]);
  }
  const prefix = ownTransferEventId("");
  if (eventId.startsWith(prefix)) {
    const proposal = await store.first<ProposalRow>(OWN_TRANSFER_PROPOSAL_SQL, [
      eventId.slice(prefix.length),
    ]);
    if (proposal) {
      accounts.set(proposal.debit_consumption_key, proposal.debit_account_id);
      accounts.set(proposal.credit_consumption_key, proposal.credit_account_id);
    }
  }
  return accounts;
}

const TRANSACTION_ID = /^transaction:([1-9][0-9]*)$/u;
const PARSE_RUN = /^parse_run:([1-9][0-9]*)$/u;

/**
 * A restated revision, read against the store: a transfer whose claims are
 * cash-movement keys of the rows its legs cite, each row admitted under the
 * leg's account, and every claim not already held by one of `own` free.
 */
async function checkRestatement(
  store: CommandStore,
  subject: string,
  revision: RestatedRevision,
  own: ReadonlySet<string>,
  priorClaims: readonly BookClaim[],
  accounts: ReadonlyMap<string, string>,
): Promise<{ ok: true; sources: string[]; parseRuns: number[] } | Refusal> {
  if (
    revision.kind !== "transfer" ||
    revision.claims.some((claim) => claim.book !== "cash-movement")
  )
    return refuse("needs_scope_resolution", subject, "restatement_unsupported");
  const legKeys = new Map<string, { aliasClass: AliasClass; sourceId: string }>();
  const parseRuns = new Set<number>();
  for (const leg of revision.legs) {
    const id = TRANSACTION_ID.exec(leg.source.id);
    const run = PARSE_RUN.exec(leg.source.revision);
    if (!id || !run) return refuse("needs_scope_resolution", subject, "restatement_unsupported");
    const row = await store.first<RowRow>(OWN_TRANSFER_ROW_SQL, [Number(id[1]), Number(run[1])]);
    if (!row) return refuse("stale_context", subject, "evidence_changed");
    const accountId = leg.subjectRef.slice("account:".length);
    const derived = admitStoredRow(subject, row, accountId);
    if (!derived.ok) return derived;
    // The alias class carries the account, so a row restated under another
    // account would pass the holder check as another fact (INV06).
    const known = accounts.get(row.consumption_key);
    if (known === undefined) return refuse("needs_scope_resolution", subject, "row_new_to_event");
    if (known !== accountId)
      return refuse("needs_scope_resolution", subject, "leg_account_changed");
    legKeys.set(row.consumption_key, derived);
    parseRuns.add(Number(run[1]));
  }
  const prior = new Set(priorClaims.map(bookClaimId));
  for (const claim of revision.claims) {
    const key = consumptionKeyText(claim.key);
    const derived = legKeys.get(key);
    if (!derived) return refuse("needs_scope_resolution", subject, "claim_without_leg");
    // A claim the prior already held stays with this event; a new one must be free.
    if (prior.has(bookClaimId(claim))) continue;
    const held = await heldElsewhere(store, subject, key, aliasClassText(derived.aliasClass), own);
    if (held) return held;
  }
  return {
    ok: true,
    sources: [...new Set([...legKeys.values()].map((value) => value.sourceId))].sort(),
    parseRuns: [...parseRuns].sort((a, b) => a - b),
  };
}

function resolved(input: {
  kind: EconomicEventCommandKind;
  targets: PlanTarget[];
  expectedRevisions: Record<string, number>;
  claimsBefore: number;
  claimsAfter: number;
  sources: readonly string[];
  parseRuns: number;
}): CommandResult<{ resolved: ResolvedPlan }> {
  return {
    ok: true,
    resolved: {
      targets: input.targets,
      expectedRevisions: input.expectedRevisions,
      simulation: {
        kind: input.kind,
        targets: input.targets,
        before: { attributedObservations: input.claimsBefore, relations: 0 },
        after: { attributedObservations: input.claimsAfter, relations: 0 },
        invalidations: ["read-model:economic-events"],
        affectedScopes: [...new Set(input.sources)].sort(),
        affectedParseRuns: input.parseRuns,
        outboxTargets: ["identity-projection"],
      },
    },
  };
}

function familyRefusal(kind: EconomicEventCommandKind, payload: ChangePayload): Refusal | null {
  const family = (payload as { family?: unknown }).family;
  return family === OWN_TRANSFER_FAMILY
    ? null
    : refuse("unsupported_semantics", kind, "family_unsupported");
}

/** `economic-event.adopt`: a proposal in force, its rows unchanged and free, its event never written. */
const planOwnTransferAdopt: EconomicEventPlanner = async (store, kind, payload) => {
  const family = familyRefusal(kind, payload);
  if (family) return family;
  const proposalId = (payload as { proposalId: string }).proposalId;
  const subject = ownTransferProposalRef(proposalId);
  const proposal = await store.first<ProposalRow>(OWN_TRANSFER_PROPOSAL_SQL, [proposalId]);
  if (!proposal) return refuse("target_missing", subject, "proposal_missing");
  if (proposal.retired !== null) return refuse("stale_context", subject, "proposal_not_in_force");
  if (proposal.identity_epoch !== proposal.current_epoch)
    return refuse("stale_context", subject, "identity_epoch_changed");
  if (proposal.status !== "proposed")
    return refuse("needs_scope_resolution", subject, "proposal_needs_review");
  // A stored status can lag the engine: another unretired proposal citing
  // either row's alias class means the pair is not unique, whatever this row says.
  const competing = await store.first<{ n: number }>(OWN_TRANSFER_COMPETING_SQL, [
    proposalId,
    proposal.debit_alias_class,
    proposal.credit_alias_class,
  ]);
  if ((competing?.n ?? 0) > 0)
    return refuse("needs_scope_resolution", subject, "proposal_needs_review");
  const eventId = ownTransferEventId(proposalId);
  const eventSubject = economicEventSubject(eventId);
  const head = await store.first<HeadRow>(OWN_TRANSFER_HEAD_SQL, [eventId]);
  if (head)
    return head.state === "unknown"
      ? refuse("needs_scope_resolution", eventSubject, "withdrawn_readoption")
      : refuse("stale_context", eventSubject, "proposal_adopted");
  const sources: string[] = [];
  for (const side of ["debit", "credit"] as const) {
    const stated = {
      observationId: proposal[`${side}_observation_id`],
      parseRunId: proposal[`${side}_parse_run_id`],
      key: proposal[`${side}_consumption_key`],
      accountId: proposal[`${side}_account_id`],
    };
    const derived = await rederive(store, subject, stated);
    if (!derived.ok) return derived;
    const aliasClass = aliasClassText(derived.aliasClass);
    if (aliasClass !== proposal[`${side}_alias_class`])
      return refuse("needs_scope_resolution", subject, "identity_rekeyed");
    const held = await heldElsewhere(store, subject, stated.key, aliasClass, new Set());
    if (held) return held;
    sources.push(derived.sourceId);
  }
  return resolved({
    kind,
    targets: [
      {
        subjectRef: eventSubject,
        currentRevision: 0,
        currentTargetRef: null,
        proposedTargetRef: subject,
      },
    ],
    expectedRevisions: { [eventSubject]: 0 },
    claimsBefore: 0,
    claimsAfter: 2,
    sources,
    parseRuns: new Set([proposal.debit_parse_run_id, proposal.credit_parse_run_id]).size,
  });
};

/** `economic-event.withdraw`: the live head, adopted by the named decision, its claims free to release. */
const planOwnTransferWithdraw: EconomicEventPlanner = async (store, kind, payload) => {
  const family = familyRefusal(kind, payload);
  if (family) return family;
  const { eventId, revision, decisionRevisionId } = payload as EconomicEventWithdrawPayload;
  const subject = economicEventSubject(eventId);
  const head = await ownTransferHead(store, eventId, revision, { restates: false });
  if (!head.ok) return head;
  if (head.head.decision_revision_id !== decisionRevisionId)
    return refuse("stale_context", subject, "decision_epoch_mismatch");
  const conflict = await releaseConflict(store, subject, head.claims, new Set([eventId]));
  if (conflict) return conflict;
  return resolved({
    kind,
    targets: [
      {
        subjectRef: subject,
        currentRevision: revision,
        currentTargetRef: "live",
        proposedTargetRef: "withdrawn",
      },
    ],
    expectedRevisions: { [subject]: revision },
    claimsBefore: head.claims.length,
    claimsAfter: 0,
    sources: head.claims.map((claim) => claim.key[0]),
    parseRuns: 0,
  });
};

/** `economic-event.correct`: a full restatement of the live head, releasing exactly what it drops. */
const planOwnTransferCorrect: EconomicEventPlanner = async (store, kind, payload) => {
  const family = familyRefusal(kind, payload);
  if (family) return family;
  const { eventId, priorRevision, revision, releasedClaims } =
    payload as EconomicEventCorrectPayload;
  const subject = economicEventSubject(eventId);
  const head = await ownTransferHead(store, eventId, priorRevision, { restates: true });
  if (!head.ok) return head;
  if (!sameBookClaims(releasedClaims, releasedBookClaims(head.claims, revision.claims)))
    return refuse("needs_scope_resolution", subject, "released_claims_mismatch");
  const own = new Set([eventId]);
  const restated = await checkRestatement(
    store,
    subject,
    revision,
    own,
    head.claims,
    head.accounts,
  );
  if (!restated.ok) return restated;
  const conflict = await releaseConflict(store, subject, releasedClaims, own);
  if (conflict) return conflict;
  return resolved({
    kind,
    targets: [
      {
        subjectRef: subject,
        currentRevision: priorRevision,
        currentTargetRef: "live",
        proposedTargetRef: "corrected",
      },
    ],
    expectedRevisions: { [subject]: priorRevision },
    claimsBefore: head.claims.length,
    claimsAfter: revision.claims.length,
    sources: restated.sources,
    parseRuns: restated.parseRuns.length,
  });
};

/**
 * `economic-event.move`: one claim leaves `from` and joins `to` in one commit
 * (W5: the writer's batch is atomic). Each member restates its prior exactly,
 * the moved claim aside, and both heads are pinned.
 */
const planOwnTransferMove: EconomicEventPlanner = async (store, kind, payload) => {
  const family = familyRefusal(kind, payload);
  if (family) return family;
  const { claim, from, to } = payload as EconomicEventMovePayload;
  const fromSubject = economicEventSubject(from.eventId);
  const toSubject = economicEventSubject(to.eventId);
  const fromHead = await ownTransferHead(store, from.eventId, from.priorRevision, {
    restates: true,
  });
  if (!fromHead.ok) return fromHead;
  const toHead = await ownTransferHead(store, to.eventId, to.priorRevision, { restates: true });
  if (!toHead.ok) return toHead;
  const moved = bookClaimId(claim);
  if (
    !fromHead.claims.some((held) => bookClaimId(held) === moved) ||
    toHead.claims.some((held) => bookClaimId(held) === moved)
  )
    return refuse("needs_scope_resolution", fromSubject, "move_claim_not_held");
  const fromExpected = fromHead.claims.filter((held) => bookClaimId(held) !== moved);
  if (
    !sameBookClaims(from.revision.claims, fromExpected) ||
    !sameBookClaims(to.revision.claims, [...toHead.claims, claim])
  )
    return refuse("needs_scope_resolution", fromSubject, "move_restates_other_claims");
  const own = new Set([from.eventId, to.eventId]);
  // The moved row's account is the one the from member adopted it under.
  const accounts = new Map([...fromHead.accounts, ...toHead.accounts]);
  const sources: string[] = [];
  const parseRuns = new Set<number>();
  for (const [subject, member, prior] of [
    [fromSubject, from, fromHead.claims],
    [toSubject, to, toHead.claims],
  ] as const) {
    if (member.revision.state === "unknown") continue;
    // The moved claim was the from member's own: it is not "new" to the to member.
    const restated = await checkRestatement(
      store,
      subject,
      member.revision,
      own,
      [...prior, claim],
      accounts,
    );
    if (!restated.ok) return restated;
    sources.push(...restated.sources);
    for (const run of restated.parseRuns) parseRuns.add(run);
  }
  return resolved({
    kind,
    targets: [
      {
        subjectRef: fromSubject,
        currentRevision: from.priorRevision,
        currentTargetRef: "live",
        proposedTargetRef: "claim-moved-out",
      },
      {
        subjectRef: toSubject,
        currentRevision: to.priorRevision,
        currentTargetRef: "live",
        proposedTargetRef: "claim-moved-in",
      },
    ],
    expectedRevisions: { [fromSubject]: from.priorRevision, [toSubject]: to.priorRevision },
    claimsBefore: fromHead.claims.length + toHead.claims.length,
    claimsAfter: from.revision.claims.length + to.revision.claims.length,
    sources,
    parseRuns: parseRuns.size,
  });
};

/**
 * The four planners by kind. Deliberately not merged into
 * `ECONOMIC_EVENT_PLANNERS`: registering them is the switch ADR 0054's
 * production gate keeps off.
 */
export const OWN_TRANSFER_PLANNERS: Readonly<
  Record<EconomicEventCommandKind, EconomicEventPlanner>
> = {
  "economic-event.adopt": planOwnTransferAdopt,
  "economic-event.correct": planOwnTransferCorrect,
  "economic-event.withdraw": planOwnTransferWithdraw,
  "economic-event.move": planOwnTransferMove,
};
