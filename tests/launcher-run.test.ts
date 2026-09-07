import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startRun, startRunFromSource, waitFor } from "../src/runtime/launcher.js";
import { event } from "../src/events.js";
import { RunObserver } from "../src/runtime/run-liveness.js";
import { JsonlSink, RunStore } from "../src/runtime/run-store.js";

// These assert the launcher WIRING: that startRun resolves a bare name against
// <source>/.odw/workflows (not process.cwd()), via the shared resolveWorkflow,
// and can execute the worker from the TypeScript dev/test entrypoint.

test("startRun resolves a bare name against <source>/.odw/workflows", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "odw-launch-"));
  try {
    const proj = join(tmp, "proj");
    const wfDir = join(proj, ".odw", "workflows");
    mkdirSync(wfDir, { recursive: true });
    const wf = join(wfDir, "smoke.js");
    writeFileSync(wf, "export const meta = { name: 'smoke', description: 'x' }\nreturn 1\n");

    const { runId, store } = startRun("smoke", { source: proj, runsRoot: join(tmp, "runs") });
    const meta = store.readMeta(runId);
    assert.equal(meta.script, wf, "name must resolve to the project workflows file");
    assert.equal(meta.source, proj);
    const status = await waitFor(store, runId, { timeoutMs: 5000 });
    assert.equal(status.state, "done");
    assert.equal(store.readResult(runId), 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("waitFor detects a worker that exits without writing its terminal status", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-crash-"));
  try {
    const { runId, store } = startRunFromSource(
      "export const meta = { name: 'crash', description: 'x' }; process.exit(7)",
      { runsRoot: root },
    );
    const pid = Number(readFileSync(join(store.runDir(runId), "worker.pid"), "utf8"));
    assert.ok(pid > 0);
    const status = await waitFor(store, runId, { timeoutMs: 5000, pollIntervalMs: 20 });
    assert.equal(status.state, "failed");
    assert.match(String(status.error), /worker process .* is gone/);
    assert.equal(store.readStatus(runId).state, "running", "observation must not overwrite history");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("spawn failure is recorded instead of leaving a pending run", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-spawn-"));
  try {
    const { runId, store } = startRunFromSource(
      "export const meta = { name: 'spawn', description: 'x' }; return 1",
      { runsRoot: root, source: join(root, "missing-working-directory") },
    );
    const status = await waitFor(store, runId, { timeoutMs: 5000, pollIntervalMs: 10 });
    assert.equal(status.state, "failed");
    assert.match(String(store.readError(runId)?.error), /worker failed to start:.*ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function observeFixture(fn: (store: RunStore, runId: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "odw-observe-"));
  try {
    const store = new RunStore(root);
    const runId = store.create({ script: "/test.js", source: root, args: null });
    fn(store, runId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("observers grant startup grace and keep quiet live workers waiting", () => {
  observeFixture((store, runId) => {
    let time = 0;
    const observer = new RunObserver(store, runId, () => time);
    assert.equal(observer.read().error, undefined);
    time = 9999;
    assert.equal(observer.read().error, undefined);
    writeFileSync(join(store.runDir(runId), "worker.pid"), String(process.pid));
    time = 60_000;
    assert.equal(observer.read().error, undefined, "slow startup is alive even without status.pid");
    for (const state of ["running", "paused"]) {
      store.updateStatus(runId, { state, pid: process.pid });
      time += 60_000;
      assert.equal(observer.read().error, undefined);
    }
  });
});

test("old pending runs without a pid fail after startup grace; invalid pids are not alive", () => {
  observeFixture((store, runId) => {
    let time = 0;
    const observer = new RunObserver(store, runId, () => time);
    for (const invalid of ["0", "-1", "NaN", "99999999999999999999"]) {
      writeFileSync(join(store.runDir(runId), "worker.pid"), invalid);
      time = 9999;
      assert.equal(observer.read().error, undefined);
      time = 10_000;
      assert.match(observer.read().error ?? "", /never started.*no worker pid/);
    }
  });
});

test("observers detect a dead pending worker before its first status write", () => {
  observeFixture((store, runId) => {
    writeFileSync(join(store.runDir(runId), "worker.pid"), "123");
    const observer = new RunObserver(store, runId, () => 0, () => false);
    assert.match(observer.read().error ?? "", /exited before the run started/);
  });
});

test("observers reread final events and status after discovering a dead worker", () => {
  for (const writeStatus of [false, true]) {
    observeFixture((store, runId) => {
      store.updateStatus(runId, { state: "running", pid: 123 });
      const observer = new RunObserver(store, runId, () => 0, () => {
        store.writeResult(runId, 42);
        new JsonlSink(store.eventsPath(runId)).emit(event("run_finished"));
        if (writeStatus) store.updateStatus(runId, { state: "done" });
        return false;
      });
      const observed = observer.read();
      assert.equal(observed.error, undefined);
      assert.equal(observed.terminal, true);
      assert.equal(observed.status.state, "done");
      assert.equal(observed.events.filter((ev) => ev.type === "run_finished").length, 1);
    });
  }
});

test("terminal events get a status-write grace and preserve failure details", () => {
  observeFixture((store, runId) => {
    store.updateStatus(runId, { state: "running", pid: process.pid });
    new JsonlSink(store.eventsPath(runId)).emit(event("run_failed", { error: "precise failure" }));
    let time = 0;
    const observer = new RunObserver(store, runId, () => time);
    assert.equal(observer.read().terminal, false);
    time = 2000;
    const observed = observer.read();
    assert.equal(observed.terminal, true);
    assert.equal(observed.status.state, "failed");
    assert.equal(observed.status.error, "precise failure");
    assert.equal(observed.events.length, 0, "events are never repeated");
  });
});

test("waitFor timeout leaves a live worker state alone, including timeout zero", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-timeout-"));
  try {
    const store = new RunStore(root);
    const runId = store.create({ script: "/test.js", source: root, args: null });
    store.updateStatus(runId, { state: "running", pid: process.pid });
    for (const timeoutMs of [0, 30]) {
      const status = await waitFor(store, runId, { timeoutMs, pollIntervalMs: 5 });
      assert.equal(status.state, "running");
      assert.equal(status.error, undefined);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startRun surfaces the resolver's not-found error for an unknown name", () => {
  const tmp = mkdtempSync(join(tmpdir(), "odw-launch-"));
  try {
    const proj = join(tmp, "proj");
    mkdirSync(join(proj, ".odw", "workflows"), { recursive: true });
    assert.throws(
      () => startRun("definitely-not-a-workflow", { source: proj, runsRoot: join(tmp, "runs") }),
      /no workflow named 'definitely-not-a-workflow'/,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
