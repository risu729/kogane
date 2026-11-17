// The caller appends the unchanged production LOGIN_URL or a loopback test page.
// No collection request or environment variable can override the provider URL.
export const XVFB_ARGS = [":99", "-screen", "0", "1365x768x24", "-nolisten", "tcp"];
export function chromeLaunch(profileDirectory, debuggingPort, proxyPort) {
  return {
    executable: "/usr/bin/google-chrome",
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profileDirectory}`,
      `--remote-debugging-port=${debuggingPort}`,
      "--remote-debugging-address=127.0.0.1",
      "--lang=ja-JP",
      `--proxy-server=http://127.0.0.1:${proxyPort}`,
      "--window-size=1365,768",
    ],
    options: { env: { ...process.env, DISPLAY: ":99", TZ: "Asia/Tokyo" }, stdio: "ignore" },
  };
}
