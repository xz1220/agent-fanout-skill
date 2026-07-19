import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ExecutionPolicyError } from "../src/errors.js";
import {
  authorizeNestedWorkflow,
  authorizeRootWorkflow,
  parseExecutionPolicy,
  sha256,
  verifyRootReceipt,
} from "../src/runtime/execution-policy.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odw-policy-"));
  const rootPath = join(root, "root.js");
  const nestedPath = join(root, "nested.js");
  const otherPath = join(root, "other.js");
  const rootSource = "export const meta = { name: 'pool', description: 'x' }\nreturn 1\n";
  const nestedSource = "export const meta = { name: 'child', description: 'x' }\nreturn 2\n";
  const otherSource = "export const meta = { name: 'other', description: 'x' }\nreturn 3\n";
  mkdirSync(root, { recursive: true });
  writeFileSync(rootPath, rootSource);
  writeFileSync(nestedPath, nestedSource);
  writeFileSync(otherPath, otherSource);
  const policyText = JSON.stringify({
    version: 1,
    root: { name: "pool", path: rootPath, sha256: sha256(rootSource) },
    allowedInlineOrigins: ["chat"],
    nested: [{ name: "child", path: nestedPath, sha256: sha256(nestedSource) }],
  });
  return {
    root,
    rootPath,
    nestedPath,
    otherPath,
    rootSource,
    nestedSource,
    otherSource,
    policy: parseExecutionPolicy(policyText, join(root, "policy.json")),
  };
}

test("execution policy pins a root workflow by canonical path, name, and hash", () => {
  const f = fixture();
  try {
    const receipt = authorizeRootWorkflow(f.policy, {
      workflowName: "pool",
      sourceCode: f.rootSource,
      scriptPath: f.rootPath,
    });
    assert.equal(receipt?.mode, "root");
    assert.equal(receipt?.originalPath, resolve(f.rootPath));

    assert.throws(
      () =>
        authorizeRootWorkflow(f.policy, {
          workflowName: "other",
          sourceCode: f.otherSource,
          scriptPath: f.otherPath,
        }),
      ExecutionPolicyError,
    );
    assert.throws(
      () =>
        authorizeRootWorkflow(f.policy, {
          workflowName: "pool",
          sourceCode: `${f.rootSource}// changed\n`,
          scriptPath: f.rootPath,
        }),
      /host policy requires root workflow/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("execution policy only accepts explicitly allowed inline origins", () => {
  const f = fixture();
  try {
    const receipt = authorizeRootWorkflow(f.policy, {
      workflowName: "chat-host",
      sourceCode: "export const meta = { name: 'chat-host', description: 'x' }\nreturn 1\n",
      origin: "chat",
    });
    assert.equal(receipt?.mode, "inline-origin");
    assert.throws(
      () =>
        authorizeRootWorkflow(f.policy, {
          workflowName: "inline",
          sourceCode: "export const meta = { name: 'inline', description: 'x' }\nreturn 1\n",
          origin: "cli",
        }),
      /refuses inline root workflow/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("worker receipt verification catches source or policy drift", () => {
  const f = fixture();
  try {
    const receipt = authorizeRootWorkflow(f.policy, {
      workflowName: "pool",
      sourceCode: f.rootSource,
      scriptPath: f.rootPath,
    });
    assert.deepEqual(
      verifyRootReceipt(f.policy, receipt, { workflowName: "pool", sourceCode: f.rootSource }),
      receipt,
    );
    assert.throws(
      () =>
        verifyRootReceipt(f.policy, receipt, {
          workflowName: "pool",
          sourceCode: `${f.rootSource}// tampered\n`,
        }),
      /archived workflow source does not match/,
    );
    assert.throws(
      () => verifyRootReceipt(null, receipt, { workflowName: "pool", sourceCode: f.rootSource }),
      /policy-pinned.*no longer active/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("nested workflow calls are denied unless path, name, and hash are all pinned", () => {
  const f = fixture();
  try {
    assert.doesNotThrow(() =>
      authorizeNestedWorkflow(f.policy, {
        workflowName: "child",
        scriptPath: f.nestedPath,
        sourceCode: f.nestedSource,
      }),
    );
    assert.throws(
      () =>
        authorizeNestedWorkflow(f.policy, {
          workflowName: "other",
          scriptPath: f.otherPath,
          sourceCode: f.otherSource,
        }),
      /refuses nested workflow/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
