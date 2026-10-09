// Own-transfer proposals as statements (CORE 0072, ADR 0057). Pure builders:
// one append-only proposal row, and one retirement row. No lane calls them in
// G3-a; a proposal lane needs an owner-decided policy, which does not exist
// (the engine refuses without one: `policy_missing`).
//
// Each statement is conditional on its own row not existing, so a replay
// writes nothing; CORE 0072's triggers refuse a code outside the closed list,
// a status that disagrees with the codes, and a proposal under an identity
// epoch that is no longer current.
import { aliasClassText, consumptionKeyText } from "../../../domain/src/economic-contract.ts";
import {
  validOwnTransferProposal,
  type OwnTransferManifest,
  type OwnTransferProposal,
} from "../../../domain/src/own-transfer-proposals.ts";
import type { SqlWrite } from "../core/operations.ts";
import { canonicalKnownAt } from "./economic-commit.ts";

const OWN_TRANSFER_RETIREMENT_REASONS = [
  "engine_superseded",
  "evidence_changed",
  "identity_epoch_changed",
] as const;
export type OwnTransferRetirementReason = (typeof OWN_TRANSFER_RETIREMENT_REASONS)[number];

/** One `own_transfer_proposals` row. Throws on a proposal that is not the contract. */
export function ownTransferProposalWrite(input: {
  proposal: OwnTransferProposal;
  manifest: OwnTransferManifest;
  now: string;
}): SqlWrite {
  const { proposal, manifest } = input;
  if (
    !validOwnTransferProposal(proposal) ||
    manifest.policyVersion !== proposal.policyVersion ||
    manifest.engineRelease !== proposal.engineRelease ||
    manifest.identityEpoch !== proposal.identityEpoch
  )
    throw new RangeError("own-transfer proposal is not the contract");
  const { debit, credit } = proposal;
  return {
    sql: `INSERT INTO own_transfer_proposals(proposal_id,proposal_digest,status,codes_json,
 debit_observation_id,debit_parse_run_id,debit_consumption_key,debit_alias_class,debit_account_id,
 credit_observation_id,credit_parse_run_id,credit_consumption_key,credit_alias_class,credit_account_id,
 policy_version,engine_release,identity_epoch,manifest_json,created_at)
 SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
 WHERE NOT EXISTS(SELECT 1 FROM own_transfer_proposals WHERE proposal_id=?)`,
    binds: [
      proposal.proposalId,
      proposal.proposalDigest,
      proposal.status,
      JSON.stringify(proposal.codes),
      debit.observationId,
      debit.parseRunId,
      consumptionKeyText(debit.key),
      aliasClassText(debit.aliasClass),
      debit.accountId,
      credit.observationId,
      credit.parseRunId,
      consumptionKeyText(credit.key),
      aliasClassText(credit.aliasClass),
      credit.accountId,
      proposal.policyVersion,
      proposal.engineRelease,
      proposal.identityEpoch,
      JSON.stringify(manifest),
      canonicalKnownAt(input.now),
      proposal.proposalId,
    ],
  };
}

/** One `own_transfer_proposal_retirements` row: the proposal is no longer in force. */
export function ownTransferProposalRetirementWrite(input: {
  proposalId: string;
  reason: OwnTransferRetirementReason;
  now: string;
}): SqlWrite {
  if (
    !/^otp_[0-9a-f]{64}$/u.test(input.proposalId) ||
    !OWN_TRANSFER_RETIREMENT_REASONS.includes(input.reason)
  )
    throw new RangeError("own-transfer retirement is not the contract");
  return {
    sql: `INSERT INTO own_transfer_proposal_retirements(proposal_id,reason_code,retired_at)
 SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM own_transfer_proposal_retirements WHERE proposal_id=?)`,
    binds: [input.proposalId, input.reason, canonicalKnownAt(input.now), input.proposalId],
  };
}
