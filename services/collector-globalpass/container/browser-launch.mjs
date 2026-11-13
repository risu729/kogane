// Shared by the existing collection/probe paths and the offline image smoke test.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const TURNSTILE_HOST = "challenges.cloudflare.com";
const TURNSTILE_HELPER_HOST = "brunhild.challenges.cloudflare.com";
export const XVFB_ARGS = [":99", "-screen", "0", "1365x768x24", "-nolisten", "tcp"];

export const PROBE_VARIANTS = [
  "baseline",
  "webdriver-false",
  "windows",
  "headed-windows",
  "headed-persistent-windows",
  "chrome-stable-headed-persistent-windows",
  "chrome-stable-no-ua-direct",
  "chrome-stable-no-ua-split",
  "chrome-stable-no-ua-all-tamia",
  "chrome-stable-no-ua-all-cloudflare-gateway",
  "chrome-stable-no-ua-all-tamia-default-automation",
  "chrome-stable-windows-matched-all-tamia",
  "chrome-stable-windows-matched-direct",
  "patchright-chrome-native-all-tamia",
  "patchright-chrome-native-direct",
  "chrome-direct-process-attach-late-all-tamia",
  "chrome-direct-process-attach-late-direct",
  "chromium-native-all-tamia",
];

export function probeConfiguration(variant) {
  const index = PROBE_VARIANTS.indexOf(variant);
  if (index >= 0 && index <= 5) {
    return {
      webdriverFalse: index >= 1,
      windows: index >= 2,
      windowsVersion: "153.0.0.0",
      headed: index >= 3,
      persistent: index >= 4,
      chromeStable: index >= 5,
      nativeContext: false,
      patchright: false,
      directChrome: false,
      egress: "split",
    };
  }
  const chromeNative = {
    webdriverFalse: true,
    windows: false,
    windowsVersion: null,
    headed: true,
    persistent: true,
    chromeStable: true,
    nativeContext: true,
    patchright: false,
    directChrome: false,
  };
  if (variant === "chrome-stable-no-ua-direct") {
    return { ...chromeNative, egress: "direct" };
  }
  if (variant === "chrome-stable-no-ua-split") {
    return { ...chromeNative, egress: "split" };
  }
  if (variant === "chrome-stable-no-ua-all-tamia") {
    return { ...chromeNative, egress: "all-tamia" };
  }
  if (variant === "chrome-stable-no-ua-all-cloudflare-gateway") {
    return { ...chromeNative, egress: "all-cloudflare-gateway" };
  }
  if (variant === "chrome-stable-no-ua-all-tamia-default-automation") {
    return {
      ...chromeNative,
      webdriverFalse: false,
      egress: "all-tamia",
    };
  }
  if (variant === "chrome-stable-windows-matched-all-tamia") {
    return {
      ...chromeNative,
      windows: true,
      windowsVersion: "152.0.7977.64",
      nativeContext: false,
      egress: "all-tamia",
    };
  }
  if (variant === "chrome-stable-windows-matched-direct") {
    return {
      ...chromeNative,
      windows: true,
      windowsVersion: "152.0.7977.64",
      nativeContext: false,
      egress: "direct",
    };
  }
  if (variant === "patchright-chrome-native-all-tamia") {
    return {
      ...chromeNative,
      webdriverFalse: false,
      patchright: true,
      egress: "all-tamia",
    };
  }
  if (variant === "patchright-chrome-native-direct") {
    return {
      ...chromeNative,
      webdriverFalse: false,
      patchright: true,
      egress: "direct",
    };
  }
  if (variant === "chrome-direct-process-attach-late-all-tamia") {
    return {
      ...chromeNative,
      webdriverFalse: false,
      directChrome: true,
      egress: "all-tamia",
    };
  }
  if (variant === "chrome-direct-process-attach-late-direct") {
    return {
      ...chromeNative,
      webdriverFalse: false,
      directChrome: true,
      egress: "direct",
    };
  }
  if (variant === "chromium-native-all-tamia") {
    return {
      ...chromeNative,
      chromeStable: false,
      egress: "all-tamia",
    };
  }
  throw new Error("unknown probe configuration");
}

function probeContextOptions(config) {
  if (config.nativeContext) return { viewport: null };
  const windowsVersion = config.windowsVersion ?? "153.0.0.0";
  return {
    locale: config.windows ? "en-US" : "ja-JP",
    timezoneId: "Asia/Tokyo",
    viewport: { width: 1365, height: 768 },
    ...(config.windows ? { userAgent: windowsUserAgent(windowsVersion) } : {}),
  };
}

export function windowsUserAgent(version) {
  return (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    `AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`
  );
}

function probeProxy(config, proxyPort) {
  if (config.egress === "direct") return undefined;
  const bypass =
    config.egress === "split" ? `${TURNSTILE_HOST},${TURNSTILE_HELPER_HOST}` : undefined;
  return {
    server: `http://127.0.0.1:${proxyPort}`,
    ...(bypass ? { bypass } : {}),
  };
}

export async function launchProbeContext(config, proxyPort, ensureXvfb) {
  const browserType = config.patchright
    ? (await import("patchright")).chromium
    : (await import("playwright")).chromium;
  const args = config.patchright ? ["--no-sandbox"] : ["--no-sandbox", "--disable-dev-shm-usage"];
  if (config.webdriverFalse && !config.patchright) {
    args.push("--disable-blink-features=AutomationControlled");
  }
  if (config.headed) args.push("--window-size=1365,768");
  const display = config.headed ? await ensureXvfb() : undefined;
  const launchOptions = {
    headless: !config.headed,
    args,
    ...(config.chromeStable ? { channel: "chrome" } : {}),
    ...(display ? { env: { ...process.env, DISPLAY: display } } : {}),
    ...(probeProxy(config, proxyPort) ? { proxy: probeProxy(config, proxyPort) } : {}),
  };
  let browser;
  let context;
  let profileDirectory;
  if (config.persistent) {
    profileDirectory = await mkdtemp(path.join(os.tmpdir(), "kogane-globalpass-profile-"));
    context = await browserType.launchPersistentContext(profileDirectory, {
      ...launchOptions,
      ...probeContextOptions(config),
    });
    browser = context.browser();
  } else {
    browser = await browserType.launch(launchOptions);
    context = await browser.newContext(probeContextOptions(config));
  }
  return {
    browser,
    context,
    async close() {
      try {
        if (config.persistent) await context.close();
        else await browser.close();
      } finally {
        if (profileDirectory) {
          await rm(profileDirectory, { recursive: true, force: true });
        }
      }
    },
  };
}

// The initial page is supplied only by the caller: production appends its constant
// provider URL; the isolated test appends a loopback URL. No HTTP/env override.
export function directChromeLaunch(config, proxyPort, profileDirectory, debuggingPort, display) {
  const proxyArguments =
    config.egress === "direct" ? [] : ["--proxy-server=http://127.0.0.1:" + proxyPort];
  return {
    executable: "/usr/bin/google-chrome",
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--user-data-dir=" + profileDirectory,
      "--remote-debugging-port=" + debuggingPort,
      "--remote-debugging-address=127.0.0.1",
      ...proxyArguments,
      "--window-size=1365,768",
    ],
    options: { env: { ...process.env, DISPLAY: display }, stdio: "ignore" },
  };
}
