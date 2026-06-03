import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

const STATE_KEY = "sudo-gate";
const TOKEN_TTL_MS = 30_000;

interface SudoGateState {
	enabled: boolean;
}

interface PendingToken {
	expiresAt: number;
}

const DEFAULT_STATE: SudoGateState = { enabled: true };

function truncateCommand(command: string): string {
	const max = 1600;
	return command.length > max ? `${command.slice(0, max)}\n...` : command;
}

function restoreState(ctx: { sessionManager: { getBranch(): Array<{ type: string; customType?: string; data?: unknown }> } }): SudoGateState {
	let state = { ...DEFAULT_STATE };
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== STATE_KEY) continue;
		const data = entry.data as Partial<SudoGateState> | undefined;
		if (!data) continue;
		state = { enabled: data.enabled ?? state.enabled };
	}
	return state;
}

function sudoGateDir(): string {
	return join(homedir(), ".pi", "agent", "sudo-gate");
}

function socketPath(): string {
	const base = process.env.XDG_RUNTIME_DIR || tmpdir();
	return join(base, `pi-sudo-gate-${process.pid}.sock`);
}

function realSudoPath(): string {
	for (const candidate of ["/usr/bin/sudo", "/bin/sudo", "/usr/local/bin/sudo"]) {
		if (existsSync(candidate)) return candidate;
	}
	return "/usr/bin/sudo";
}

function ensureRuntimeFiles(): { dir: string; askpass: string; wrapper: string; sudoeditWrapper: string; realSudo: string } {
	const dir = sudoGateDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const askpass = join(dir, "askpass-client.mjs");
	const wrapper = join(dir, "sudo");
	const sudoeditWrapper = join(dir, "sudoedit");
	const realSudo = realSudoPath();

	writeFileSync(
		askpass,
		`#!/usr/bin/env node
import { createConnection } from "node:net";

const socket = process.env.SUDO_GATE_SOCKET;
const token = process.env.SUDO_GATE_TOKEN;
if (!socket || !token) {
  console.error("sudo-gate: missing broker socket or token");
  process.exit(1);
}

const client = createConnection(socket);
let data = "";
let done = false;

const finish = (code) => {
  if (done) return;
  done = true;
  client.destroy();
  process.exit(code);
};

const timer = setTimeout(() => {
  console.error("sudo-gate: password broker timed out");
  finish(1);
}, 10000);

client.on("connect", () => {
  client.write(JSON.stringify({ token }) + "\\n");
});

client.on("data", (chunk) => {
  data += chunk.toString("utf8");
  if (!data.includes("\\n")) return;
  clearTimeout(timer);
  const line = data.split("\\n", 1)[0] || "{}";
  try {
    const response = JSON.parse(line);
    if (response.ok && typeof response.password === "string") {
      process.stdout.write(response.password + "\\n");
      finish(0);
      return;
    }
    console.error(response.error || "sudo-gate: password request denied");
    finish(1);
  } catch {
    console.error("sudo-gate: invalid broker response");
    finish(1);
  }
});

client.on("error", (error) => {
  clearTimeout(timer);
  console.error("sudo-gate: broker connection failed: " + error.message);
  finish(1);
});
`,
		{ mode: 0o700 },
	);
	chmodSync(askpass, 0o700);

	writeFileSync(
		wrapper,
		`#!/usr/bin/env bash
set -euo pipefail
real="\${PI_SUDO_GATE_REAL_SUDO:-${realSudo}}"
args=()
for arg in "$@"; do
  case "$arg" in
    --stdin|--non-interactive)
      echo "sudo-gate: blocked sudo option: $arg" >&2
      exit 1
      ;;
    -[!-]*[Sn]*|-[!-]*[nS]*)
      echo "sudo-gate: blocked sudo option containing -S or -n: $arg" >&2
      exit 1
      ;;
    -A|--askpass)
      ;;
    *)
      args+=("$arg")
      ;;
  esac
done
exec "$real" -A "\${args[@]}"
`,
		{ mode: 0o700 },
	);
	chmodSync(wrapper, 0o700);

	writeFileSync(
		sudoeditWrapper,
		`#!/usr/bin/env bash
set -euo pipefail
real="\${PI_SUDO_GATE_REAL_SUDO:-${realSudo}}"
exec "$real" -A -e "$@"
`,
		{ mode: 0o700 },
	);
	chmodSync(sudoeditWrapper, 0o700);

	return { dir, askpass, wrapper, sudoeditWrapper, realSudo };
}

function commandMentionsSudo(command: string): boolean {
	return (
		/(^|[^\w./-])(?:sudo|sudoedit)(?=\s|$)/.test(command) ||
		/(^|\s)\/(?:usr\/bin|bin|usr\/local\/bin)\/sudo(?=\s|$)/.test(command)
	);
}

function unsafeSudoReason(command: string): string | undefined {
	if (/\bsudo(?:edit)?\b[^\n;&|]*?(?:\s-[^\s;&|]*[Sn][^\s;&|]*\b|\s--stdin\b|\s--non-interactive\b)/.test(command)) {
		return "sudo-gate: sudo stdin and non-interactive authentication options are blocked. Use normal sudo syntax and let the user decide the next step.";
	}
	if (/(^|[\s;&|])SUDO_ASKPASS\s*=/.test(command)) {
		return "sudo-gate: custom SUDO_ASKPASS is blocked. Use normal sudo syntax and let the user decide the next step.";
	}
	if (/\b(?:echo|printf|cat)\b[^\n;&|]*\|[^\n;&|]*\bsudo\b/.test(command)) {
		return "sudo-gate: piping data into sudo is blocked. Use normal sudo syntax and let the user decide the next step.";
	}
	return undefined;
}

function normalizeSudoCommand(command: string): string {
	return command.replace(/(^|[\s;&|])\/(?:usr\/bin|bin|usr\/local\/bin)\/sudo(?=\s|$)/g, "$1sudo");
}

function withSudoFunctions(command: string): string {
	return `sudo() { command "$PI_SUDO_GATE_REAL_SUDO" -A "$@"; }
sudoedit() { command "$PI_SUDO_GATE_REAL_SUDO" -A -e "$@"; }
${normalizeSudoCommand(command)}`;
}

function looksLikeSudoAuthFailure(text: string): boolean {
	return /sudo-gate:|Sorry, try again|incorrect password|authentication failure|no password was provided|a password is required|conversation failed/i.test(text);
}

function setStatus(
	ctx: { hasUI: boolean; ui: { setStatus(key: string, value: string | undefined): void; theme: { fg(name: string, text: string): string } } },
	state: SudoGateState,
	passwordCached: boolean,
): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus("sudo-gate", state.enabled ? ctx.ui.theme.fg("warning", `sudo-gate:on${passwordCached ? ":auth" : ""}`) : undefined);
}

async function askPassword(ctx: {
	ui: {
		custom<T>(factory: (tui: { requestRender(): void }, theme: { fg(name: string, text: string): string; bold(text: string): string }, keybindings: unknown, done: (value: T) => void) => unknown, options?: unknown): Promise<T>;
	};
}): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		let value = "";
		let cacheWidth = 0;
		let cache: string[] | undefined;

		function invalidate(): void {
			cache = undefined;
		}

		return {
			render(width: number): string[] {
				if (cache && cacheWidth === width) return cache;
				const bullets = "•".repeat(value.length);
				const input = bullets.length > 0 ? bullets : theme.fg("dim", "password stays in this Pi session only");
				cache = [
					truncateToWidth(theme.fg("accent", theme.bold("sudo-gate password")), width),
					truncateToWidth(theme.fg("muted", "Enter sudo password for this Pi session. Esc cancels."), width),
					truncateToWidth(`${theme.fg("accent", "> ")}${input}`, width),
					truncateToWidth(theme.fg("dim", "enter submit • esc cancel"), width),
				];
				cacheWidth = width;
				return cache;
			},
			handleInput(data: string): void {
				if (matchesKey(data, Key.enter) || data === "\n") {
					done(value.length > 0 ? value : undefined);
					return;
				}
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
					done(undefined);
					return;
				}
				if (matchesKey(data, Key.backspace) || data === "\x7f") {
					value = value.slice(0, -1);
					invalidate();
					tui.requestRender();
					return;
				}
				if (data.length === 1 && data >= " " && data !== "\x7f") {
					value += data;
					invalidate();
					tui.requestRender();
				}
			},
			invalidate,
		};
	}, { overlay: true });
}

export default function sudoGate(pi: ExtensionAPI): void {
	let state = { ...DEFAULT_STATE };
	let sudoPassword: string | undefined;
	let server: Server | undefined;
	let brokerSocketPath: string | undefined;
	const pendingTokens = new Map<string, PendingToken>();
	const metadataBashTool = createBashTool(process.cwd());

	function persist(): void {
		pi.appendEntry(STATE_KEY, { ...state });
	}

	function clearPassword(): void {
		sudoPassword = undefined;
		pendingTokens.clear();
	}

	function issueToken(): string {
		const token = randomBytes(24).toString("base64url");
		pendingTokens.set(token, { expiresAt: Date.now() + TOKEN_TTL_MS });
		return token;
	}

	function ensureBroker(): Promise<string> {
		if (server && brokerSocketPath) return Promise.resolve(brokerSocketPath);

		const path = socketPath();
		if (existsSync(path)) {
			try {
				unlinkSync(path);
			} catch {
				// If unlink fails, listen() below will report the real error.
			}
		}

		server = createServer((socket) => {
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString("utf8");
				if (!buffer.includes("\n")) return;

				const line = buffer.split("\n", 1)[0] || "{}";
				let token = "";
				try {
					const request = JSON.parse(line) as { token?: unknown };
					if (typeof request.token === "string") token = request.token;
				} catch {
					// handled below
				}

				const pending = pendingTokens.get(token);
				pendingTokens.delete(token);
				if (!pending || pending.expiresAt < Date.now()) {
					socket.end(JSON.stringify({ ok: false, error: "sudo-gate: password request expired or was not approved" }) + "\n");
					return;
				}
				if (!sudoPassword) {
					socket.end(JSON.stringify({ ok: false, error: "sudo-gate: no session password is available" }) + "\n");
					return;
				}
				socket.end(JSON.stringify({ ok: true, password: sudoPassword }) + "\n");
			});
		});

		return new Promise((resolve, reject) => {
			server?.once("error", reject);
			server?.listen(path, () => {
				brokerSocketPath = path;
				resolve(path);
			});
		});
	}

	pi.registerCommand("sudo-gate", {
		description: "Toggle, inspect, or forget sudo-gate session authentication",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "off" || arg === "disable") {
				state.enabled = false;
				clearPassword();
				persist();
				setStatus(ctx, state, Boolean(sudoPassword));
				ctx.ui.notify("sudo-gate disabled", "info");
				return;
			}
			if (arg === "on" || arg === "enable") {
				state.enabled = true;
				persist();
				setStatus(ctx, state, Boolean(sudoPassword));
				ctx.ui.notify("sudo-gate enabled", "info");
				return;
			}
			if (arg === "forget" || arg === "clear") {
				clearPassword();
				setStatus(ctx, state, Boolean(sudoPassword));
				ctx.ui.notify("sudo-gate forgot the session password", "info");
				return;
			}
			if (arg === "paths") {
				const files = ensureRuntimeFiles();
				const socket = await ensureBroker();
				ctx.ui.notify(`sudo-gate runtime:\naskpass: ${files.askpass}\nsudo wrapper: ${files.wrapper}\nsudoedit wrapper: ${files.sudoeditWrapper}\nsocket: ${socket}\nreal sudo: ${files.realSudo}`, "info");
				return;
			}
			ctx.ui.notify(`sudo-gate is ${state.enabled ? "enabled" : "disabled"}; session password is ${sudoPassword ? "cached" : "not set"}. Use /sudo-gate on|off|forget|paths.`, "info");
		},
	});

	pi.registerTool({
		...metadataBashTool,
		async execute(toolCallId, rawParams, signal, onUpdate, ctx) {
			const params = { ...rawParams };
			const command = typeof params.command === "string" ? params.command : "";

			if (!state.enabled || !commandMentionsSudo(command)) {
				const tool = createBashTool(ctx.cwd);
				return tool.execute(toolCallId, params, signal, onUpdate);
			}

			const unsafe = unsafeSudoReason(command);
			if (unsafe) {
				return { content: [{ type: "text", text: unsafe }], details: { blocked: true }, isError: true };
			}

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "sudo-gate: sudo requires interactive user approval in Pi." }],
					details: { blocked: true },
					isError: true,
				};
			}

			const ok = await ctx.ui.confirm("sudo-gate", `Allow this sudo command?\n\n${truncateCommand(command)}`);
			if (!ok) {
				return {
					content: [
						{
							type: "text",
							text: "sudo-gate: user denied this sudo command. Treat this as a user decision and choose a non-privileged next step or ask the user how to proceed.",
						},
					],
					details: { blocked: true, deniedByUser: true },
					isError: true,
				};
			}

			if (!sudoPassword) {
				sudoPassword = await askPassword(ctx);
				setStatus(ctx, state, Boolean(sudoPassword));
				if (!sudoPassword) {
					return {
						content: [
							{
								type: "text",
								text: "sudo-gate: user cancelled sudo authentication. Treat this as a user decision and choose a non-privileged next step or ask the user how to proceed.",
							},
						],
						details: { blocked: true, authenticationCancelled: true },
						isError: true,
					};
				}
			}

			const files = ensureRuntimeFiles();
			const socket = await ensureBroker();
			const token = issueToken();
			const tool = createBashTool(ctx.cwd, {
				spawnHook: ({ command, cwd, env }) => ({
					command: withSudoFunctions(command),
					cwd,
					env: {
						...env,
						SUDO_ASKPASS: files.askpass,
						SUDO_GATE_SOCKET: socket,
						SUDO_GATE_TOKEN: token,
						PI_SUDO_GATE_REAL_SUDO: files.realSudo,
						PATH: `${files.dir}:${env.PATH ?? process.env.PATH ?? ""}`,
					},
				}),
			});

			const result = await tool.execute(toolCallId, params, signal, onUpdate);
			const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
			if (looksLikeSudoAuthFailure(text)) {
				clearPassword();
				setStatus(ctx, state, false);
			}
			return result;
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		state = restoreState(ctx);
		setStatus(ctx, state, Boolean(sudoPassword));
		if (state.enabled) {
			ensureRuntimeFiles();
			await ensureBroker();
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		state = restoreState(ctx);
		setStatus(ctx, state, Boolean(sudoPassword));
	});

	pi.on("session_shutdown", async () => {
		clearPassword();
		if (server) {
			server.close();
			server = undefined;
		}
		if (brokerSocketPath && existsSync(brokerSocketPath)) {
			try {
				unlinkSync(brokerSocketPath);
			} catch {
				// Best effort cleanup.
			}
		}
		brokerSocketPath = undefined;
	});
}
