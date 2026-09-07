import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

/** package.json owns the version; the lockfile must agree before we build. */
export function packageVersion(root) {
  const { version } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  if (typeof version !== "string" || !semver.test(version)) throw new Error("Invalid package version");
  const lockPath = new URL("package-lock.json", root);
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    if (lock.version !== version || lock.packages?.[""]?.version !== version) {
      throw new Error("package.json and package-lock.json versions must match");
    }
  }
  return version;
}

/** Embed build identity, so installed packages and SEA binaries need no Git or files at runtime. */
export function buildVersion(root, releaseTag = "") {
  const base = packageVersion(root);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let revision = null;
  let dirty = false;
  try {
    // A source archive inside another checkout must not inherit that checkout's identity.
    if (realpathSync(git("rev-parse", "--show-toplevel")) === realpathSync(root)) {
      revision = git("rev-parse", "--short=12", "HEAD");
      dirty = git("status", "--porcelain", "--untracked-files=normal") !== "";
    }
  } catch { /* A source archive can be built without Git. */ }

  if (releaseTag) {
    if (releaseTag !== `v${base}`) throw new Error(`Release tag ${releaseTag} does not match package version v${base}`);
    if (!revision || dirty) throw new Error("A release requires a clean Git checkout");
    if (git("rev-parse", "--verify", `refs/tags/${releaseTag}^{commit}`) !== git("rev-parse", "HEAD")) {
      throw new Error(`Release tag ${releaseTag} does not point to the current checkout`);
    }
    return { version: base, packageVersion: base, revision, release: true };
  }
  const suffix = revision ? `g${revision}${dirty ? ".dirty" : ""}` : "source";
  return { version: `${base}${base.includes("-") ? ".dev" : "-dev"}+${suffix}`, packageVersion: base, revision, release: false };
}

export function verifyVersionOutput(output, expected) {
  if (output.trim() !== `open-dynamic-workflows ${expected}`) {
    throw new Error(`Binary version mismatch: expected ${expected}, received ${output.trim()}`);
  }
}
