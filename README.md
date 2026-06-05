# pithagoras

Personal Pi setup for organizing and maintaining my own Pi environment.

This repository contains two pieces:

- a Pi package that provides the Pithagoras PI+TA workflow extension and sudo-gate
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

- `/pithagoras` — enter PI+TA mode in the current session
- `/pithagoras <task>` — enter PI+TA mode and send the task to the PI
- `/pithagoras status` — show the current Pithagoras role
- `/pithagoras off` — clear the current Pithagoras role
- `/pith-return` — return from a TA session to its parent PI session
- `/sudo-gate` — show sudo-gate status
- `/sudo-gate on|off` — enable or disable sudo-gate for this session branch
- `/sudo-gate paths` — show generated askpass, sudo wrapper, and broker socket paths
- `/sudo-gate forget` — clear the session sudo password from memory

Pithagoras now runs as a PI+TA session workflow.

The PI stays in the main session. It treats real work as a teaching case: it frames the task around the user's understanding, reads only a small amount when needed, and dispatches focused TA sessions for explanation, exploration, probing, or building. The PI can use `spawn_ta` but cannot do implementation work itself.

Each TA runs in a separate Pi session. The TA works with the user on the task from the PI, using explanation, code reading, experiments, and implementation as needed. TA sessions keep the user's understanding first, assume the time budget is effectively unlimited, and stop to resolve confusion before advancing. If a task cannot be completed as given, the TA works with the user on a fallback and reports that back to the PI.

The extension adds two light guardrails:

- PI read budget: one file and 8 KB per turn. If more project reality is needed, the PI must dispatch a TA.
- TA small-step budget: limited reads, bash calls, and writes per turn. If the TA moves too far, the tool call is blocked and the TA must explain the current state to the user before continuing.

PI→TA and TA→PI switches both show an editable confirmation. The confirmed dispatch or handback is passed automatically through the session switch. No long-lived Spec document is required; the session handoff is the record.

Agent-facing prompts and UI text are English. User-facing replies and written artifacts follow the user's language; code comments stay English.

### sudo-gate

The package also includes `sudo-gate`, a small companion for agent `bash` commands that need `sudo`.

What it does:

- detects `sudo` in agent bash tool calls;
- opens a centered masked Pi password popup when the session has no cached password;
- treats cancelling the popup as a user decision and reports it back to the agent;
- keeps the password in extension memory until session shutdown, `/reload`, `/sudo-gate forget`, or an authentication failure;
- creates a local askpass client under `~/.pi/agent/sudo-gate/`;
- serves the password through a per-process Unix socket using short-lived per-command tokens;
- runs sudo through `sudo -A` internally while the agent keeps writing normal `sudo ...` commands;
- blocks `sudo -S`, `--stdin`, `-n`, `--non-interactive`, password piping, and custom `SUDO_ASKPASS`.

It does not write the sudo password to disk or into the shell command/environment. The generated askpass client contains no password; it only asks the in-memory broker for a password after Pi has opened the sudo password flow for that command.

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

Linux/macOS:

```bash
./scripts/apply.sh
```

Windows PowerShell:

```powershell
.\scripts\apply.ps1
```

Windows `cmd.exe`:

```bat
.\scripts\apply.cmd
```

The script backs up existing target files before copying configs, installs the expected Pi packages, installs `agent-browser`, installs the `agent-browser` Agent Skill via `bunx skills`, and merges the package list into `~/.pi/agent/settings.json`. It copies the managed footer extension to `~/.pi/agent/extensions/pi-footer.ts`.

On Windows, `scripts/apply.ps1` installs only `extensions/pithagoras/index.ts` from the Pithagoras package and writes `APPEND_SYSTEM.md` without the sudo-gate section. The Linux/macOS script keeps sudo-gate enabled.

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
