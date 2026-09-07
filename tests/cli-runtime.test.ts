import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_STARTED, event } from "../src/events.js";
import { main } from "../src/cli.js";
import { waitFor } from "../src/runtime/launcher.js";
import { JsonlSink, RunStore } from "../src/runtime/run-store.js";

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: unknown) => {
    // node:test sends its protocol as buffers during asynchronous commands.
    if (Buffer.isBuffer(s)) return so(s);
    out.push(String(s));
    return true;
  };
  (process.stderr as { write: unknown }).write = (s: unknown) => {
    if (Buffer.isBuffer(s)) return se(s);
    err.push(String(s));
    return true;
  };
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

test("list / status / result / stop wire to the run directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-cli-"));
  try {
    const store = new RunStore(root);
    const id = store.create({ script: "/x/wf.js", args: null, source: "/s" });
    store.updateStatus(id, { state: "done", name: "demo" });
    store.writeResult(id, { answer: 42 });

    let r = await run(["list", "--runs-root", root]);
    assert.equal(r.code, 0);
    assert.match(r.out, new RegExp(id));

    r = await run(["status", id, "--runs-root", root]);
    assert.equal(r.code, 0);
    assert.match(r.out, /done/);
    assert.match(r.out, /demo/);

    r = await run(["result", id, "--runs-root", root]);
    assert.equal(r.code, 0);
    assert.match(r.out, /42/);

    r = await run(["stop", id, "--runs-root", root]);
    assert.equal(r.code, 0);
    assert.equal(store.readControl(id), "stop");

    r = await run(["status", "missing-run", "--runs-root", root]);
    assert.equal(r.code, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("list with no runs is a clean exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-cli-"));
  try {
    const r = await run(["list", "--runs-root", root]);
    assert.equal(r.code, 0);
    assert.match(r.err, /no runs found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status derives live dispatched count from agent events", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-cli-"));
  try {
    const store = new RunStore(root);
    const id = store.create({ script: "/x/slow-control.js", args: null, source: "/s" });
    store.updateStatus(id, { state: "paused", name: "slow-control", dispatched: 0 });
    const sink = new JsonlSink(store.eventsPath(id));
    sink.emit(event(AGENT_STARTED, { label: "first-agent", adapter: "mock" }));

    const r = await run(["status", id, "--runs-root", root]);
    assert.equal(r.code, 0);
    assert.match(r.out, /paused/);
    assert.match(r.out, /dispatched: 1 agent\(s\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run --wait reports an exited worker as failure, not a timeout or continuing run", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-cli-crash-"));
  try {
    const script = join(root, "crash.js");
    writeFileSync(script, "export const meta = { name: 'crash', description: 'x' }; process.exit(7)");
    const result = await run(["run", script, "--wait", "--timeout", "5", "--runs-root", root]);
    assert.equal(result.code, 1);
    assert.match(result.err, /worker process .* is gone/);
    assert.doesNotMatch(result.err, /timed out|run continues/);
    assert.equal(result.out, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run --wait timeout keeps exit 124 and the live worker completes afterwards", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-cli-timeout-"));
  const store = new RunStore(root);
  try {
    const script = join(root, "slow.js");
    writeFileSync(script, "export const meta = { name: 'slow', description: 'x' }; await new Promise(r => setTimeout(r, 150)); return 'ok'");
    const result = await run(["run", script, "--wait", "--timeout", "0", "--runs-root", root]);
    assert.equal(result.code, 124);
    assert.match(result.err, /timed out.*run continues/);
    const id = store.listRuns()[0]!.runId;
    assert.equal((await waitFor(store, id, { timeoutMs: 5000 })).state, "done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("logs --follow exits nonzero for a vanished worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-cli-logs-"));
  try {
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    assert.equal(dead.status, 0);
    const store = new RunStore(root);
    const id = store.create({ script: "/test.js", source: root, args: null });
    store.updateStatus(id, { state: "paused", pid: dead.pid });
    const result = await run(["logs", id, "--follow", "--runs-root", root]);
    assert.equal(result.code, 1);
    assert.match(result.err, /worker process .* is gone/);
    assert.equal(store.readStatus(id).state, "paused");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("logs --follow waits for live workers and drains final events exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-cli-logs-"));
  try {
    const store = new RunStore(root);
    const id = store.create({ script: "/test.js", source: root, args: null });
    store.updateStatus(id, { state: "running", pid: process.pid });
    const sink = new JsonlSink(store.eventsPath(id));
    sink.emit(event("log", { message: "before-poll" }));
    const timer = setTimeout(() => {
      sink.emit(event("run_finished"));
      store.updateStatus(id, { state: "done" });
    }, 30);
    try {
      const result = await run(["logs", id, "--follow", "--runs-root", root]);
      assert.equal(result.code, 0);
      assert.equal(result.out.match(/before-poll/g)?.length, 1);
      assert.equal(result.out.match(/run_finished/g)?.length, 1);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("logs --follow preserves an event-only failure when its worker already died", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-cli-logs-"));
  try {
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    assert.equal(dead.status, 0);
    const store = new RunStore(root);
    const id = store.create({ script: "/test.js", source: root, args: null });
    store.updateStatus(id, { state: "running", pid: dead.pid });
    new JsonlSink(store.eventsPath(id)).emit(event("run_failed", { error: "precise failure" }));
    const result = await run(["logs", id, "--follow", "--runs-root", root]);
    assert.equal(result.code, 1);
    assert.match(result.err, /run failed: precise failure/);
    assert.doesNotMatch(result.err, /is gone|unknown error/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
