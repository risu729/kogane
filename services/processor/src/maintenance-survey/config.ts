// The allowlist of official maintenance-notice pages the survey lane may fetch
// (ADR 0050). It is reviewed configuration, not data: a page is fetched only
// while the lane's flag is on AND its own entry is enabled, which the schema
// allows only once its terms and cost are confirmed. Every URL is the
// source's registered maintenance reference, so an accepted proposal passes
// the writer's host check. No secret, cookie or credential belongs here.
import { z } from "zod";
import surveyConfig from "../../../../config/maintenance-survey.json";
import { ZONES } from "../../../../packages/collection/src/schedule-model.ts";

const TARGET_ID = /^[a-z0-9-]{1,100}$/u;

const target = z
  .strictObject({
    id: z.string().regex(TARGET_ID),
    source: z.string().regex(TARGET_ID),
    url: z
      .url({ protocol: /^https$/u, hostname: z.regexes.domain })
      .max(1500)
      .refine((value) => {
        const url = new URL(value);
        return !url.username && !url.password && !url.hash;
      }, "no_credentials_or_fragment"),
    scope: z.enum(["collection", "session", "feature-only"]),
    timezone: z.enum(ZONES),
    /** Hours between successful readings. Failures retry sooner, never more often than hourly. */
    cadenceHours: z.int().min(6).max(168),
    /** The provider's terms for automated reading, as the owner confirmed them. */
    terms: z.enum(["unconfirmed", "confirmed"]),
    /** The provider-side cost or limit of automated reading, as the owner confirmed it. */
    cost: z.enum(["unconfirmed", "confirmed"]),
    fetch: z.enum(["enabled", "disabled"]),
  })
  // An unconfirmed page is never fetched, whatever its switch says.
  .refine((v) => v.fetch === "disabled" || (v.terms === "confirmed" && v.cost === "confirmed"), {
    message: "fetch_requires_confirmed_terms",
  });

export const surveyConfigSchema = z
  .strictObject({
    /** Pages fetched per Processor tick at most. */
    targetsPerTick: z.int().min(1).max(5),
    targets: z.array(target).max(64),
  })
  .refine((v) => new Set(v.targets.map((t) => t.id)).size === v.targets.length, {
    message: "duplicate_target",
  });
export type SurveyConfig = z.infer<typeof surveyConfigSchema>;
export type SurveyTarget = SurveyConfig["targets"][number];

/**
 * The committed configuration, validated. A configuration that does not
 * validate fails closed: the lane reports the closed code and fetches nothing.
 */
export function loadSurveyConfig(value: unknown = surveyConfig): SurveyConfig {
  const parsed = surveyConfigSchema.safeParse(value);
  if (!parsed.success) throw new SurveyConfigError();
  return parsed.data;
}
export class SurveyConfigError extends Error {
  constructor() {
    super("survey_config_invalid");
    this.name = "SurveyConfigError";
  }
}

/** Whether the configuration lets the lane fetch this page (the lane's flag aside). */
export function fetchable(t: SurveyTarget): boolean {
  return t.fetch === "enabled" && t.terms === "confirmed" && t.cost === "confirmed";
}

/**
 * The lane's switch, `MAINTENANCE_SURVEY_ENABLED`: only "1" or "true" turn it
 * on. It is not declared in wrangler.jsonc, so a deployment that was not given
 * it behaves as if it were off.
 */
export function maintenanceSurveyEnabled(env: object): boolean {
  const value = (env as { MAINTENANCE_SURVEY_ENABLED?: unknown }).MAINTENANCE_SURVEY_ENABLED;
  return value === "1" || value === "true";
}
