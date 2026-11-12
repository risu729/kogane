import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, stat, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { CONTAINER_TARGETS, containerInputDigest } from "./ci/cf-container-release.mjs";
import {
  archiveEntry,
  checkPackage,
  downloadChrome,
  extractChrome,
  validateManifest,
} from "./pinned-chrome/chrome-install.mjs";
import { syncChrome } from "./pinned-chrome/sync.mjs";

const directories: string[] = [];
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "chrome-unit-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
const version = "157.0.8103.78-1";
const manifest = {
  schemaVersion: 1,
  package: "google-chrome-stable",
  version,
  architecture: "amd64",
  url: `https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${version}_amd64.deb`,
  bytes: 3,
  sha256: createHash("sha256").update("abc").digest("hex"),
};

test("both service-local build inputs equal their canonical sources", async () => {
  await syncChrome();
});

test("the committed package pin matches its signed-index provenance snapshot", async () => {
  const directory = new URL("./pinned-chrome/fixtures/provenance/", import.meta.url);
  const pinned = JSON.parse(
    await readFile(new URL("./pinned-chrome/manifest.json", import.meta.url), "utf8"),
  );
  const packages = await readFile(new URL("Packages", directory));
  const hash = createHash("sha256").update(packages).digest("hex");
  expect(packages.length).toBe(pinned.provenance.packagesBytes);
  expect(hash).toBe(pinned.provenance.packagesSha256);
  expect(await readFile(new URL("Release", directory), "utf8")).toContain(
    `${hash} ${packages.length} main/binary-amd64/Packages`,
  );
  const stanza = packages
    .toString("utf8")
    .split("\n\n")
    .find((row) => row.startsWith("Package: google-chrome-stable\n"))!;
  for (const [field, value] of [
    ["Version", pinned.version],
    ["Architecture", pinned.architecture],
    ["Size", pinned.bytes],
    ["SHA256", pinned.sha256],
  ])
    expect(stanza.split("\n")).toContain(`${field}: ${value}`);
  expect(stanza).toContain(
    `Filename: ${pinned.url.slice("https://dl.google.com/linux/chrome/deb/".length)}`,
  );
});

test("both existing release input digests cover the consumed installer and manifest", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const directory = await temporary();
  for (const target of CONTAINER_TARGETS.filter((target) => target.name !== "st-george-worker")) {
    await cp(join(root, target.path), join(directory, target.path), {
      recursive: true,
      filter: (path) =>
        !path
          .split("/")
          .some((part) => ["node_modules", ".cloudflare", ".wrangler"].includes(part)),
    });
    const original = containerInputDigest(directory, target);
    await appendFile(join(directory, target.path, "container/chrome-manifest.json"), "\n");
    const manifestChanged = containerInputDigest(directory, target);
    expect(manifestChanged).not.toBe(original);
    await appendFile(join(directory, target.path, "container/chrome-install.mjs"), "\n");
    expect(containerInputDigest(directory, target)).not.toBe(manifestChanged);
  }
});

test("the manifest accepts only one versioned official stable package identity", () => {
  expect(validateManifest(manifest)).toBe(manifest);
  for (const change of [
    { architecture: "arm64" },
    { package: "chromium" },
    { version: "stable" },
    { bytes: 200_000_001 },
    { bytes: -1 },
    { sha256: "z".repeat(64) },
    ...[
      "http://dl.google.com",
      "https://user@dl.google.com",
      "https://dl.google.com:444",
      "https://localhost",
    ].map((origin) => ({ url: manifest.url.replace("https://dl.google.com", origin) })),
    { url: `${manifest.url}?redirect=1` },
    { url: `${manifest.url}#fragment` },
    { url: manifest.url.replace(version, "current") },
    { url: manifest.url.replace("pool/", "pool/../") },
  ])
    expect(() => validateManifest({ ...manifest, ...change })).toThrow("manifest_invalid");
});

test("download bounds and integrity precede extraction, with no redirect/fallback", async () => {
  const directory = await temporary();
  let request: unknown;
  await downloadChrome(manifest, join(directory, "good"), async (url, options) => {
    request = { url, redirect: options.redirect, encoding: options.headers["Accept-Encoding"] };
    return new Response("abc", { headers: { "content-length": "3" } });
  });
  expect(await readFile(join(directory, "good"), "utf8")).toBe("abc");
  expect(request).toEqual({ url: manifest.url, redirect: "error", encoding: "identity" });
  const cases = [
    new Response("abc", { status: 302 }),
    new Response("abc", { status: 206 }),
    new Response("abc", { headers: { "content-length": "4" } }),
    new Response("abc", { headers: { "content-encoding": "gzip" } }),
    new Response("abcd"),
    new Response("ab"),
    new Response("bad"),
  ];
  for (const [i, response] of cases.entries())
    await expect(
      downloadChrome(manifest, join(directory, `bad-${i}`), async () => response),
    ).rejects.toThrow("pinned_chrome_");
  await expect(
    downloadChrome(manifest, join(directory, "good"), async () => new Response("abc")),
  ).rejects.toThrow();
});

test("untrusted manifest URL changes fail before any download or file creation", async () => {
  const directory = await temporary();
  for (const [index, url] of [
    manifest.url.replace("dl.google.com", "localhost"),
    manifest.url.replace("dl.google.com", "dl.google.com.example.com"),
    manifest.url.replace("https://", "https://user:password@"),
    manifest.url.replace("https://", "http://"),
    manifest.url.replace("dl.google.com", "dl.google.com:444"),
    manifest.url.replace("/pool/", "/pool/../"),
    manifest.url.replace("/pool/", "/pool/%2e%2e/"),
    manifest.url.replace("/pool/", "/pool/redirect/"),
    `${manifest.url}?redirect=https://example.com/`,
    `${manifest.url}#fragment`,
  ].entries()) {
    let called = false;
    const target = join(directory, `invalid-${index}`);
    await expect(
      downloadChrome({ ...manifest, url }, target, async () => {
        called = true;
        return new Response("abc");
      }),
    ).rejects.toThrow("manifest_invalid");
    expect(called).toBe(false);
    await expect(stat(target)).rejects.toThrow();
  }
  const changedVersion = "158.0.8103.78-1";
  expect(() =>
    validateManifest({
      ...manifest,
      version: changedVersion,
      url: manifest.url.replace(version, changedVersion),
    }),
  ).toThrow("manifest_invalid");
});

test("a rejected redirect never retries or creates a download target", async () => {
  const target = join(await temporary(), "redirect");
  let attempts = 0;
  await expect(
    downloadChrome(manifest, target, async (url, options) => {
      attempts += 1;
      expect(url).toBe(manifest.url);
      expect(options.redirect).toBe("error");
      throw new TypeError("synthetic redirect refused");
    }),
  ).rejects.toThrow("synthetic redirect refused");
  expect(attempts).toBe(1);
  await expect(stat(target)).rejects.toThrow();
});

function header(name: string, type = "0", body = "", mode = 0o644, link = "") {
  const bytes = Buffer.alloc(512);
  bytes.write(name, 0, 100, "ascii");
  for (const [offset, value, width] of [
    [100, mode, 8],
    [108, 0, 8],
    [116, 0, 8],
    [124, Buffer.byteLength(body), 12],
    [136, 0, 12],
  ])
    bytes.write(value!.toString(8).padStart(width! - 1, "0") + "\0", offset!, width!, "ascii");
  bytes.fill(32, 148, 156);
  bytes.write(type, 156, 1);
  bytes.write(link, 157, 100);
  bytes.write("ustar\0", 257, 6);
  bytes.write(
    bytes
      .reduce((sum, value) => sum + value, 0)
      .toString(8)
      .padStart(6, "0") + "\0 ",
    148,
    8,
  );
  return bytes;
}
function member(name: string, type = "0", body = "", mode = 0o644, link = "") {
  return Buffer.concat([
    header(name, type, body, mode, link),
    Buffer.from(body),
    Buffer.alloc((512 - (Buffer.byteLength(body) % 512)) % 512),
  ]);
}
function runtimeArchive(extra: Buffer[] = []) {
  return Buffer.concat([
    member("./", "5", "", 0o755),
    member("./opt/", "5", "", 0o755),
    member("./opt/google/", "5", "", 0o755),
    member("./opt/google/chrome/", "5", "", 0o755),
    ...[
      "chrome",
      "google-chrome",
      "chrome_crashpad_handler",
      "chrome-sandbox",
      "icudtl.dat",
      "resources.pak",
    ].map((name) =>
      member(`./opt/google/chrome/${name}`, "0", name, name === "chrome-sandbox" ? 0o4755 : 0o755),
    ),
    member("./opt/google/chrome/locales/", "5", "", 0o755),
    ...extra,
    Buffer.alloc(1024),
  ]);
}

test("data extraction retains the whole runtime, strips only privilege bits, never runs package scripts", async () => {
  const directory = await temporary();
  const data = runtimeArchive([
    member("./postinst", "0", `touch ${directory}/executed`, 0o755),
    member("./opt/google/chrome/locales/ja.pak", "0", "synthetic locale"),
  ]);
  const chunks = Array.from({ length: Math.ceil(data.length / 37) }, (_, i) =>
    data.subarray(i * 37, i * 37 + 37),
  );
  const result = await extractChrome(Readable.from(chunks), join(directory, "runtime"));
  expect(result.runtimeEntries).toBe(8);
  expect(await readFile(join(directory, "runtime/locales/ja.pak"), "utf8")).toBe(
    "synthetic locale",
  );
  expect((await stat(join(directory, "runtime/chrome-sandbox"))).mode & 0o7777).toBe(0o755);
  await expect(stat(join(directory, "executed"))).rejects.toThrow();
  await expect(stat(join(directory, "runtime/postinst"))).rejects.toThrow();
});

test("archive validation refuses path escapes, links, special files, privilege and ambiguous headers", () => {
  expect(archiveEntry(header("./", "5", "", 0o750))).toMatchObject({ name: ".", mode: 0o750 });
  for (const bytes of [
    header("/outside"),
    header("./opt/google/chrome/../outside"),
    header("./opt//google/chrome/x"),
    header("./opt/google/chrome/x", "2", "", 0o777, "../../outside"),
    header("./opt/google/chrome/x", "1"),
    header("./opt/google/chrome/x", "3"),
    header("./opt/google/chrome/x", "0", "", 0o4755),
    header("./opt/google/chrome/x", "x"),
  ])
    expect(() => archiveEntry(bytes)).toThrow("pinned_chrome_");
  const corrupt = header("./x");
  corrupt[0] = 65;
  expect(() => archiveEntry(corrupt)).toThrow("archive_checksum");
});

test("stream extraction refuses duplicates, truncation, nonzero trailers and absent runtime payload", async () => {
  const directory = await temporary();
  const duplicate = runtimeArchive([member("./opt/google/chrome/chrome", "0", "duplicate")]);
  const good = runtimeArchive();
  const badTrailer = Buffer.from(good);
  badTrailer[badTrailer.length - 1] = 1;
  for (const [i, data] of [
    duplicate,
    good.subarray(0, 2000),
    badTrailer,
    Buffer.alloc(1024),
  ].entries())
    await expect(extractChrome(Readable.from([data]), join(directory, `bad-${i}`))).rejects.toThrow(
      "pinned_chrome_",
    );
});

test("control metadata must identify the pinned package and architecture without executing scripts", () => {
  const expected = `Package: google-chrome-stable\nVersion: ${version}\nArchitecture: amd64\n`;
  expect(() => checkPackage("synthetic.deb", manifest, () => expected)).not.toThrow();
  expect(() =>
    checkPackage("synthetic.deb", manifest, () => expected.replace("amd64", "arm64")),
  ).toThrow("package_identity");
});
