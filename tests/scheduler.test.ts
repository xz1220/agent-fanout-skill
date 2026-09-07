import { test } from "node:test";
import assert from "node:assert/strict";

import { Scheduler } from "../src/scheduler.js";
import { AgentLimitExceeded, BudgetExhausted, RunStopped } from "../src/errors.js";
import { MemoryControl } from "../src/control.js";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("the concurrency cap is never exceeded", async () => {
  const s = new Scheduler({ concurrency: 2, maxAgents: 1000 });
  let active = 0;
  let peak = 0;
  const task = () =>
    s.runAgent(async () => {
      active++;
      peak = Math.max(peak, active);
      await delay(15);
      active--;
      return 1;
    });
  await Promise.all([task(), task(), task(), task(), task()]);
  assert.equal(peak, 2, `peak concurrency was ${peak}`);
  assert.equal(s.dispatched, 5);
});

test("the total-agent backstop aborts after the cap", async () => {
  const s = new Scheduler({ concurrency: 4, maxAgents: 2 });
  await s.runAgent(async () => 1);
  await s.runAgent(async () => 1);
  await assert.rejects(() => s.runAgent(async () => 1), AgentLimitExceeded);
});

test("gather preserves input order; a recoverable failure becomes null", async () => {
  const s = new Scheduler({ concurrency: 4, maxAgents: 1000 });
  const out = await s.gather([
    async () => 1,
    async () => {
      throw new Error("recoverable");
    },
    async () => 3,
  ]);
  assert.deepEqual(out, [1, null, 3]);
});

test("gather re-throws a fatal error (stop / backstop)", async () => {
  const s = new Scheduler({ concurrency: 4, maxAgents: 1000 });
  await assert.rejects(
    () =>
      s.gather([
        async () => 1,
        async () => {
          throw new RunStopped("stop");
        },
      ]),
    RunStopped,
  );
});

test("the checkpoint runs before each dispatch", async () => {
  let calls = 0;
  const s = new Scheduler({
    concurrency: 2,
    maxAgents: 1000,
    checkpoint: () => {
      calls++;
    },
  });
  await Promise.all([s.runAgent(async () => 1), s.runAgent(async () => 1)]);
  assert.equal(calls, 2);
});

test("T6: a budgetGuard that throws aborts dispatch with a fatal error", async () => {
  const s = new Scheduler({
    concurrency: 2,
    maxAgents: 1000,
    budgetGuard: () => {
      // a non-stub `spent() >= total` would throw exactly like this
      throw new BudgetExhausted("over budget");
    },
  });
  await assert.rejects(() => s.runAgent(async () => "x"), BudgetExhausted);
  assert.equal(s.dispatched, 0, "a spent-out run dispatches nothing");
  // and it is fatal, so it re-throws through gather (aborts the batch) — the
  // thunks must go through runAgent, where the guard lives.
  await assert.rejects(
    () => s.gather([() => s.runAgent(async () => "a"), () => s.runAgent(async () => "b")]),
    BudgetExhausted,
  );
});

test("T6: the budget guard runs before the runaway backstop", async () => {
  // maxAgents would also reject, but the budget guard must win and abort first.
  const s = new Scheduler({
    concurrency: 1,
    maxAgents: 0,
    budgetGuard: () => {
      throw new BudgetExhausted("over budget");
    },
  });
  await assert.rejects(() => s.runAgent(async () => 1), BudgetExhausted);
});

test("T6: a non-throwing budget guard (v1 stub spent=0) leaves dispatch unchanged", async () => {
  let calls = 0;
  const s = new Scheduler({
    concurrency: 2,
    maxAgents: 1000,
    budgetGuard: () => {
      calls++; // spent() === 0 < total → never throws
    },
  });
  const r = await s.runAgent(async () => 42);
  assert.equal(r, 42);
  assert.equal(calls, 1);
  assert.equal(s.dispatched, 1);
});

test("stop prevents queued agents from starting and releases every waiting slot", { timeout: 1000 }, async () => {
  const control = new MemoryControl();
  const s = new Scheduler({ concurrency: 1, maxAgents: 1000, checkpoint: () => control.checkpoint() });
  const started = gate();
  const finish = gate();
  const first = s.runAgent(async () => { started.release(); await finish.promise; return "first"; });
  await started.promise;
  let queuedStarts = 0;
  const queued = [1, 2].map(() => s.runAgent(async () => { queuedStarts++; }));
  const settled = Promise.allSettled(queued);
  await nextTurn(); // Both requests are waiting behind the first agent.
  control.stop();
  finish.release();

  assert.equal(await first, "first", "stop does not interrupt an agent already running");
  for (const result of await settled) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.ok(result.reason instanceof RunStopped);
  }
  assert.equal(queuedStarts, 0);
  assert.equal(s.dispatched, 1, "blocked requests are not counted as dispatched");
});

test("pause during queueing holds the next dispatch until resume", { timeout: 1000 }, async () => {
  const control = new MemoryControl();
  const s = new Scheduler({ concurrency: 1, maxAgents: 1000, checkpoint: () => control.checkpoint() });
  const started = gate();
  const finish = gate();
  const first = s.runAgent(async () => { started.release(); await finish.promise; });
  await started.promise;
  let queuedStarted = false;
  const second = s.runAgent(async () => { queuedStarted = true; return "second"; });
  await nextTurn();
  control.pause();
  finish.release();
  await first;
  await nextTurn();
  try {
    assert.equal(queuedStarted, false);
    assert.equal(s.dispatched, 1);
  } finally {
    control.resume();
  }
  assert.equal(await second, "second");
  assert.equal(s.dispatched, 2);
});

test("stop wakes a paused dispatch and does not strand agents behind it", { timeout: 1000 }, async () => {
  const control = new MemoryControl();
  const s = new Scheduler({ concurrency: 1, maxAgents: 1000, checkpoint: () => control.checkpoint() });
  const started = gate();
  const finish = gate();
  const first = s.runAgent(async () => { started.release(); await finish.promise; });
  await started.promise;
  let queuedStarts = 0;
  const settled = Promise.allSettled([1, 2].map(() => s.runAgent(async () => { queuedStarts++; })));
  await nextTurn();
  control.pause();
  finish.release();
  await first;
  await nextTurn();
  control.stop();

  for (const result of await settled) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.ok(result.reason instanceof RunStopped);
  }
  assert.equal(queuedStarts, 0);
  assert.equal(s.dispatched, 1);
});

test("budget spent while queued prevents dispatch and returns the slot", { timeout: 1000 }, async () => {
  let spent = 0;
  const s = new Scheduler({
    concurrency: 1,
    maxAgents: 1000,
    budgetGuard: () => { if (spent >= 1) throw new BudgetExhausted("spent"); },
  });
  const started = gate();
  const finish = gate();
  // Match primitives.agent(): the completed reply updates usage after runAgent
  // resolves, while the scheduler is handing its slot to the next request.
  const first = s.runAgent(async () => { started.release(); await finish.promise; }).then(() => { spent = 1; });
  await started.promise;
  let queuedStarted = false;
  const second = s.runAgent(async () => { queuedStarted = true; });
  const rejected = assert.rejects(second, BudgetExhausted);
  await nextTurn();
  finish.release();
  await first;
  await rejected;

  assert.equal(queuedStarted, false);
  assert.equal(s.dispatched, 1);
  spent = 0; // A later admitted call proves that the rejected one released its slot.
  assert.equal(await s.runAgent(async () => "next"), "next");
  assert.equal(s.dispatched, 2);
});

test("queued requests do not consume the dispatch cap and cap failures drain the queue", { timeout: 1000 }, async () => {
  const s = new Scheduler({ concurrency: 1, maxAgents: 1 });
  const started = gate();
  const finish = gate();
  const first = s.runAgent(async () => { started.release(); await finish.promise; });
  await started.promise;
  let queuedStarts = 0;
  const settled = Promise.allSettled([1, 2].map(() => s.runAgent(async () => { queuedStarts++; })));
  await nextTurn();
  finish.release();
  await first;

  for (const result of await settled) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.ok(result.reason instanceof AgentLimitExceeded);
  }
  assert.equal(queuedStarts, 0);
  assert.equal(s.dispatched, 1);
});
