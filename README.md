# pithagoras

Personal Pi setup for organizing and maintaining my own Pi environment.

This repository currently pins three pieces of setup:

- Pi user defaults in `configs/pi/AGENTS.md`
- Pi package expectations in `configs/pi/settings.json`
- `agent-browser` defaults in `configs/agent-browser/config.json`

`pi/` is a Git submodule pointing to [`earendil-works/pi`](https://github.com/earendil-works/pi). It is kept here as an implementation and documentation reference.

## Current setup

Pi packages:

- `npm:pi-resource-center`
- `npm:pi-web-access`

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

The script backs up existing target files before copying configs, installs the expected Pi packages, installs `agent-browser`, installs the `agent-browser` Agent Skill via `bunx skills`, and merges the package list into `~/.pi/agent/settings.json`.

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
