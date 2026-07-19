---
name: open-dynamic-workflows
description: >
  Write and run dynamic workflows: short JavaScript scripts in Claude Code's
  workflow dialect, run with the `odw` CLI outside the host agent's context,
  fanning subtasks out to coding-agent CLIs (Codex, Claude Code, Gemini, Qwen,
  Kimi, or your own) in a background process and handing back only the final
  result. Use this skill when a task is bigger than a single call — parallel
  draft fan-out, multi-stage review pipelines, adversarial verification of
  findings, or discovery loops that run until nothing new turns up — or when
  the user mentions odw, dynamic workflows, multi-agent orchestration, or
  fanning out subagents.
license: MIT
---

# Open Dynamic Workflows

A dynamic workflow is a short JavaScript script: the orchestration plan is
ordinary code, executed by `odw` in a detached background process, dispatching
each subtask to a real coding-agent CLI process. Intermediate output never
enters your context; all that comes back is the script's final `return` value.

The flow is: **reuse a managed workflow when one fits → otherwise write one
small script → `odw run` → inspect the result, then act**. Don't use this for
work that fits in a single call — just do it directly.

Before authoring anything, run `odw workflows list --all` and inspect likely
matches with `odw workflows where <name>`. Prefer one existing, generic
workflow over accumulating one-off or project-specific workflows. Author a new
script only when its control flow is genuinely different and reusable.

For broad repository work, task count comes from the real leaf work (files,
components, tests, or independently verifiable evidence), not from the number
of adapters. The configured concurrency is only a ceiling: six broad thunks
still produce at most six-way concurrency even when the ceiling is 32. Plan
atomic leaves first, then fan them out. If completeness matters, count `null`
slots and recover or fail before synthesis; never silently summarize an
incomplete batch as success.

## Write the workflow script

- The file starts with `export const meta = {…}` — a **pure literal** (no
  variables, function calls, or template interpolation). `meta.name` and
  `meta.description` are required; `whenToUse`, `phases`, and `model` are
  optional.
- The body runs in an async context: use top-level `await` directly; the
  top-level `return` value is the workflow's result.
- The primitives are **injected globals** — never import them. Any top-level
  `import` / `export` other than `export const meta` is rejected by the
  loader.
- Ordinary control flow (loops, `if`, dedup) lives in the script. The
  primitives only **dispatch and wait**; what to do with results is the
  script's decision.

```js
// fan-out-reduce.js
export const meta = {
  name: 'fan-out-reduce',
  description: 'Draft in parallel, then synthesize.',
  phases: [{ title: 'Draft' }, { title: 'Synthesize' }],
}

const question = (args && args.question) || 'Design a cache.'

phase('Draft')
const drafts = await parallel(
  [1, 2, 3].map((i) => () => agent(`Draft #${i}: ${question}`, { phase: 'Draft' })),
)

phase('Synthesize')
return await agent(
  'Synthesize the best answer from:\n' + drafts.filter(Boolean).join('\n---\n'),
  { phase: 'Synthesize' },
)
```

Input passed with `--args` is injected as the global `args` (parsed JSON, or a
raw string — input that *looks like* JSON but fails to parse is rejected
outright, never silently passed through as a string).

## Primitives at a glance

| Primitive | What it does |
| --- | --- |
| `agent(prompt, opts?)` | Run one coding agent on a subtask; returns its reply text, or a validated object when `opts.schema` is set. The only verb that does real work. |
| `parallel(thunks)` | Run zero-arg thunks concurrently and **wait for all** (barrier). Order preserved; a failed slot is `null`. |
| `pipeline(items, ...stages)` | Stream each item through the stages independently (**no barrier**). Each stage receives `(prev, item, index)`. |
| `phase(title)` / `log(msg)` | Label the following work for progress / emit one progress line. |
| `args` | The workflow input (injected). |
| `budget` | `{ total, spent(), remaining() }` — scale depth to a token target. |
| `workflow(ref, args?)` | Run another workflow inline (one level deep). `ref` is a managed-directory name or `{ scriptPath }`; the child shares this run's concurrency cap, agent counter, and budget. |
| `validate(source)` | Compile-check a candidate workflow source without executing it; returns `{ ok, meta?, errors, warnings }`. **ODW extension** — not part of Claude Code's dialect. |

`opts` for `agent`: `{ adapter?, schema?, label?, phase?, model?, agentType?, isolation? }`.
`adapter` picks the CLI; `schema` is a raw JSON Schema object (an option, not
a global); `agentType` is a **persona** injected into the prompt — *not* an
adapter name.

**Rule of thumb:** use `parallel` when the next step needs the **whole batch**
at once (dedup, tally, synthesis); default to `pipeline` for multi-stage work.

Before writing complex compositions — nested workflows, schema retries,
budget-scaled depth — read
[`references/primitives.md`](references/primitives.md).

## Run and observe

```bash
odw run wf.js --wait --args '{"question": "Design a cache."}'   # block and print the result
```

For long runs, fire-and-poll instead of blocking yourself:

```bash
RUN=$(odw run wf.js)        # prints a run id and returns immediately
odw status $RUN             # state + agent count
odw logs $RUN --follow      # stream progress events
odw result $RUN             # print the final value when done
odw pause $RUN / resume $RUN / stop $RUN
odw list                    # all runs
```

Both patterns above behave exactly like this for you: your shell is not a
terminal, so `odw run` detaches and prints the run id. Only a bare invocation
in a human's interactive terminal attaches a live progress view instead
(Ctrl-C there detaches; the run keeps going; `odw attach <run_id>` re-attaches).
Force either way with `-d`/`--detach` or `--fg`, or `ODW_DETACH=1`.

Saved workflows run by name (`odw run <name>`); lookup order:
`.odw/workflows`, `.claude/workflows`, `~/.odw/workflows`,
`~/.claude/workflows`.

## Adapters

Codex, Claude Code, Gemini, Qwen, and Kimi work out of the box with no
configuration. To change the default CLI, tune flags, or plug in a custom CLI,
read [`references/adapters.md`](references/adapters.md) and write an
`odw.config.json` (at the project root or `~/.config/odw/config.json`, or pass
`--config`).

If a run fails with **AdapterNotFound** (several agent CLIs installed, no
default picked): run `odw init --check` to see which CLIs are installed — in
your non-interactive shell it only reports, never prompts. Then **ask your
user** which CLI to default to and persist their answer with
`odw init --adapter <name>`. Do not pick for them silently; the default decides
which vendor's CLI (and whose quota/permissions) every bare `agent()` call uses.

## Behavior you must know

- **Isolation**: agents run independently and never see each other — unless
  the script feeds one's output into another's prompt.
- **Workspace**: agents run directly in the run's source directory (`--source`,
  default the current directory) — the same semantics as Claude Code's own
  Workflow tool. For isolation, ask per agent with `isolation: "worktree"`: the
  agent gets a throwaway **git worktree** (needs the source to be a git repo
  with at least one commit; the agent sees HEAD, not uncommitted edits) and its
  changes come back as a diff — the real tree is never modified.
- **Cost**: concurrency is capped (default `min(16, cpus - 2)`) and total
  dispatches per run have a hard guard; use `odw pause` / `odw stop` when a
  run exceeds expectations.
- **Results**: the engine never commits, pushes, or applies diffs for you.
  Inspect the `return` value first, then decide the next step.

## Common mistakes

| Mistake | Correction |
| --- | --- |
| Importing primitives or other modules in the script | Primitives are injected globals; any extra top-level `import`/`export` is rejected by the loader. |
| Variables, spreads, or function calls inside `meta` | `meta` must be a pure literal. |
| Treating a concurrency setting as guaranteed fan-out | It is only a ceiling; create enough independent atomic thunks to use it. |
| Expecting failures inside `parallel`/`pipeline` to throw | A failed slot is `null`; count and recover/fail before a completeness-sensitive reduction. |
| Branching on which agent finished first | Breaks reproducibility; keep reductions order-independent. |
| Using `validate()` and expecting the script to run on Claude Code | `validate` is an ODW extension and runs on odw only. |
