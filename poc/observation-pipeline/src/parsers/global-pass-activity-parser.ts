import { parse } from "parse5";
import { createGlobalPassActivity, type GlobalPassDomNode } from "./global-pass-activity.ts";

export const globalPassActivity = createGlobalPassActivity(
  (html) => parse(html) as unknown as GlobalPassDomNode,
);
