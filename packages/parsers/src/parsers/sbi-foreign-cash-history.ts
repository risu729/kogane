import type { Parser } from "../types.ts";
import { parseRetainedCashHistory } from "./sbi-cash-history.ts";

export const sbiForeignCashHistory: Parser = {
  name: "sbi-foreign-cash-history",
  version: "0.1.0",
  accepts: (artifact) =>
    artifact.sourceId === "sbi-securities" && artifact.dataset === "foreign-cash-history",
  parse: (bytes, artifact) => parseRetainedCashHistory(bytes, artifact, "foreign"),
};
