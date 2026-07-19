/**
 * Optional host-owned execution policy.
 *
 * ODW remains fully backward compatible when no policy is selected. A managed
 * host may set ODW_EXECUTION_POLICY, or install the conventional root-owned
 * /etc/odw/execution-policy.json for packaged binaries, to pin the one workflow
 * allowed as a normal root entry. Inline sources are only allowed for explicitly
 * listed internal origins (for example the built-in Chat Host), and nested
 * workflows require their own path+hash allowlist.
 *
 * This policy intentionally does not live in odw.config.json: project and user
 * configuration must not be able to turn off a host boundary.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { ExecutionPolicyError } from "../errors.js";
import { isSeaBinary } from "../sea.js";

export const EXECUTION_POLICY_ENV = "ODW_EXECUTION_POLICY";
export const SYSTEM_EXECUTION_POLICY = "/etc/odw/execution-policy.json";

const SHA256 = /^[a-f0-9]{64}$/;

export interface PinnedWorkflowRule {
  name: string;
  path: string;
  sha256: string;
}

export interface ExecutionPolicy {
  version: 1;
  policyPath: string;
  policySha256: string;
  root: PinnedWorkflowRule;
  allowedInlineOrigins: string[];
  nested: PinnedWorkflowRule[];
}

export interface ExecutionPolicyReceipt {
  version: 1;
  policyPath: string;
  policySha256: string;
  mode: "root" | "inline-origin";
  workflowName: string;
  workflowSha256: string;
  originalPath: string | null;
  origin: string | null;
}

interface RootCandidate {
  workflowName: string;
  sourceCode: string;
  scriptPath?: string | null;
  origin?: string | null;
}

/**
 * Load the host policy selected by the trusted launcher. A packaged ODW binary
 * also discovers the conventional root-owned system policy, so invoking the
 * canonical binary directly cannot bypass a policy installed by the host.
 * Source/dev execution stays opt-in through the environment variable.
 */
export function loadHostExecutionPolicy(): ExecutionPolicy | null {
  const fromEnvironment = process.env[EXECUTION_POLICY_ENV]?.trim();
  const selected =
    fromEnvironment || (isSeaBinary() && existsSync(SYSTEM_EXECUTION_POLICY) ? SYSTEM_EXECUTION_POLICY : "");
  if (!selected) return null;
  if (!isAbsolute(selected)) {
    throw new ExecutionPolicyError(`${EXECUTION_POLICY_ENV} must be an absolute path`);
  }
  return loadExecutionPolicyFile(selected, true);
}

/** Load and validate one policy file. `requireTrusted` is false only in unit tests. */
export function loadExecutionPolicyFile(path: string, requireTrusted = true): ExecutionPolicy {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    throw new ExecutionPolicyError(`execution policy not found: ${absolute}`);
  }
  if (requireTrusted) assertTrustedFile(absolute);
  const text = readFileSync(absolute, "utf8");
  return parseExecutionPolicy(text, absolute);
}

/** Parse policy JSON without filesystem trust checks (pure test/documentation seam). */
export function parseExecutionPolicy(text: string, policyPath = "<memory>"): ExecutionPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ExecutionPolicyError(
      `could not parse execution policy ${policyPath}: ${(err as Error).message}`,
    );
  }
  if (!isRecord(raw) || raw.version !== 1) {
    throw new ExecutionPolicyError(`execution policy ${policyPath} must be a version 1 object`);
  }
  const root = parseRule(raw.root, `${policyPath}: root`);
  const allowedInlineOrigins = parseStringList(
    raw.allowedInlineOrigins ?? [],
    `${policyPath}: allowedInlineOrigins`,
  );
  const nestedRaw = raw.nested ?? [];
  if (!Array.isArray(nestedRaw)) {
    throw new ExecutionPolicyError(`${policyPath}: nested must be an array`);
  }
  const nested = nestedRaw.map((value, index) => parseRule(value, `${policyPath}: nested[${index}]`));
  return {
    version: 1,
    policyPath: resolve(policyPath),
    policySha256: sha256(text),
    root,
    allowedInlineOrigins,
    nested,
  };
}

/** Authorize one top-level launch and return the immutable receipt stored in meta.json. */
export function authorizeRootWorkflow(
  policy: ExecutionPolicy | null,
  candidate: RootCandidate,
): ExecutionPolicyReceipt | null {
  if (!policy) return null;
  const workflowSha256 = sha256(candidate.sourceCode);
  const origin = candidate.origin?.trim() || null;

  if (candidate.scriptPath) {
    const originalPath = canonicalFile(candidate.scriptPath, "root workflow");
    const expected = policy.root;
    if (
      originalPath !== expected.path ||
      candidate.workflowName !== expected.name ||
      workflowSha256 !== expected.sha256
    ) {
      throw new ExecutionPolicyError(
        `host policy requires root workflow '${expected.name}' at ${expected.path} ` +
          `(sha256 ${expected.sha256}); refused '${candidate.workflowName}' at ${originalPath} ` +
          `(sha256 ${workflowSha256})`,
      );
    }
    return receipt(policy, "root", candidate.workflowName, workflowSha256, originalPath, origin);
  }

  if (!origin || !policy.allowedInlineOrigins.includes(origin)) {
    throw new ExecutionPolicyError(
      `host policy refuses inline root workflow '${candidate.workflowName}' from origin ${origin ?? "<none>"}`,
    );
  }
  return receipt(policy, "inline-origin", candidate.workflowName, workflowSha256, null, origin);
}

/** Re-check the launch receipt in the worker before any workflow body executes. */
export function verifyRootReceipt(
  policy: ExecutionPolicy | null,
  rawReceipt: unknown,
  candidate: Pick<RootCandidate, "workflowName" | "sourceCode">,
): ExecutionPolicyReceipt | null {
  if (!policy) {
    if (rawReceipt != null) {
      throw new ExecutionPolicyError("run was policy-pinned but the host execution policy is no longer active");
    }
    return null;
  }
  const receiptValue = parseReceipt(rawReceipt);
  if (receiptValue.policyPath !== policy.policyPath || receiptValue.policySha256 !== policy.policySha256) {
    throw new ExecutionPolicyError("host execution policy changed after this run was created");
  }
  const workflowSha256 = sha256(candidate.sourceCode);
  if (
    receiptValue.workflowName !== candidate.workflowName ||
    receiptValue.workflowSha256 !== workflowSha256
  ) {
    throw new ExecutionPolicyError("archived workflow source does not match its execution-policy receipt");
  }
  if (receiptValue.mode === "root") {
    const expected = policy.root;
    if (
      receiptValue.originalPath !== expected.path ||
      candidate.workflowName !== expected.name ||
      workflowSha256 !== expected.sha256
    ) {
      throw new ExecutionPolicyError("root workflow no longer matches the host policy pin");
    }
  } else if (
    !receiptValue.origin ||
    !policy.allowedInlineOrigins.includes(receiptValue.origin)
  ) {
    throw new ExecutionPolicyError("inline workflow origin is no longer allowed by the host policy");
  }
  return receiptValue;
}

/** Enforce the nested path+hash allowlist while a policy-pinned root is running. */
export function authorizeNestedWorkflow(
  policy: ExecutionPolicy | null,
  candidate: { workflowName: string; scriptPath: string; sourceCode: string },
): void {
  if (!policy) return;
  const path = canonicalFile(candidate.scriptPath, "nested workflow");
  const digest = sha256(candidate.sourceCode);
  const matched = policy.nested.some(
    (rule) => rule.path === path && rule.name === candidate.workflowName && rule.sha256 === digest,
  );
  if (!matched) {
    throw new ExecutionPolicyError(
      `host policy refuses nested workflow '${candidate.workflowName}' at ${path} (sha256 ${digest})`,
    );
  }
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function receipt(
  policy: ExecutionPolicy,
  mode: ExecutionPolicyReceipt["mode"],
  workflowName: string,
  workflowSha256: string,
  originalPath: string | null,
  origin: string | null,
): ExecutionPolicyReceipt {
  return {
    version: 1,
    policyPath: policy.policyPath,
    policySha256: policy.policySha256,
    mode,
    workflowName,
    workflowSha256,
    originalPath,
    origin,
  };
}

function parseReceipt(value: unknown): ExecutionPolicyReceipt {
  if (!isRecord(value) || value.version !== 1) {
    throw new ExecutionPolicyError("run is missing a valid execution-policy receipt");
  }
  const mode = value.mode;
  if (mode !== "root" && mode !== "inline-origin") {
    throw new ExecutionPolicyError("run execution-policy receipt has an invalid mode");
  }
  for (const field of ["policyPath", "policySha256", "workflowName", "workflowSha256"] as const) {
    if (typeof value[field] !== "string" || !value[field]) {
      throw new ExecutionPolicyError(`run execution-policy receipt has invalid ${field}`);
    }
  }
  if (!SHA256.test(String(value.policySha256)) || !SHA256.test(String(value.workflowSha256))) {
    throw new ExecutionPolicyError("run execution-policy receipt has an invalid sha256");
  }
  if (value.originalPath !== null && typeof value.originalPath !== "string") {
    throw new ExecutionPolicyError("run execution-policy receipt has invalid originalPath");
  }
  if (value.origin !== null && typeof value.origin !== "string") {
    throw new ExecutionPolicyError("run execution-policy receipt has invalid origin");
  }
  return value as unknown as ExecutionPolicyReceipt;
}

function parseRule(value: unknown, label: string): PinnedWorkflowRule {
  if (!isRecord(value)) throw new ExecutionPolicyError(`${label} must be an object`);
  if (typeof value.name !== "string" || !value.name.trim()) {
    throw new ExecutionPolicyError(`${label}.name must be a non-empty string`);
  }
  if (typeof value.path !== "string" || !isAbsolute(value.path)) {
    throw new ExecutionPolicyError(`${label}.path must be an absolute path`);
  }
  if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) {
    throw new ExecutionPolicyError(`${label}.sha256 must be 64 lowercase hex characters`);
  }
  return {
    name: value.name.trim(),
    path: canonicalFile(value.path, label),
    sha256: value.sha256,
  };
}

function parseStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ExecutionPolicyError(`${label} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item) => String(item).trim()))];
}

function canonicalFile(path: string, label: string): string {
  try {
    const canonical = realpathSync(path);
    if (!statSync(canonical).isFile()) throw new Error("not a regular file");
    return canonical;
  } catch (err) {
    throw new ExecutionPolicyError(`${label} is not a readable regular file: ${path} (${(err as Error).message})`);
  }
}

function assertTrustedFile(path: string): void {
  const file = lstatSync(path);
  if (file.isSymbolicLink() || !file.isFile()) {
    throw new ExecutionPolicyError(`execution policy must be a regular non-symlink file: ${path}`);
  }
  const parentPath = dirname(path);
  const parent = lstatSync(parentPath);
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new ExecutionPolicyError(`execution policy parent must be a regular directory: ${parentPath}`);
  }
  if (typeof process.getuid === "function") {
    if (file.uid !== 0 || parent.uid !== 0) {
      throw new ExecutionPolicyError("execution policy and its parent directory must be owned by root");
    }
    if ((file.mode & 0o022) !== 0 || (parent.mode & 0o022) !== 0) {
      throw new ExecutionPolicyError("execution policy and its parent directory must not be group/world writable");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
