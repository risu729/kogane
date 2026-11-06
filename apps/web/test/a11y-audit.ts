// A dependency-free accessibility audit for the browser tests.
//
// The lockfile carries no axe-core, so these checks are the rules in
// docs/ui-guidelines.md#accessibility, measured in the rendered DOM. Each
// finding is a closed sentence naming the rule and the element, so a failing
// test prints every violation on the page at once rather than the first.
//
// `auditPage` only reads the page. `tabWalk` presses Tab and therefore moves
// focus; callers run it last, after every other assertion on the page.

import type { Page } from "playwright";

export type AuditOptions = {
  /** Also check target sizes and page overflow (meant for the 390px run). */
  mobile?: boolean;
};

/** Every accessibility finding on the page as it is rendered now. */
export async function auditPage(page: Page, options: AuditOptions = {}): Promise<string[]> {
  return page.evaluate(auditInPage, { mobile: options.mobile ?? false });
}

/**
 * The whole audit for one rendered view: at 1280px with the keyboard walk, at
 * 390px with target sizes and overflow, and again with every disclosure open.
 * The viewport changes in place, so the view is not reloaded or re-requested.
 */
export async function auditView(page: Page): Promise<string[]> {
  const findings: string[] = [];
  const viewport = page.viewportSize() ?? { width: 1280, height: 900 };
  await page.setViewportSize({ width: 1280, height: viewport.height });
  for (const finding of await auditPage(page)) findings.push(`1280px: ${finding}`);
  for (const finding of await tabWalk(page)) findings.push(`1280px: ${finding}`);
  await page.setViewportSize({ width: 390, height: viewport.height });
  for (const finding of await auditPage(page, { mobile: true })) findings.push(`390px: ${finding}`);
  await openDisclosures(page);
  for (const finding of await auditPage(page, { mobile: true }))
    findings.push(`390px, disclosures open: ${finding}`);
  await page.setViewportSize(viewport);
  return findings;
}

/** Open every disclosure, so a second audit also covers what they hold. */
export async function openDisclosures(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const details of Array.from(document.querySelectorAll("details"))) details.open = true;
  });
}

/**
 * Tab from the top of the document and compare the focus order with the
 * document order of the reachable controls: no positive tabindex, nothing
 * skipped or reordered, no trap. Visits at most `limit` stops.
 */
export async function tabWalk(page: Page, limit = 40): Promise<string[]> {
  const expected = await page.evaluate(() => {
    const focusables = Array.from(
      document.querySelectorAll<HTMLElement>(
        "a[href], button, input, select, textarea, summary, [tabindex]",
      ),
    ).filter((element) => {
      if (element.tabIndex < 0) return false;
      if ((element as HTMLButtonElement).disabled) return false;
      if (element instanceof HTMLInputElement && element.type === "hidden") return false;
      if (element.tagName === "SUMMARY" && element.parentElement?.tagName !== "DETAILS")
        return false;
      // A skip link is visible only while focused, so it is checked by name.
      if (element.classList.contains("skip-link")) return true;
      return element.checkVisibility({ visibilityProperty: true, opacityProperty: false });
    });
    // A radio group is one tab stop: its checked radio, or its first.
    const seenGroups = new Set<string>();
    const stops = focusables.filter((element) => {
      if (!(element instanceof HTMLInputElement) || element.type !== "radio" || !element.name)
        return true;
      const key = `${element.form?.id ?? ""}/${element.name}`;
      const group = Array.from(
        document.querySelectorAll<HTMLInputElement>(
          `input[type=radio][name="${CSS.escape(element.name)}"]`,
        ),
      );
      const stop = group.find((radio) => radio.checked) ?? group[0];
      if (seenGroups.has(key) && stop !== element) return false;
      seenGroups.add(key);
      return stop === element;
    });
    document.querySelectorAll("[data-tab-walk]").forEach((element) => {
      element.removeAttribute("data-tab-walk");
    });
    stops.forEach((element, index) => element.setAttribute("data-tab-walk", String(index)));
    (document.activeElement as HTMLElement | null)?.blur();
    window.getSelection()?.removeAllRanges();
    return stops.length;
  });
  // Start before the first focusable element of the document.
  await page.evaluate(() => {
    const anchor = document.body;
    anchor.tabIndex = -1;
    anchor.focus();
    anchor.removeAttribute("tabindex");
  });
  const findings: string[] = [];
  const stops = Math.min(expected, limit);
  // A date or time input takes one Tab per field segment before it lets go.
  let segments = 0;
  for (let index = 0; index < stops; index++) {
    await page.keyboard.press("Tab");
    const actual = await page.evaluate((stop) => {
      const label = (element: Element | null): string => {
        if (!element || element === document.body) return "body";
        const text = (
          element.getAttribute("aria-label") ??
          (element as HTMLInputElement).labels?.[0]?.textContent ??
          element.textContent ??
          ""
        )
          .replace(/\s+/gu, " ")
          .trim();
        return `<${element.tagName.toLowerCase()}> "${text.slice(0, 40)}"`;
      };
      const active = document.activeElement;
      const marker = active?.getAttribute("data-tab-walk");
      return {
        segmented:
          active instanceof HTMLInputElement &&
          ["date", "time", "datetime-local", "month", "week"].includes(active.type),
        index: marker === null || marker === undefined ? null : Number(marker),
        reached: label(active),
        expected: label(document.querySelector(`[data-tab-walk="${String(stop)}"]`)),
      };
    }, index);
    if (actual.segmented && actual.index === index - 1 && segments < 4) {
      segments++;
      index--;
      continue;
    }
    segments = 0;
    if (actual.index !== index) {
      findings.push(
        `tab order: stop ${String(index)} reached ${actual.reached}, expected ${actual.expected}`,
      );
      break;
    }
  }
  await page.evaluate(() => {
    document.querySelectorAll("[data-tab-walk]").forEach((element) => {
      element.removeAttribute("data-tab-walk");
    });
  });
  return findings;
}

// Runs inside the page: it must not close over anything in this module.
function auditInPage({ mobile }: { mobile: boolean }): string[] {
  const findings: string[] = [];
  const visible = (element: Element): boolean =>
    element.checkVisibility({ visibilityProperty: true, opacityProperty: false });
  const describe = (element: Element): string => {
    const id = element.id ? `#${element.id}` : "";
    const cls =
      typeof element.className === "string" && element.className.trim() !== ""
        ? `.${element.className.trim().split(/\s+/u).join(".")}`
        : "";
    const text = (element.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, 40);
    return `<${element.tagName.toLowerCase()}${id}${cls}>${text ? ` "${text}"` : ""}`;
  };
  // Text a screen reader announces: aria-hidden subtrees do not count.
  const spokenText = (element: Element): string => {
    if (element instanceof HTMLElement && element.getAttribute("aria-hidden") === "true") return "";
    let text = "";
    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? "";
      else if (node instanceof Element) {
        if (node.getAttribute("aria-hidden") === "true") continue;
        if (node instanceof HTMLImageElement) text += node.alt;
        else if (node instanceof SVGElement) text += node.querySelector("title")?.textContent ?? "";
        else text += spokenText(node);
      }
    }
    return text.replace(/\s+/gu, " ").trim();
  };
  const labelledBy = (element: Element): string | null => {
    const ids = element.getAttribute("aria-labelledby");
    if (ids === null) return null;
    return ids
      .split(/\s+/u)
      .map((id) => document.getElementById(id))
      .map((target) => (target ? spokenText(target) : ""))
      .join(" ")
      .trim();
  };
  const accessibleName = (element: Element): string => {
    const byId = labelledBy(element);
    if (byId) return byId;
    const label = element.getAttribute("aria-label")?.trim();
    if (label) return label;
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
    ) {
      const labels = Array.from(element.labels ?? [])
        .map((node) => spokenText(node))
        .join(" ")
        .trim();
      if (labels) return labels;
      if (
        element instanceof HTMLInputElement &&
        ["submit", "button", "reset"].includes(element.type)
      )
        return element.value.trim();
    } else if (
      element instanceof HTMLButtonElement ||
      element instanceof HTMLAnchorElement ||
      element.tagName === "SUMMARY" ||
      /^H[1-6]$/u.test(element.tagName) ||
      ["button", "link", "tab", "menuitem", "heading"].includes(element.getAttribute("role") ?? "")
    ) {
      const text = spokenText(element);
      if (text) return text;
    } else if (element instanceof HTMLTableElement) {
      const caption = element.caption ? spokenText(element.caption) : "";
      if (caption) return caption;
    }
    return element.getAttribute("title")?.trim() ?? "";
  };

  // 1. The document language.
  if (document.documentElement.lang !== "ja")
    findings.push(`document: <html lang="${document.documentElement.lang}">, expected "ja"`);

  // 2. One h1, inside main, and no skipped heading levels.
  const headings = Array.from(
    document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]"),
  ).filter(visible);
  const h1s = headings.filter((heading) => heading.tagName === "H1");
  if (h1s.length !== 1) findings.push(`headings: ${String(h1s.length)} visible h1, expected 1`);
  for (const h1 of h1s)
    if (!h1.closest("main")) findings.push(`headings: ${describe(h1)} is outside main`);
  let previous = 0;
  for (const heading of headings) {
    const level =
      heading.getAttribute("role") === "heading"
        ? Number(heading.getAttribute("aria-level") ?? "2")
        : Number(heading.tagName.slice(1));
    if (!accessibleName(heading)) findings.push(`headings: ${describe(heading)} has no text`);
    if (previous !== 0 && level > previous + 1)
      findings.push(
        `headings: h${String(level)} ${describe(heading)} follows h${String(previous)} and skips a level`,
      );
    previous = level;
  }

  // 3. Every visible control has an accessible name.
  for (const control of Array.from(
    document.querySelectorAll(
      "input:not([type=hidden]), select, textarea, button, a[href], summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=combobox], [role=textbox], [role=switch]",
    ),
  )) {
    if (!visible(control) && !control.classList.contains("skip-link")) continue;
    if (!accessibleName(control))
      findings.push(`name: ${describe(control)} has no accessible name`);
  }

  // 4. Links navigate and buttons act: no link without a destination and no
  //    generic element posing as a control.
  for (const anchor of Array.from(document.querySelectorAll("a"))) {
    const href = anchor.getAttribute("href");
    if (href === null || href === "#" || href.startsWith("javascript:"))
      findings.push(`semantics: ${describe(anchor)} is a link without a destination`);
  }
  for (const element of Array.from(
    document.querySelectorAll("[role=button]:not(button), [role=link]:not(a), [onclick]"),
  ))
    findings.push(`semantics: ${describe(element)} imitates a native control`);
  for (const element of Array.from(document.querySelectorAll<HTMLElement>("[tabindex]")))
    if (element.tabIndex > 0)
      findings.push(`keyboard: ${describe(element)} has a positive tabindex`);

  // 5. Landmarks, regions, alerts and status messages are distinguishable:
  //    no two of one role share a name (or, unnamed, their text).
  const groups = new Map<string, Element[]>();
  const landmark = (element: Element): string | null => {
    const role = element.getAttribute("role");
    if (role) return role;
    switch (element.tagName) {
      case "NAV":
        return "navigation";
      case "MAIN":
        return "main";
      case "ASIDE":
        return "complementary";
      case "SECTION":
        return accessibleName(element) ? "region" : null;
      case "FORM":
        return accessibleName(element) ? "form" : null;
      default:
        return null;
    }
  };
  for (const element of Array.from(
    document.querySelectorAll(
      "nav, main, aside, section, form, [role=region], [role=navigation], [role=search], [role=complementary], [role=alert], [role=status], [role=group]",
    ),
  )) {
    if (!visible(element)) continue;
    const role = landmark(element);
    if (role === null) continue;
    // An unnamed group only groups; a named one is told apart by its name.
    if (role === "group" && !accessibleName(element)) continue;
    const live = role === "alert" || role === "status";
    const key = live ? spokenText(element) : accessibleName(element);
    // An empty live region waits for a message; it announces nothing yet.
    if (live && !key) continue;
    if (!live && !key && role === "region")
      findings.push(`landmarks: ${describe(element)} is a region without a name`);
    const id = `${role}\u0000${key}`;
    groups.set(id, [...(groups.get(id) ?? []), element]);
  }
  for (const [id, elements] of groups) {
    if (elements.length < 2) continue;
    const [role, key] = id.split("\u0000");
    findings.push(
      `landmarks: ${String(elements.length)} ${role!} share ${key ? `"${key.slice(0, 60)}"` : "no name"}`,
    );
  }
  // Retry and other buttons inside alerts must say which load they repeat.
  const alertButtons = new Map<string, number>();
  for (const button of Array.from(
    document.querySelectorAll("[role=alert] button, [role=status] button"),
  )) {
    if (!visible(button)) continue;
    const name = accessibleName(button);
    alertButtons.set(name, (alertButtons.get(name) ?? 0) + 1);
  }
  for (const [name, count] of alertButtons)
    if (count > 1)
      findings.push(`landmarks: ${String(count)} buttons in alerts share the name "${name}"`);

  // 6. Errors and loading states are announced.
  for (const element of Array.from(document.querySelectorAll(".state-error, .query-warning")))
    if (!["alert", "status"].includes(element.getAttribute("role") ?? ""))
      findings.push(`live: ${describe(element)} is an error without role alert or status`);
  for (const element of Array.from(document.querySelectorAll(".state:not(.state-empty)")))
    if (!["alert", "status"].includes(element.getAttribute("role") ?? ""))
      findings.push(`live: ${describe(element)} is a state without a live role`);

  // 7. Tables have a caption and every header cell a scope.
  for (const table of Array.from(document.querySelectorAll("table"))) {
    if (!visible(table)) continue;
    if (!accessibleName(table)) findings.push(`tables: ${describe(table)} has no caption`);
    for (const header of Array.from(table.querySelectorAll("th")))
      if (!["col", "row", "colgroup", "rowgroup"].includes(header.getAttribute("scope") ?? ""))
        findings.push(`tables: header ${describe(header)} has no scope`);
  }

  // 8. A scrollable region is reachable by keyboard and named.
  for (const element of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
    if (!visible(element)) continue;
    const style = getComputedStyle(element);
    const scrollsX =
      ["auto", "scroll"].includes(style.overflowX) && element.scrollWidth > element.clientWidth + 1;
    const scrollsY =
      ["auto", "scroll"].includes(style.overflowY) &&
      element.scrollHeight > element.clientHeight + 1;
    if (!scrollsX && !scrollsY) continue;
    // A landmark whose links scroll it into view (the sidebar on a short
    // window) is reachable through them; content needs its own tab stop.
    const landmarkWithControls =
      ["ASIDE", "NAV", "MAIN"].includes(element.tagName) &&
      element.querySelector("a[href], button, input, select, textarea, summary") !== null;
    if (landmarkWithControls) continue;
    if (element.tabIndex < 0)
      findings.push(`scroll: ${describe(element)} scrolls but is not keyboard-focusable`);
    if (!accessibleName(element) || !element.getAttribute("role"))
      findings.push(`scroll: ${describe(element)} scrolls but is not a named region`);
  }
  // A table scroll container is a named, focusable region at every width,
  // since whether it scrolls depends on the data and the window.
  for (const element of Array.from(document.querySelectorAll<HTMLElement>(".table-scroll"))) {
    if (!visible(element)) continue;
    if (
      element.getAttribute("role") !== "region" ||
      element.tabIndex !== 0 ||
      !accessibleName(element)
    )
      findings.push(`scroll: ${describe(element)} is not a named region with tabindex 0`);
  }

  // 9. State words are text: a badge or status dot without words is colour only.
  for (const badge of Array.from(document.querySelectorAll(".badge")))
    if (visible(badge) && !spokenText(badge) && !badge.getAttribute("aria-label"))
      findings.push(`colour: ${describe(badge)} has no text`);
  for (const graphic of Array.from(document.querySelectorAll("svg, img"))) {
    if (graphic.closest("[aria-hidden=true]")) continue;
    if (graphic instanceof HTMLImageElement && graphic.hasAttribute("alt")) continue;
    if (
      graphic instanceof SVGElement &&
      (graphic.getAttribute("role") === "img" || graphic.querySelector("title")) &&
      accessibleName(graphic)
    )
      continue;
    findings.push(`graphics: ${describe(graphic)} is neither hidden nor named`);
  }

  // 10. At phone width: no horizontal page overflow and targets of 24px.
  if (mobile) {
    if (document.documentElement.scrollWidth > window.innerWidth)
      findings.push(
        `layout: page is ${String(document.documentElement.scrollWidth)}px wide at ${String(window.innerWidth)}px`,
      );
    // WCAG 2.5.8: a target is 24px, or its 24px circle touches no other target.
    // Text links in a sentence, cell or breadcrumb are the inline exception.
    const targets = Array.from(
      document.querySelectorAll(
        "a.button, .nav a, button, input:not([type=hidden]), select, textarea, summary",
      ),
    )
      .filter(visible)
      .map((control) => {
        // Checkboxes and radios count with their label, which is the target.
        const box =
          control instanceof HTMLInputElement &&
          ["checkbox", "radio"].includes(control.type) &&
          control.labels?.[0]
            ? control.labels[0].getBoundingClientRect()
            : control.getBoundingClientRect();
        return { control, box, small: box.width < 24 || box.height < 24 };
      });
    const distance = (x: number, y: number, box: DOMRect): number =>
      Math.hypot(
        Math.max(box.left - x, 0, x - box.right),
        Math.max(box.top - y, 0, y - box.bottom),
      );
    for (const target of targets) {
      if (!target.small) continue;
      const x = target.box.left + target.box.width / 2;
      const y = target.box.top + target.box.height / 2;
      const crowded = targets.some((other) => {
        if (other === target || other.box.width === 0) return false;
        if (other.control.contains(target.control) || target.control.contains(other.control))
          return false;
        if (!other.small) return distance(x, y, other.box) < 12;
        const ox = other.box.left + other.box.width / 2;
        const oy = other.box.top + other.box.height / 2;
        return Math.hypot(ox - x, oy - y) < 24;
      });
      if (crowded)
        findings.push(
          `target: ${describe(target.control)} is ${String(Math.round(target.box.width))}x${String(Math.round(target.box.height))}px and closer than 24px to another target`,
        );
    }
  }
  return findings;
}
