# Issue and PR triage — 2026-09-07

Reviewed all four open issues and the one open PR against `ceb6654` plus the
compatibility documentation accompanying this review. PR #30 was inspected at
`ad728e7ecf748cbe019cfd2dae31ec7a4bc16b1e`; its code was not executed.
Changes on main are still awaiting a public release.

| Item | Disposition | Remaining value |
| --- | --- | --- |
| [#6 — primitive compatibility](https://github.com/xz1220/open-dynamic-workflows/issues/6) | Close after the documentation update | The old missing primitives are implemented. README, both skill references, authoring types and schema contract tests now state the remaining boundaries. This closes a clarification task, not a promise of full runtime parity. |
| [#24 — stalled research runs](https://github.com/xz1220/open-dynamic-workflows/issues/24) | Keep; first follow-up | Persist and expose completed agent results before the whole workflow finishes. |
| [#23 — MCP write workflows](https://github.com/xz1220/open-dynamic-workflows/issues/23) | Keep; second follow-up | Distinguish tool approval outcomes and verify required side effects. |
| [#31 — command primitive](https://github.com/xz1220/open-dynamic-workflows/issues/31) | Keep as an enhancement | A managed command step that does not launch a model. |
| [#30 — custom upgrades and execution policy](https://github.com/xz1220/open-dynamic-workflows/pull/30) | Keep as a draft; split before merging | Custom-deployment documentation, workflow authoring guidance and an independently reviewed execution-policy proposal. |

## Completed results are the next reliability improvement

#24 still has an unresolved central problem: `agent_finished` records lifecycle
metadata, while the actual result is returned to the workflow in memory. Only
the final workflow result is persisted. A live but stalled lane can therefore
make the earlier work inaccessible.

Accept this follow-up when each completed result is atomically stored, can be
queried by run and agent while other work is running, and survives worker exit.
Events should reference results rather than embedding large output. Test a
completed first lane while the second remains blocked, then verify the saved
result after stopping or killing the worker.

Default-agent setup, queued stop/budget checks and dead-worker detection have
already improved. They do not provide result recovery or immediate cancellation
of already-running child processes. A live run continuing after `--wait
--timeout` is the documented observation-timeout behavior.

## MCP outcomes need evidence

#23 remains open because a zero exit code and schema-valid JSON do not prove
that a required write tool ran. Separate approval denied/cancelled, tool failure,
timeout and missing/unverified side effects. A mock that exits successfully with
valid JSON after a cancelled write must not satisfy an explicitly required
write operation. A real MCP write should only be checked in an authorized test.

The original Figma-specific failure was not rerun during this triage. Broad
approval/sandbox bypass is not an adequate completion criterion for this issue.

## Command steps are a feature request

#31's need is useful, but its explanation of JavaScript scope is inaccurate:
the current loader exposes the global `process`; `require` is absent in the ESM
execution context. The loader also rejects `import()` tokens, so dynamic import
is not a supported workaround today.

A future command primitive should use asynchronous process execution and define
arguments, cwd, timeout, output limits and cancellation. It should return stdout,
stderr and an exit code, work in source and SEA builds, and be documented as an
ODW extension. Do not adopt the proposed blocking `execSync` implementation.

## PR #30 contains three different changes

The title and description call it documentation-only, but the current head
changes 17 files, including a new execution-policy module. It also conflicts with
main. Conflict or age alone is not a reason to discard the contribution.

- **Custom upgrade guide:** separating a stable public wrapper from the official
  runtime, checking the actual service path and planning rollback still adds
  value. Update the guide to reflect the new transactional installer and legacy
  skill layout support, and submit this as a documentation change.
- **Authoring guidance:** distinguish the concurrency limit from the amount of
  useful work, decompose independently verifiable tasks, and handle missing
  results when complete delivery is required. This review incorporates the
  recoverable/fatal failure and partial-result clarification; the broader
  planning guidance can be considered separately.
- **Execution policy:** path/name/hash pinning and worker-side source verification
  need a separate design review. The PR loads metadata before authorization in
  launcher and worker paths, but the loader evaluates metadata with JavaScript.
  That permits effects before an unauthorized source is rejected. Rerun also
  takes `origin` from editable run metadata; an allowlisted origin string alone
  does not authenticate a trusted Chat Host launch. These boundaries need end-to-end
  tests before the policy can be treated as enforcement.

  Review anchors at the inspected PR head:
  [launcher parsing before authorization](https://github.com/zzjjzz-zz/open-dynamic-workflows/blob/ad728e7ecf748cbe019cfd2dae31ec7a4bc16b1e/src/runtime/launcher.ts#L104),
  [metadata evaluation](https://github.com/zzjjzz-zz/open-dynamic-workflows/blob/ad728e7ecf748cbe019cfd2dae31ec7a4bc16b1e/src/loader.ts#L325),
  [rerun origin](https://github.com/zzjjzz-zz/open-dynamic-workflows/blob/ad728e7ecf748cbe019cfd2dae31ec7a4bc16b1e/src/cli.ts#L545).

The existing install/version work (`86d86e0`, `501f9e6`) and inode-reuse fix
(`ceb6654`) supersede overlapping parts of #30. Close the original PR only when
its remaining useful parts have explicit successors, or the author withdraws
them. It is not ready to merge as one change.

The previously merged PRs, closed rename proposal #2 and superseded #33 need no
state change. None of the unresolved enhancement requests was closed solely
because it was old.
