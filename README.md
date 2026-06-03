# pithagoras

Personal Pi setup for organizing and maintaining my own Pi environment.

This repository contains two pieces:

- a Pi package that provides the Pithagoras interaction stance extension
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

Pithagoras works in small building blocks. Framing, Probe, and GroundUp all start from the user's current mental model, introduce one real-world constraint or decision point at a time, and stop at checkpoints.

Harness workspace:

- Framing writes only to `.pithagoras/framing.md`
- Probe writes only to `.pithagoras/probe.md` or `.pithagoras/experiments/`
- GroundUp may edit implementation files, one small slice at a time

Agent-facing prompts and UI text are English. User-facing replies and written artifacts follow the user's language; code comments stay English.

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
