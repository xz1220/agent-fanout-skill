import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { buildVersion, verifyVersionOutput } from "../scripts/version-info.mjs";
import { BUILD_INFO, VERSION } from "../src/index.js";
import { versionText } from "../src/cli.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "odw-version-"));
  const root = pathToFileURL(`${dir}/`);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ version: "1.2.3", packages: { "": { version: "1.2.3" } } }));
  git("init", "--quiet");
  git("add", "package.json", "package-lock.json");
  git("-c", "user.name=ODW Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  return { dir, root, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("CLI and library versions use the package build identity", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(BUILD_INFO.packageVersion, pkg.version);
  assert.equal(VERSION, BUILD_INFO.version);
  assert.equal(versionText(), `open-dynamic-workflows ${VERSION}`);
});

test("source builds identify the revision and uncommitted changes", () => {
  const f = fixture();
  try {
    const rev = f.git("rev-parse", "--short=12", "HEAD");
    assert.equal(buildVersion(f.root).version, `1.2.3-dev+g${rev}`);
    writeFileSync(join(f.dir, "pending.txt"), "not committed yet");
    assert.equal(buildVersion(f.root).version, `1.2.3-dev+g${rev}.dirty`);
  } finally { f.cleanup(); }
});

test("a release requires matching package, lockfile, tag and checkout", () => {
  const f = fixture();
  try {
    f.git("tag", "v1.2.3");
    assert.equal(buildVersion(f.root, "v1.2.3").version, "1.2.3");
    assert.equal(buildVersion(f.root, "v1.2.3").release, true);
    assert.throws(() => buildVersion(f.root, "v1.2.4"), /does not match/);
    writeFileSync(join(f.dir, "pending.txt"), "changed");
    assert.throws(() => buildVersion(f.root, "v1.2.3"), /clean Git checkout/);
    f.git("add", "pending.txt");
    f.git("-c", "user.name=ODW Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "newer code");
    assert.throws(() => buildVersion(f.root, "v1.2.3"), /does not point/);
    writeFileSync(join(f.dir, "package-lock.json"), JSON.stringify({ version: "1.2.2" }));
    assert.throws(() => buildVersion(f.root), /versions must match/);
  } finally { f.cleanup(); }
});

test("source archives do not inherit an enclosing repository's identity", () => {
  const f = fixture();
  try {
    const nested = join(f.dir, "archive");
    mkdirSync(nested);
    writeFileSync(join(nested, "package.json"), JSON.stringify({ version: "2.0.0" }));
    const root = pathToFileURL(`${nested}/`);
    assert.equal(buildVersion(root).version, "2.0.0-dev+source");
    assert.throws(() => buildVersion(root, "v2.0.0"), /clean Git checkout/);
  } finally { f.cleanup(); }
});

test("binary verification rejects a runnable but stale binary", () => {
  verifyVersionOutput("open-dynamic-workflows 1.2.3\n", "1.2.3");
  assert.throws(() => verifyVersionOutput("open-dynamic-workflows 1.2.2", "1.2.3"), /Binary version mismatch/);
  assert.throws(() => verifyVersionOutput("other-tool 1.2.3", "1.2.3"), /Binary version mismatch/);
});
