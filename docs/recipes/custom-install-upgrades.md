# Safely upgrading a customized installation

The standard installer is intentionally simple: it downloads a release into a
temporary directory, replaces `$ODW_BIN_DIR/odw` (default
`~/.local/bin/odw`), and then verifies that the installed binary starts. It
also refreshes the ODW skill.
It may run `odw init` to select a default adapter, but it does not manage your
custom wrapper, service definition, managed workflows, or run history.

That default is right for a standard installation. Use the procedure below when
`odw` on your `PATH` is a wrapper, a service starts ODW from a separate runtime
path, or agent CLIs enter a sandbox through custom adapter commands. If the
wrapper occupies `$ODW_BIN_DIR/odw` (by default `~/.local/bin/odw`), re-running
the installer for that destination replaces the wrapper itself.

## Keep the wrapper and runtime separate

Give the official binary a canonical directory and leave the public command as
a small wrapper:

```text
~/.local/bin/odw                  # wrapper; stable across upgrades
~/.local/libexec/odw-runtime/odw # official release binary
```

Install or upgrade only the canonical binary by setting `ODW_BIN_DIR` on the
installer process:

```bash
curl -fsSL \
  https://raw.githubusercontent.com/xz1220/open-dynamic-workflows/main/scripts/install.sh \
  | ODW_BIN_DIR="$HOME/.local/libexec/odw-runtime" sh
```

Pin a release during a staged rollout. Keep `ODW_VERSION` and `ODW_REF` on the
same release tag so the binary and installed skill cannot drift across versions:

```bash
release=v0.4.0
curl -fsSL \
  "https://raw.githubusercontent.com/xz1220/open-dynamic-workflows/$release/scripts/install.sh" \
  | ODW_BIN_DIR="$HOME/.local/libexec/odw-runtime" \
    ODW_VERSION="$release" ODW_REF="$release" sh
```

A minimal wrapper can then delegate without changing ODW's arguments:

```sh
#!/bin/sh
set -eu
exec "$HOME/.local/libexec/odw-runtime/odw" "$@"
```

Keep sandbox setup in the agent adapter commands or their wrappers. ODW is the
orchestrator; each `agent()` call executes the configured local CLI command.

## Optional managed root workflow

A customized host can restrict packaged ODW binaries to one audited root
workflow without changing the workflow dialect. Install a root-owned policy at
`/etc/odw/execution-policy.json`:

```json
{
  "version": 1,
  "root": {
    "name": "dynamic-work-pool",
    "path": "/home/example/.odw/workflows/dynamic-work-pool.js",
    "sha256": "<64 lowercase hex characters>"
  },
  "allowedInlineOrigins": ["chat"],
  "nested": []
}
```

The packaged binary discovers that conventional path automatically. Source and
development launches only enable the boundary when `ODW_EXECUTION_POLICY`
points to an absolute policy path. The policy file and its parent must be owned
by root, must not be group/world writable, and must not be symlinks. Root and
nested workflows are matched by canonical path, declared name, and SHA-256;
the exact authorized root source is archived into the run and verified again
by the worker before its body executes.

After changing the managed workflow, update its policy hash atomically before
acceptance testing. A stale hash fails closed. Keep `allowedInlineOrigins`
empty unless a trusted built-in source such as the Chat Host must remain
available, and explicitly pin every allowed nested workflow.

## Preflight

Before replacing a customized runtime:

1. Check that no important workflow is still running. Avoid mixing a new CLI or
   dashboard with workers from an older deployment during acceptance testing.
2. Record `odw --version`, the runtime binary checksum, the service definition,
   and the wrapper checksum.
3. Back up the wrapper, the canonical binary, `~/.config/odw/config.json`, and
   any custom managed workflows and host execution policy. Keep config backups
   private because adapter definitions may contain literal secrets or
   credential-bearing environment settings.
4. Read the release diff for changes to config loading, workflow primitives,
   workspace isolation, CLI flags, and the worker launcher.
5. Prepare a rollback copy of the previous canonical binary before installation.

Do not use `git reset --hard` or delete a dirty source checkout to make an
upgrade appear clean. Preserve unrelated local work first.

## Build and stage from source

For source-based deployments, fetch the target and build it in a detached,
temporary worktree. This preserves the user's existing checkout and ensures the
binary comes from the exact clean commit that was reviewed:

```bash
set -euo pipefail

repo=$(git rev-parse --show-toplevel)
git -C "$repo" fetch origin main
target_commit=$(git -C "$repo" rev-parse origin/main)
stage=$(mktemp -d)

cleanup() {
  git -C "$repo" worktree remove --force "$stage/source" >/dev/null 2>&1 || true
  rmdir "$stage" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

git -C "$repo" worktree add --detach "$stage/source" "$target_commit"
cd "$stage/source"
test -z "$(git status --porcelain)"
npm ci
npm test
npm run typecheck
npm run build:binary
./build/odw --version

target="$HOME/.local/libexec/odw-runtime/odw"
mkdir -p "$(dirname "$target")"
install -m 0755 build/odw "$target.new"
mv -f "$target.new" "$target"
```

The temporary sibling rename is atomic when both paths are on the same
filesystem. The trap removes the dedicated worktree on success, failure, or an
interrupt. For a root-owned target, replace only the final target operations in
the block with their privileged equivalents, including parent-directory
creation when needed:

```bash
target=/usr/local/libexec/odw-runtime/odw
sudo install -d -o root -g root -m 0755 "$(dirname "$target")"
sudo install -o root -g root -m 0755 build/odw "$target.new"
sudo mv -f "$target.new" "$target"
```

Do not run dependency installation, tests, or the build as root.

## Compatibility gates

Before declaring the upgrade complete, verify the customized parts rather than
only checking the version string:

- `odw --help` and `odw --version` run through the public wrapper.
- `odw workflows list` still finds the expected managed workflows.
- Loading the real config emits no unknown-key warnings.
- A read-only smoke workflow reaches every adapter class you intend to use.
- A concurrency test respects the configured cap and leaves no worker or
  temporary worktree behind.
- Service deployments still bind to the intended host and port, and their
  current-start logs contain no config warnings or startup errors.
- Agent wrappers still enter the expected sandbox and retain only the intended
  project access.

Use mock adapters for scheduler and routing tests whenever possible. They prove
fan-out behavior without spending model quota or granting an agent write access.

## Rollback

If any gate fails, stop the new service, restore the previous canonical binary
and customized files from the same backup set, then restart and repeat the
version, service, workflow, and sandbox checks. Restore source into a separate
checkout when investigating; do not overwrite a working tree that may contain
user changes.

The key rule is small: upgrade the official runtime, not the customization
boundary around it.
