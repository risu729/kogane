import { expect, test } from "bun:test";
import {
  chromeLaunch,
  XVFB_ARGS as SHINSEI_XVFB,
} from "../../services/collector-sbi-shinsei/container/browser-launch.mjs";
import {
  directChromeLaunch,
  probeConfiguration,
  PROBE_VARIANTS,
  XVFB_ARGS,
} from "../../services/collector-globalpass/container/browser-launch.mjs";

test("SBI Shinsei retains its headed wrapper, Tokyo environment and exact launch flags", () => {
  const launch = chromeLaunch("/tmp/synthetic-profile", 32101, 32102);
  expect(launch.executable).toBe("/usr/bin/google-chrome");
  expect(launch.args).toEqual([
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--user-data-dir=/tmp/synthetic-profile",
    "--remote-debugging-port=32101",
    "--remote-debugging-address=127.0.0.1",
    "--lang=ja-JP",
    "--proxy-server=http://127.0.0.1:32102",
    "--window-size=1365,768",
  ]);
  expect(launch.options.env).toMatchObject({ DISPLAY: ":99", TZ: "Asia/Tokyo" });
  expect(launch.options.stdio).toBe("ignore");
  expect(launch.args.some((arg) => arg.includes("https:"))).toBe(false);
});

test("GLOBAL PASS retains the production stable headed persistent native context configuration", () => {
  expect(probeConfiguration("chrome-stable-no-ua-all-tamia")).toEqual({
    webdriverFalse: true,
    windows: false,
    windowsVersion: null,
    headed: true,
    persistent: true,
    chromeStable: true,
    nativeContext: true,
    patchright: false,
    directChrome: false,
    egress: "all-tamia",
  });
  for (const variant of PROBE_VARIANTS) expect(() => probeConfiguration(variant)).not.toThrow();
  expect(() => probeConfiguration("synthetic-unknown")).toThrow();
});

test("GLOBAL PASS direct probe keeps its distinct wrapper/CDP launch without adding a URL override", () => {
  const config = probeConfiguration("chrome-direct-process-attach-late-all-tamia");
  const launch = directChromeLaunch(config, 32102, "/tmp/synthetic-profile", 32101, ":99");
  expect(launch.executable).toBe("/usr/bin/google-chrome");
  expect(launch.args).toEqual([
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--user-data-dir=/tmp/synthetic-profile",
    "--remote-debugging-port=32101",
    "--remote-debugging-address=127.0.0.1",
    "--proxy-server=http://127.0.0.1:32102",
    "--window-size=1365,768",
  ]);
  expect(launch.options.env.DISPLAY).toBe(":99");
  expect(
    directChromeLaunch({ egress: "direct" }, 32102, "/tmp/p", 32101, ":99").args.some((arg) =>
      arg.startsWith("--proxy"),
    ),
  ).toBe(false);
  expect(XVFB_ARGS).toEqual([":99", "-screen", "0", "1365x768x24", "-nolisten", "tcp"]);
  expect(SHINSEI_XVFB).toEqual(XVFB_ARGS);
});
