# pithagoras

Personal Pi setup for organizing and maintaining my own Pi environment.

This repository contains two pieces:

- a Pi package that provides the Pithagoras interaction stance extension and sudo-gate
- machine-independent dotfiles for my personal Pi setup, including the custom Pi footer

The setup snapshots are:

- Pi user defaults in `configs/pi/AGENTS.md`
- Pi system prompt append in `configs/pi/APPEND_SYSTEM.md`
- Pi package expectations in `configs/pi/settings.json`
- Pi footer extension in `configs/pi/extensions/pi-footer.ts`
- `pi-web-access` defaults in `configs/pi/web-search.json`
- `agent-browser` defaults in `configs/agent-browser/config.json`

`pi/` is a Git submodule pointing to [`earendil-works/pi`](https://github.com/earendil-works/pi). It is kept here as an implementation and documentation reference.

## Pi package

Install from GitHub:

```bash
pi install git:github.com/NihilDigit/pithagoras
```

Pin a specific ref when needed:

```bash
pi install git:github.com/NihilDigit/pithagoras@<tag-or-commit>
```

Try it for one run without installing:

```bash
pi -e git:github.com/NihilDigit/pithagoras
```

Local development:

```bash
pi -e .
```

Commands provided by the package:

- `/frame` — enter Framing stance
- `/probe` — enter Probe stance
- `/groundup` — enter GroundUp stance
- `/pithagoras off` — clear the current stance
- `/sudo-gate` — show sudo-gate status
- `/sudo-gate on|off` — enable or disable sudo-gate for this session branch
- `/sudo-gate paths` — show generated askpass, sudo wrapper, and broker socket paths
- `/sudo-gate forget` — clear the session sudo password from memory

Pithagoras works in small building blocks. Each stance uses an abstraction ladder so the user can follow the work before internal names appear:

- Framing: user knowledge baseline → user-visible model → mechanism vocabulary → decision point.
- Probe: user-visible doubt → testable hypothesis → cheap evidence → model update.
- GroundUp: user-visible change → runtime mechanism → code object → coherent slice.

The extension shows the active ladder in the TUI while a stance is enabled. GroundUp must orient the user around visible behavior, runtime mechanism, code target, and non-goals before touching tools.

Harness workspace:

- Framing writes only to `.pithagoras/framing.md`
- Probe writes only to `.pithagoras/probe.md` or `.pithagoras/experiments/`
- GroundUp edits implementation as one coherent vertical slice at a time. A slice may touch a small related module cluster when the constraint requires wiring, tests, or UI/data pairs.

Agent-facing prompts and UI text are English. User-facing replies and written artifacts follow the user's language; code comments stay English.

### sudo-gate

The package also includes `sudo-gate`, a small companion for agent `bash` commands that need `sudo`.

What it does:

- detects `sudo` in agent bash tool calls;
- asks for explicit approval in Pi before the command runs;
- asks for the sudo password in a masked Pi input when the session has no cached password;
- keeps the password in extension memory until session shutdown, `/reload`, `/sudo-gate forget`, or an authentication failure;
- creates a local askpass client under `~/.pi/agent/sudo-gate/`;
- serves the password through a per-process Unix socket using one-use tokens;
- runs sudo through `sudo -A` internally while the agent keeps writing normal `sudo ...` commands;
- blocks `sudo -S`, `--stdin`, `-n`, `--non-interactive`, password piping, and custom `SUDO_ASKPASS`.

It does not write the sudo password to disk or into the shell command/environment. The generated askpass client contains no password; it only asks the in-memory broker for a password after Pi has approved that specific sudo command.

After installing or updating the package, restart Pi or run `/reload`.

## Dotfiles

The files under `configs/` are the managed copies. `scripts/apply.sh` copies them into the local home directory and keeps machine-specific paths out of the repository.

Footer source:

- managed copy: `configs/pi/extensions/pi-footer.ts`
- local runtime copy: `~/.pi/agent/extensions/pi-footer.ts`

The footer is a compact single-line TUI status with current directory, git branch, worktree state, context usage, model, and thinking level. It uses Nerd Font icons and falls back to path truncation when the terminal is narrow.

## Current setup

Pi packages:

- `git:github.com/NihilDigit/pithagoras`
- `npm:pi-resource-center`
- `npm:pi-web-access`
- `npm:@aliou/pi-guardrails`

Browser automation:

- `agent-browser` global CLI
- `agent-browser` Agent Skill from `vercel-labs/agent-browser`
- headed mode
- Chrome `Default` profile for logged-in state

Documentation fallback:

- `bunx ctx7 ...` for quick library API/doc snippets when direct docs, source clones, or `pi-web-access` are not enough

## Apply

```bash
./scripts/apply.sh
```

The script backs up existing target files before copying configs, installs the expected Pi packages, installs `agent-browser`, installs the `agent-browser` Agent Skill via `bunx skills`, and merges the package list into `~/.pi/agent/settings.json`. It copies the managed footer extension to `~/.pi/agent/extensions/pi-footer.ts`.

After applying, restart Pi or run `/reload` where applicable.

## Reference submodule

Initialize or update the submodule:

```bash
git submodule update --init --recursive
```

Update the reference repository:

```bash
git -C pi pull
```
