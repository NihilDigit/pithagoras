# Pi User Defaults

## Local Toolchain

Prefer the user's local tools and package managers:

- JS/TS: use `bun` instead of `npm`, `yarn`, or direct `node` commands when the project permits it.
- Python: use `uv` instead of ad-hoc `pip`, `venv`, or `poetry` workflows unless the project already requires another tool.
- One-off Python commands: use `uvx`.
- One-off JS commands: use `bunx`.
- ML or GPU-heavy environments with mixed dependencies: prefer `pixi` when the project uses it.
- Arch/Linux system packages on this user's machines: use `paru -S` or `sudo pacman -S` when installation is explicitly needed.

If a project pins another toolchain, follow the project. Examples: use `npm` when `package-lock.json` and scripts require it; use Poetry/PDM when the repo is built around it; use `pnpm` when the lockfile and scripts require it.

## File Safety

Use the platform-specific trash command for deleting user or project files when available. On Linux, prefer `trash-put <path>`.

Do not silently delete, uninstall, clean, prune, or remove user/project files, packages, profiles, skills, or configuration.

Before editing an untracked file, create a timestamped `.bak` copy first. Check tracking with:

```bash
git ls-files --error-unmatch <file>
```

Exit code `0` means the file is tracked, so skip the backup. Non-zero means it is untracked; back it up before editing.

Do not use `git checkout` mid-session unless explicitly requested. Avoid hard resets, force checkouts, force pushes, and broad cleanup commands unless the user explicitly asks for them.

## Command Output Discipline

Prefer `rg` / `rg --files` for search.

Use compact output when raw logs are not needed:

```bash
rtk grep ...
rtk read ...
rtk find ...
rtk git status
rtk git diff
rtk pytest
rtk cargo test
rtk tsc
rtk next build
```

Do not use `rtk` when exact raw output is the artifact being inspected, copied, or reported.

## Browser Use

For current web facts, use browser/search tooling and cite sources.

For local browser automation, prefer `agent-browser` with the user's real Chrome profile in headed mode. The default user-level agent-browser config should keep:

```json
{
  "headed": true,
  "profile": "Default"
}
```

Invoke it with `bunx agent-browser ...` unless a project installs or pins another entry point. This should reuse the user's logged-in Chrome state and show the browser window.

Keep browser actions read-only by default. Ask before submitting forms, changing settings, sending messages, deleting data, purchasing, or touching account-sensitive state.

## Documentation Fallbacks

For library API usage, official documentation snippets, and quick examples, `bunx ctx7 ...` may be used as a fallback or supplement. Prefer source clones, direct documentation pages, and permalinks for implementation details or claims that need evidence.

## Linux / Arch Tooling Defaults

Use the distro `trash-cli` package on Linux. It provides `trash`, `trash-put`, `trash-list`, `trash-restore`, and related FreeDesktop trash helpers. Do not use the npm `trash-cli` package for Linux setup.

Use `fd` on Arch-family systems; `fdfind` is the Debian/Ubuntu binary name.

Prefer `*-bin` AUR packages when both source-build and binary variants are available. Source AUR packages can trigger long local builds and heavy dependency downloads. Examples:

- Use `powershell-bin`, not `powershell`.
- Use `visual-studio-code-bin`, not a source build, when the binary package fits the task.
