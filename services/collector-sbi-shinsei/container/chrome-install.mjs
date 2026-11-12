// Canonical source; sync.mjs copies this and the manifest into both build contexts.
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fail = (code) => {
  throw new Error(`pinned_chrome_${code}`);
};
const runtimePrefix = "opt/google/chrome/";
const skippedLinks = new Map([
  ["etc/cron.daily/google-chrome", "/opt/google/chrome/cron/google-chrome"],
  ["usr/bin/google-chrome-stable", "/opt/google/chrome/google-chrome"],
  ["usr/share/man/man1/google-chrome.1.gz", "google-chrome-stable.1.gz"],
]);

/** A build never resolves a channel or accepts a caller-selected download host. */
export function validateManifest(value) {
  if (
    value?.schemaVersion !== 1 ||
    value.package !== "google-chrome-stable" ||
    !/^\d{1,3}\.\d{1,3}\.\d{1,5}\.\d{1,5}-\d{1,3}$/u.test(value.version ?? "") ||
    value.architecture !== "amd64" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > 200_000_000 ||
    !/^[a-f0-9]{64}$/u.test(value.sha256 ?? "") ||
    value.url !==
      `https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${value.version}_amd64.deb`
  )
    fail("manifest_invalid");
  return value;
}

/** Write only verified bytes to a new private staging file, never an extraction target. */
export async function downloadChrome(manifest, target, fetchImpl = fetch) {
  validateManifest(manifest);
  const response = await fetchImpl(manifest.url, {
    redirect: "error",
    signal: AbortSignal.timeout(180_000),
    headers: { "Accept-Encoding": "identity" },
  });
  if (response.status !== 200 || !response.body) fail("download_response");
  const declared = response.headers.get("content-length");
  if (declared !== null && declared !== String(manifest.bytes)) fail("download_size");
  const encoding = response.headers.get("content-encoding");
  if (encoding !== null && encoding !== "identity") fail("download_encoding");
  const file = await open(target, "wx", 0o600);
  let size = 0;
  const hash = createHash("sha256");
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > manifest.bytes) fail("download_size");
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    if (size !== manifest.bytes || hash.digest("hex") !== manifest.sha256)
      fail("download_integrity");
  } finally {
    await file.close();
  }
}

function text(bytes) {
  if (bytes.some((byte) => byte > 127)) fail("archive_header");
  const end = bytes.indexOf(0);
  if (end !== -1 && bytes.subarray(end).some((b) => b !== 0)) fail("archive_header");
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("ascii");
}
function octal(bytes) {
  const value = bytes
    .toString("ascii")
    .replace(/[\0 ]+$/u, "")
    .replace(/^ +/u, "");
  if (!/^[0-7]+$/u.test(value)) fail("archive_number");
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) fail("archive_number");
  return number;
}

/** Only the selected package's ordinary ustar data entries are admitted; no tar tool executes it. */
export function archiveEntry(header) {
  const sum = header.reduce((n, byte, i) => n + (i >= 148 && i < 156 ? 32 : byte), 0);
  if (octal(header.subarray(148, 156)) !== sum) fail("archive_checksum");
  if (!["ustar\0", "ustar "].includes(header.subarray(257, 263).toString("ascii")))
    fail("archive_format");
  if (text(header.subarray(345, 500)) !== "") fail("archive_prefix");
  const original = text(header.subarray(0, 100));
  const name = original === "./" ? "." : original.replace(/^\.\//u, "").replace(/\/$/u, "");
  if (
    name !== "." &&
    (!/^[A-Za-z0-9._+@/-]+$/u.test(name) ||
      name.startsWith("/") ||
      name.split("/").some((part) => part === "" || part === "." || part === ".."))
  )
    fail("archive_path");
  const type = String.fromCharCode(header[156]);
  const size = octal(header.subarray(124, 136));
  const mode = octal(header.subarray(100, 108));
  if (octal(header.subarray(108, 116)) !== 0 || octal(header.subarray(116, 124)) !== 0)
    fail("archive_owner");
  if (!["0", "5", "2"].includes(type) || size > 500_000_000) fail("archive_type");
  const link = text(header.subarray(157, 257));
  if (type === "2") {
    // These package links are inspected but never installed. Runtime links are forbidden.
    if (skippedLinks.get(name) !== link || size !== 0 || mode !== 0o777) fail("archive_link");
  } else if (link !== "") fail("archive_link");
  if (type === "5" && (size !== 0 || (mode !== 0o755 && !(name === "." && mode === 0o750))))
    fail("archive_mode");
  if (
    type === "0" &&
    ![0o644, 0o750, 0o755].includes(mode) &&
    !(name === `${runtimePrefix}chrome-sandbox` && mode === 0o4755)
  )
    fail("archive_mode");
  if (name === "." && type !== "5") fail("archive_path");
  return { name, type, size, mode };
}

/** Bounded streaming extraction into a newly created directory; never follow archive links. */
export async function extractChrome(stream, destination) {
  await mkdir(destination, { mode: 0o755 });
  const iterator = stream[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  let total = 0;
  const read = async (length) => {
    while (pending.length < length) {
      const next = await iterator.next();
      if (next.done) fail("archive_truncated");
      const chunk = Buffer.from(next.value);
      total += chunk.length;
      if (total > 600_000_000) fail("archive_size");
      pending = Buffer.concat([pending, chunk]);
    }
    const result = pending.subarray(0, length);
    pending = pending.subarray(length);
    return result;
  };
  const names = new Set();
  const runtime = new Set();
  let count = 0;
  try {
    while (true) {
      const header = await read(512);
      if (header.every((byte) => byte === 0)) {
        if (!(await read(512)).every((byte) => byte === 0)) fail("archive_trailer");
        if (pending.some((byte) => byte !== 0)) fail("archive_trailer");
        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          total += next.value.length;
          if (total > 600_000_000 || Buffer.from(next.value).some((byte) => byte !== 0))
            fail("archive_trailer");
        }
        break;
      }
      const entry = archiveEntry(header);
      if (++count > 1000 || names.has(entry.name)) fail("archive_duplicate");
      names.add(entry.name);
      const inside = entry.name.startsWith(runtimePrefix);
      const relative = inside ? entry.name.slice(runtimePrefix.length) : null;
      const target = relative === null ? null : join(destination, relative);
      if (inside) runtime.add(relative);
      if (inside && entry.type === "2") fail("archive_link");
      if (inside && entry.type === "5") await mkdir(target, { mode: entry.mode });
      let file;
      if (inside && entry.type === "0") {
        // A missing explicit parent, repeated path or symlink ancestor fails closed.
        file = await open(target, "wx", entry.mode & 0o777);
      }
      try {
        let remaining = entry.size;
        while (remaining > 0) {
          const chunk = await read(Math.min(64 * 1024, remaining));
          if (file) await file.writeFile(chunk);
          remaining -= chunk.length;
        }
      } finally {
        await file?.close();
      }
      const padding = (512 - (entry.size % 512)) % 512;
      if (padding && (await read(padding)).some((byte) => byte !== 0)) fail("archive_padding");
    }
    for (const name of [
      "chrome",
      "google-chrome",
      "chrome_crashpad_handler",
      "chrome-sandbox",
      "icudtl.dat",
      "resources.pak",
      "locales",
    ])
      if (!runtime.has(name)) fail("runtime_missing");
    return { entries: count, runtimeEntries: runtime.size };
  } catch (error) {
    await iterator.return?.();
    throw error;
  }
}

export function checkPackage(file, manifest, execute = execFileSync) {
  const value = execute("dpkg-deb", ["--field", file, "Package", "Version", "Architecture"], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024,
  });
  if (
    value !==
    `Package: ${manifest.package}\nVersion: ${manifest.version}\nArchitecture: ${manifest.architecture}\n`
  )
    fail("package_identity");
}

async function install() {
  if (process.platform !== "linux" || process.arch !== "x64") fail("platform");
  const manifest = validateManifest(
    JSON.parse(await readFile(new URL("./chrome-manifest.json", import.meta.url), "utf8")),
  );
  const directory = await mkdtemp(join(tmpdir(), "pinned-chrome-"));
  try {
    const file = join(directory, "chrome.deb");
    await downloadChrome(manifest, file);
    checkPackage(file, manifest);
    const child = spawn("dpkg-deb", ["--fsys-tarfile", file], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 180_000,
      killSignal: "SIGKILL",
    });
    const completion = new Promise((done) => {
      child.once("error", () => done(false));
      child.once("close", (code) => done(code === 0));
    });
    let result;
    try {
      result = await extractChrome(child.stdout, join(directory, "runtime"));
      if (!(await completion)) fail("archive_process");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await completion;
    }
    await mkdir("/opt/google", { recursive: true });
    await rename(join(directory, "runtime"), "/opt/google/chrome");
    await symlink("/opt/google/chrome/google-chrome", "/usr/bin/google-chrome-stable");
    await symlink("/opt/google/chrome/google-chrome", "/usr/bin/google-chrome");
    console.log(
      JSON.stringify({ event: "pinned_chrome_installed", version: manifest.version, ...result }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== "install") fail("command");
  await install();
}
