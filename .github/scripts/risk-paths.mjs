// Risk classification for the Risk Gate check. Pure functions over the ledger
// in infra/risk-paths.json and data fetched from the GitHub API; no network,
// no shell, no file system.

/**
 * Translate one ledger path pattern into an anchored regular expression.
 * Supported syntax: `**` (any number of segments), `*` (one segment part),
 * `?` (one character). Everything else is literal.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
export function patternToRegExp(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      // `**/` also matches zero segments so `**/wrangler.jsonc` matches a root file.
      if (pattern[index + 2] === "/") {
        source += "(?:[^/]+/)*";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
      continue;
    }
    if (character === "*") {
      source += "[^/]*";
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += character.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`^${source}$`, "u");
}

/**
 * @param {string} path
 * @param {string} pattern
 * @returns {boolean}
 */
export function matchesPattern(path, pattern) {
  return patternToRegExp(pattern).test(path);
}

/**
 * The paths a changed-file entry touches: the current path and, for a rename,
 * the path it came from — moving a high-risk file out of its directory is
 * itself a high-risk change.
 *
 * @param {readonly {filename: string, previous_filename?: string}[]} files
 * @returns {string[]}
 */
export function changedPaths(files) {
  return files.flatMap((file) =>
    file.previous_filename ? [file.filename, file.previous_filename] : [file.filename],
  );
}

/**
 * Match changed files against the ledger rules.
 *
 * @param {readonly string[]} changedFiles
 * @param {{rules?: readonly {id: string, reason: string, paths: readonly string[]}[]}} ledger
 * @returns {{path: string, rule: string, reason: string}[]}
 */
export function matchChangedFiles(changedFiles, ledger) {
  const matches = [];
  for (const path of changedFiles) {
    for (const rule of ledger.rules ?? []) {
      if (rule.paths.some((pattern) => matchesPattern(path, pattern))) {
        matches.push({ path, rule: rule.id, reason: rule.reason });
        break;
      }
    }
  }
  return matches;
}

/**
 * Match pull request labels against the ledger labels.
 *
 * @param {readonly string[]} labels
 * @param {{labels?: readonly {id: string, name: string, reason: string}[]}} ledger
 * @returns {{label: string, rule: string, reason: string}[]}
 */
export function matchLabels(labels, ledger) {
  return (ledger.labels ?? [])
    .filter((entry) => labels.includes(entry.name))
    .map((entry) => ({ label: entry.name, rule: entry.id, reason: entry.reason }));
}

/**
 * Classify one pull request. `truncated` means the changed-file list could not
 * be read completely; the gate then fails closed rather than guessing.
 *
 * @param {object} options
 * @param {readonly string[]} options.changedFiles
 * @param {readonly string[]} [options.labels]
 * @param {object} options.ledger
 * @param {boolean} [options.truncated]
 * @returns {{level: "high" | "low", paths: object[], labels: object[], truncated: boolean}}
 */
export function assessRisk({ changedFiles, labels = [], ledger, truncated = false }) {
  const paths = matchChangedFiles(changedFiles, ledger);
  const labelMatches = matchLabels(labels, ledger);
  const high = truncated || paths.length > 0 || labelMatches.length > 0;
  return { level: high ? "high" : "low", paths, labels: labelMatches, truncated };
}

/**
 * Whether the repository owner approved this exact head commit. A review left
 * on an earlier head never carries over (G5-05), and a later non-comment
 * review by the owner on the same head supersedes the approval.
 *
 * @param {readonly {state?: string, commit_id?: string, submitted_at?: string, user?: {login?: string} | null}[]} reviews
 * @param {{ownerLogin: string, headSha: string}} options
 * @returns {{approved: boolean, reason: string}}
 */
export function ownerApprovalForHead(reviews, { ownerLogin, headSha }) {
  const decisive = reviews.filter(
    (review) =>
      review.user?.login === ownerLogin &&
      review["commit_id"] === headSha &&
      review.state !== "COMMENTED" &&
      review.state !== "PENDING",
  );
  const latest = decisive.at(-1);
  if (!latest)
    return {
      approved: false,
      reason: `no review by ${ownerLogin} on head ${headSha}`,
    };
  if (latest.state !== "APPROVED")
    return {
      approved: false,
      reason: `the latest review by ${ownerLogin} on head ${headSha} is ${latest.state}`,
    };
  return { approved: true, reason: `approved by ${ownerLogin} on head ${headSha}` };
}

/**
 * Human-readable explanation of a failing gate. Only ledger text and file
 * paths reach this string; pull request titles and bodies never do.
 *
 * @param {{paths: {path: string, rule: string, reason: string}[], labels: {label: string, rule: string, reason: string}[], truncated: boolean}} assessment
 * @param {{ownerLogin: string, headSha: string, approvalReason: string}} options
 * @returns {string}
 */
export function explainFailure(assessment, { ownerLogin, headSha, approvalReason }) {
  const lines = [
    `Risk Gate failed: ${approvalReason}.`,
    `High-risk changes need an APPROVED review by ${ownerLogin} on head ${headSha}.`,
  ];
  if (assessment.truncated)
    lines.push("- the changed-file list was truncated, so every path is treated as high risk");
  for (const match of assessment.paths)
    lines.push(`- ${match.path} [${match.rule}] ${match.reason}`);
  for (const match of assessment.labels)
    lines.push(`- label ${match.label} [${match.rule}] ${match.reason}`);
  lines.push(
    "Approve the current head, then re-run this job; approving an older head does not lift the gate.",
  );
  return lines.join("\n");
}
