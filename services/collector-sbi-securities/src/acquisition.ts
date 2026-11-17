import {
  persistRun,
  type PersistRunResult,
  type R2BucketLike,
} from "../../../packages/collection/src/index";
import { persistSbiRun, sbiRunPlan, safeFailureCode, type SbiSharedRun } from "./shared-run";

export interface AcquisitionResult {
  readonly core: PersistRunResult;
  readonly mailbox?: PersistRunResult;
  readonly runIds: string[];
  readonly status: "success" | "partial" | "failed";
  readonly failureCode?: string;
}
const durable = (
  result: PersistRunResult,
): result is Extract<PersistRunResult, { outcome: "persisted" | "already_persisted" }> =>
  result.outcome === "persisted" || result.outcome === "already_persisted";
const mailboxArtifact = (dataset: string) =>
  dataset.startsWith("mailbox-") || dataset === "delivered-document-pdf";

/** Financial eligibility never depends on this supplementary archive's outcome. */
export async function persistSbiAcquisition(options: {
  readonly bucket: R2BucketLike;
  readonly core: SbiSharedRun;
  readonly signal: AbortSignal;
  readonly mailbox?: () => Promise<SbiSharedRun>;
  readonly onMailboxPersisted?: (runId: string) => Promise<void>;
  readonly onRunPersisted?: (runId: string) => void;
}): Promise<AcquisitionResult> {
  if (
    options.core.artifacts.some((artifact) => mailboxArtifact(artifact.dataset)) ||
    options.core.failures.some((failure) => failure.scope === "mailbox") ||
    (options.core.mailboxUnits?.length ?? 0) > 0
  )
    throw new Error("sbi_financial_terminal_contains_mailbox");
  const core = await persistSbiRun(options.bucket, options.core);
  if (!durable(core))
    return { core, runIds: [], status: "failed", failureCode: "sbi_core_persistence_failed" };
  const runIds = [options.core.runId];
  options.onRunPersisted?.(options.core.runId);
  if (options.mailbox === undefined) return { core, runIds, status: core.manifest.providerOutcome };
  let mailbox: PersistRunResult | undefined;
  try {
    if (options.signal.aborted) throw new Error("sbi_mailbox_lease_lost");
    const run = await options.mailbox();
    if (
      run.runId !== `${options.core.runId}-mailbox` ||
      run.startedAt !== options.core.startedAt ||
      run.acquisitionSessionRef !== options.core.acquisitionSessionRef ||
      run.window !== undefined ||
      run.artifacts.some(
        (artifact) => !mailboxArtifact(artifact.dataset) || artifact.window !== undefined,
      ) ||
      run.failures.some((failure) => failure.scope !== "mailbox")
    )
      throw new Error("sbi_mailbox_terminal_invalid");
    const plan = await sbiRunPlan(run);
    // A mailbox terminal has only its actual index/document units, no empty
    // domestic/foreign scope that could be mistaken for a financial result.
    const mailboxKeys = new Set((run.mailboxUnits ?? []).map((unit) => unit.unitKey));
    mailbox = await persistRun(options.bucket, {
      artifacts: plan.artifacts,
      run: {
        ...plan.run,
        units: plan.run.units.filter((unit) => mailboxKeys.has(unit.unitKey)),
        requestedScope: { ...plan.run.requestedScope, unitKeys: [...mailboxKeys] },
      },
    });
    if (!durable(mailbox))
      return {
        core,
        mailbox,
        runIds,
        status: "failed",
        failureCode: "sbi_mailbox_persistence_failed",
      };
    runIds.push(run.runId);
    options.onRunPersisted?.(run.runId);
    if (options.signal.aborted)
      return { core, mailbox, runIds, status: "failed", failureCode: "sbi_mailbox_lease_lost" };
    await options.onMailboxPersisted?.(run.runId);
    const status =
      core.manifest.providerOutcome === "failed"
        ? "failed"
        : core.manifest.providerOutcome === "partial" ||
            mailbox.manifest.providerOutcome !== "success"
          ? "partial"
          : "success";
    return { core, mailbox, runIds, status };
  } catch (error) {
    return {
      core,
      ...(mailbox === undefined ? {} : { mailbox }),
      runIds,
      status: "failed",
      failureCode: options.signal.aborted ? "sbi_mailbox_lease_lost" : safeFailureCode(error),
    };
  }
}
