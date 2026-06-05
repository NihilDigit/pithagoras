import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isAbsolute, normalize, relative } from "node:path";
import { Type } from "typebox";

const CUSTOM_TYPE = "pithagoras-lab";

type Role = "off" | "pi" | "ta";
type TaKind = "explain" | "explore" | "probe" | "build";

interface DispatchPayload {
	kind: TaKind;
	task: string;
	whyThisMatters?: string;
	userBaseline?: string;
	teachingAngle?: string;
	allowedWork?: string;
	returnWhen?: string;
	notes?: string;
	dispatchMarkdown?: string;
}

interface PithagorasState {
	role: Role;
	parentSession?: string;
	taKind?: TaKind;
	dispatch?: string;
}

interface TurnBudget {
	toolCalls: number;
	readCalls: number;
	readBytes: number;
	bashCalls: number;
	editCalls: number;
	writeCalls: number;
	touchedWriteFiles: Set<string>;
}

const DEFAULT_STATE: PithagorasState = { role: "off" };

const PI_READ_FILES_PER_TURN = 1;
const PI_READ_BYTES_PER_TURN = 8000;

const TA_TOOL_CALLS_PER_TURN = 10;
const TA_READ_FILES_PER_TURN = 4;
const TA_READ_BYTES_PER_TURN = 24000;
const TA_BASH_CALLS_PER_TURN = 4;
const TA_EDIT_CALLS_PER_TURN = 3;
const TA_WRITE_CALLS_PER_TURN = 2;
const TA_WRITE_FILES_PER_TURN = 2;
const TA_EDIT_BLOCKS_PER_CALL = 6;
const TA_WRITE_BYTES_PER_CALL = 8000;

function cloneState(state: PithagorasState): PithagorasState {
	return { ...state };
}

function emptyBudget(): TurnBudget {
	return {
		toolCalls: 0,
		readCalls: 0,
		readBytes: 0,
		bashCalls: 0,
		editCalls: 0,
		writeCalls: 0,
		touchedWriteFiles: new Set(),
	};
}

function roleLabel(role: Role): string {
	if (role === "pi") return "PI";
	if (role === "ta") return "TA";
	return "off";
}

function encodePayload(value: unknown): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodePayload<T>(encoded: string): T {
	return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T;
}

function persist(pi: ExtensionAPI, state: PithagorasState): void {
	pi.appendEntry(CUSTOM_TYPE, cloneState(state));
}

function restoreState(ctx: ExtensionContext): PithagorasState {
	let state = cloneState(DEFAULT_STATE);
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
		const data = entry.data as Partial<PithagorasState> | undefined;
		if (!data) continue;
		state = {
			role: data.role ?? state.role,
			parentSession: data.parentSession,
			taKind: data.taKind,
			dispatch: data.dispatch,
		};
	}
	return state;
}

function dispatchTitle(payload: DispatchPayload): string {
	const shortTask = payload.task.replace(/\s+/g, " ").trim().slice(0, 80);
	return `TA · ${payload.kind} · ${shortTask || "task"}`;
}

function formatDispatch(payload: DispatchPayload): string {
	if (payload.dispatchMarkdown?.trim()) return payload.dispatchMarkdown.trim();

	const lines = [
		`TA kind: ${payload.kind}`,
		"",
		"Task:",
		payload.task.trim(),
	];
	if (payload.whyThisMatters?.trim()) lines.push("", "Why this matters:", payload.whyThisMatters.trim());
	if (payload.userBaseline?.trim()) lines.push("", "User baseline:", payload.userBaseline.trim());
	if (payload.teachingAngle?.trim()) lines.push("", "Teaching angle:", payload.teachingAngle.trim());
	if (payload.allowedWork?.trim()) lines.push("", "Allowed work:", payload.allowedWork.trim());
	if (payload.returnWhen?.trim()) lines.push("", "Return when:", payload.returnWhen.trim());
	if (payload.notes?.trim()) lines.push("", "Notes:", payload.notes.trim());
	lines.push("", "Handback should include:", "- what was completed", "- what the user was guided through or contributed", "- what project/code reality was established", "- any fallback chosen or attempted", "- what remains unresolved", "- what the PI should decide next");
	return lines.join("\n");
}

function defaultHandback(state: PithagorasState): string {
	return [
		"TA handback",
		"",
		"Completed:",
		"- ",
		"",
		"User was guided through or contributed:",
		"- ",
		"",
		"Project/code reality established:",
		"- ",
		"",
		"Fallbacks chosen or attempted:",
		"- ",
		"",
		"Still unresolved:",
		"- ",
		"",
		"Recommended PI decision:",
		"- ",
		"",
		state.dispatch ? `Original PI dispatch:\n\n${state.dispatch}` : undefined,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function setStatus(ctx: ExtensionContext, state: PithagorasState): void {
	if (state.role === "off") {
		ctx.ui.setStatus("pithagoras", undefined);
		ctx.ui.setWidget("pithagoras", undefined);
		return;
	}

	if (state.role === "pi") {
		ctx.ui.setStatus("pithagoras", ctx.ui.theme.fg("accent", "pithagoras:PI"));
		ctx.ui.setWidget("pithagoras", [
			"Pithagoras PI",
			"main session · read-limited · dispatch TA sessions for real work",
		]);
		return;
	}

	ctx.ui.setStatus("pithagoras", ctx.ui.theme.fg("accent", `pithagoras:TA${state.taKind ? `:${state.taKind}` : ""}`));
	ctx.ui.setWidget("pithagoras", [
		`Pithagoras TA${state.taKind ? ` · ${state.taKind}` : ""}`,
		"work with the user · small steps · return to PI when done or blocked",
	]);
}

function piPrompt(): string {
	return `Pithagoras PI session.

You are the PI in the main Pithagoras session.
Treat every real task as a teaching case. The user's understanding comes first, while the real work still moves forward through well-chosen TA sessions.

Your job:
- understand what the user is trying to accomplish;
- establish a light sense of what the user currently understands;
- choose the next useful teaching-sized task;
- dispatch one TA session to guide the user through that task;
- integrate the TA handback into the main direction.

You do not carry out implementation work yourself. You do not deep-read code paths yourself. You do not run experiments yourself. You do not edit code.
You may use at most one limited read in a turn to orient yourself. If more code reality, experiments, implementation, or extended explanation are needed, use spawn_ta.

A good TA dispatch contains:
- the real task to complete;
- why this task matters in the larger work;
- what the user likely understands already;
- what this task can teach the user;
- what kind of work is allowed;
- when the TA should return;
- what the TA should hand back.

After a TA returns, connect the result back to the user's larger goal: what got done, what the user should now understand better, what changed in project reality, and what next TA session or PI framing is useful.

Keep the main session clean. Your role is direction, framing, and teaching strategy.`;
}

function taPrompt(state: PithagorasState): string {
	const dispatch = state.dispatch?.trim() ? `\n\nPI dispatch for this TA session:\n\n${state.dispatch.trim()}` : "";
	return `Pithagoras TA session.

You are a TA working directly with the user on a real task assigned by the PI.
Complete the assigned task with the user. Do not work as a background agent, and do not treat the user as a passive student.

User understanding is the first priority. Treat the time budget as effectively unlimited: do not rush past confusion to finish faster. If the user has a question, doubt, or sign of confusion, address it before advancing the task.

The user may know project goals, product context, history, constraints, preferences, and non-code facts that are not in the PI handoff or the repository. Treat the user as a collaborator whose context can change how the task should be done.

Use explanation, code reading, commands, experiments, or implementation as needed. Keep the work bounded by the PI handoff. Move in small steps; if you are blocked by a Pithagoras budget, stop using tools and bring the user back into the loop.

If the assigned task cannot be completed as given, work with the user on a reasonable fallback: narrow the task, try a cheaper experiment, identify missing information, implement a reversible partial step, or return to the PI with a clear explanation. Do not hide failure.

When finished or blocked, use return_to_pi or /pith-return to hand back:
- what was completed;
- what the user was guided through or contributed;
- what project/code reality was established;
- what fallback was chosen or attempted, if any;
- what remains unresolved;
- what the PI should decide next.${dispatch}`;
}

function touchedPath(toolName: string, input: Record<string, unknown>): string | undefined {
	if ((toolName === "edit" || toolName === "write" || toolName === "read") && typeof input.path === "string") {
		return input.path;
	}
	return undefined;
}

function relativeToolPath(path: string, cwd: string): string {
	const cleaned = path.replace(/^@/, "");
	const normalized = normalize(cleaned);
	const rel = isAbsolute(normalized) ? relative(cwd, normalized) : normalized;
	return normalize(rel).replace(/\\/g, "/").replace(/^\.\//, "");
}

function countEditBlocks(input: Record<string, unknown>): number {
	const edits = input.edits;
	return Array.isArray(edits) ? edits.length : 0;
}

function writeBytes(input: Record<string, unknown>): number {
	const content = input.content;
	return typeof content === "string" ? Buffer.byteLength(content, "utf8") : 0;
}

function blockForSmallSteps(role: "PI" | "TA", detail: string): string {
	if (role === "PI") {
		return `${detail}\n\nPithagoras PI keeps the main session clean. Stop reading and dispatch a focused TA session if more project reality is needed.`;
	}
	return `${detail}\n\nPithagoras TA needs smaller steps. Stop using tools, explain the current state to the user, and ask whether to continue with another small step, slow down, or return to PI.`;
}

function consumePiBudget(event: { toolName: string; input: Record<string, unknown> }, budget: TurnBudget): string | undefined {
	if (event.toolName === "spawn_ta") return undefined;
	if (event.toolName !== "read") {
		return blockForSmallSteps("PI", `Pithagoras PI is read-only and can only use read or spawn_ta. Blocked tool: ${event.toolName}.`);
	}

	if (budget.readCalls + 1 > PI_READ_FILES_PER_TURN) {
		return blockForSmallSteps("PI", `Pithagoras PI can read at most ${PI_READ_FILES_PER_TURN} file per turn.`);
	}
	budget.readCalls += 1;
	return undefined;
}

function consumeTaBudget(
	event: { toolName: string; input: Record<string, unknown> },
	budget: TurnBudget,
	cwd: string,
): string | undefined {
	if (event.toolName === "return_to_pi") return undefined;
	if (event.toolName === "spawn_ta") {
		return blockForSmallSteps("TA", "A TA session cannot spawn another TA session. Return to PI if this task needs splitting.");
	}

	if (budget.toolCalls + 1 > TA_TOOL_CALLS_PER_TURN) {
		return blockForSmallSteps("TA", `Pithagoras TA used too many tool calls in this turn. Limit: ${TA_TOOL_CALLS_PER_TURN}.`);
	}
	budget.toolCalls += 1;

	if (event.toolName === "read") {
		if (budget.readBytes >= TA_READ_BYTES_PER_TURN) {
			return blockForSmallSteps("TA", `Pithagoras TA read budget is already exhausted for this turn. Limit: ${TA_READ_BYTES_PER_TURN} bytes.`);
		}
		if (budget.readCalls + 1 > TA_READ_FILES_PER_TURN) {
			return blockForSmallSteps("TA", `Pithagoras TA can read at most ${TA_READ_FILES_PER_TURN} files before syncing with the user.`);
		}
		budget.readCalls += 1;
	}

	if (event.toolName === "bash") {
		if (budget.bashCalls + 1 > TA_BASH_CALLS_PER_TURN) {
			return blockForSmallSteps("TA", `Pithagoras TA can run at most ${TA_BASH_CALLS_PER_TURN} bash commands before syncing with the user.`);
		}
		budget.bashCalls += 1;
	}

	if (event.toolName === "edit") {
		if (budget.editCalls + 1 > TA_EDIT_CALLS_PER_TURN) {
			return blockForSmallSteps("TA", `Pithagoras TA can use at most ${TA_EDIT_CALLS_PER_TURN} edit calls in one step.`);
		}
		if (countEditBlocks(event.input) > TA_EDIT_BLOCKS_PER_CALL) {
			return blockForSmallSteps("TA", `This edit is too large: use at most ${TA_EDIT_BLOCKS_PER_CALL} edit blocks before syncing with the user.`);
		}
		budget.editCalls += 1;
	}

	if (event.toolName === "write") {
		if (budget.writeCalls + 1 > TA_WRITE_CALLS_PER_TURN) {
			return blockForSmallSteps("TA", `Pithagoras TA can use at most ${TA_WRITE_CALLS_PER_TURN} write calls in one step.`);
		}
		const bytes = writeBytes(event.input);
		if (bytes > TA_WRITE_BYTES_PER_CALL) {
			return blockForSmallSteps("TA", `This write is too large: ${bytes} bytes. Keep one step under ${TA_WRITE_BYTES_PER_CALL} bytes.`);
		}
		budget.writeCalls += 1;
	}

	if (event.toolName === "edit" || event.toolName === "write") {
		const path = touchedPath(event.toolName, event.input);
		if (path) budget.touchedWriteFiles.add(relativeToolPath(path, cwd));
		if (budget.touchedWriteFiles.size > TA_WRITE_FILES_PER_TURN) {
			return blockForSmallSteps("TA", `Pithagoras TA can write at most ${TA_WRITE_FILES_PER_TURN} files before syncing with the user.`);
		}
	}

	return undefined;
}

function takeUtf8(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let result = "";
	let used = 0;
	for (const char of text) {
		const bytes = Buffer.byteLength(char, "utf8");
		if (used + bytes > maxBytes) break;
		result += char;
		used += bytes;
	}
	return result;
}

function truncateReadResult(
	content: Array<{ type: string; text?: string }>,
	budget: TurnBudget,
	maxBytes: number,
	message: string,
): Array<{ type: string; text?: string }> | undefined {
	let changed = false;
	const next = content.map((item) => {
		if (item.type !== "text" || typeof item.text !== "string") return item;
		const bytes = Buffer.byteLength(item.text, "utf8");
		const remaining = Math.max(0, maxBytes - budget.readBytes);
		if (bytes <= remaining) {
			budget.readBytes += bytes;
			return item;
		}
		changed = true;
		const kept = takeUtf8(item.text, remaining);
		budget.readBytes = maxBytes;
		return {
			...item,
			text: `${kept}\n\n[${message} Read output was truncated at ${maxBytes} bytes. Stop reading and sync with the user before continuing.]`,
		};
	});
	return changed ? next : undefined;
}

export default function pithagoras(pi: ExtensionAPI): void {
	let state = cloneState(DEFAULT_STATE);
	let budget = emptyBudget();

	function setRole(next: PithagorasState, ctx: ExtensionContext): void {
		state = cloneState(next);
		persist(pi, state);
		setStatus(ctx, state);
	}

	pi.registerTool({
		name: "spawn_ta",
		label: "Spawn TA",
		description: "In Pithagoras PI mode, dispatch a focused HITL TA session for explanation, exploration, probing, or building.",
		promptSnippet: "Dispatch a focused Pithagoras TA session for real work instead of doing it in the PI session",
		promptGuidelines: [
			"Use spawn_ta in Pithagoras PI mode whenever explanation, code exploration, experiments, or implementation are needed.",
		],
		parameters: Type.Object({
			kind: StringEnum(["explain", "explore", "probe", "build"] as const),
			task: Type.String({ description: "One concrete real task for the TA to complete with the user" }),
			whyThisMatters: Type.Optional(Type.String({ description: "Why this task matters for the user's larger goal" })),
			userBaseline: Type.Optional(Type.String({ description: "What the user likely understands already" })),
			teachingAngle: Type.Optional(Type.String({ description: "What this task can teach through the work" })),
			allowedWork: Type.Optional(Type.String({ description: "What the TA may do: explain, read, run experiments, implement, etc." })),
			returnWhen: Type.Optional(Type.String({ description: "When the TA should return to PI" })),
			notes: Type.Optional(Type.String({ description: "Any extra constraints or context for the TA" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (state.role !== "pi") {
				return {
					content: [{ type: "text", text: "spawn_ta is only available in Pithagoras PI mode. Run /pithagoras first." }],
					details: { blocked: true },
				};
			}
			const payload: DispatchPayload = params;
			await pi.sendUserMessage(`/pith-spawn ${encodePayload(payload)}`, { deliverAs: "followUp" });
			return {
				content: [{ type: "text", text: "Queued TA dispatch confirmation. The user will review it before the session switch." }],
				details: { payload },
			};
		},
	});

	pi.registerTool({
		name: "return_to_pi",
		label: "Return to PI",
		description: "In a Pithagoras TA session, return a handback to the parent PI session after user confirmation.",
		promptSnippet: "Return the completed TA work and handback to the parent Pithagoras PI session",
		promptGuidelines: ["Use return_to_pi when a Pithagoras TA task is complete, blocked, or needs PI reframing."],
		parameters: Type.Object({
			handback: Type.String({ description: "Short handback for the PI" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (state.role !== "ta") {
				return {
					content: [{ type: "text", text: "return_to_pi is only available in a Pithagoras TA session." }],
					details: { blocked: true },
				};
			}
			await pi.sendUserMessage(`/pith-return ${encodePayload({ handback: params.handback })}`, { deliverAs: "followUp" });
			return {
				content: [{ type: "text", text: "Queued PI handback confirmation. The user will review it before returning." }],
				details: { handback: params.handback },
			};
		},
	});

	pi.registerCommand("pithagoras", {
		description: "Enter Pithagoras PI+TA mode, show status, or turn it off",
		handler: async (args, ctx) => {
			const value = args.trim();
			if (value === "off" || value === "clear" || value === "disable") {
				setRole({ role: "off" }, ctx);
				ctx.ui.notify("Pithagoras mode cleared", "info");
				return;
			}
			if (value === "status") {
				ctx.ui.notify(`Pithagoras role: ${roleLabel(state.role)}`, "info");
				return;
			}
			setRole({ role: "pi" }, ctx);
			ctx.ui.notify("Pithagoras PI+TA mode enabled", "info");
			if (value) await pi.sendUserMessage(value);
		},
	});

	pi.registerCommand("pith-spawn", {
		description: "Internal Pithagoras command: confirm and create a TA session",
		handler: async (args, ctx) => {
			let payload: DispatchPayload;
			try {
				payload = decodePayload<DispatchPayload>(args.trim());
			} catch (error) {
				ctx.ui.notify(`Invalid TA dispatch payload: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			const initialDispatch = formatDispatch(payload);
			const editedDispatch = ctx.hasUI
				? await ctx.ui.editor("Confirm TA dispatch", initialDispatch)
				: initialDispatch;
			if (editedDispatch === undefined) {
				ctx.ui.notify("TA dispatch cancelled", "info");
				return;
			}

			const currentSessionFile = ctx.sessionManager.getSessionFile();
			if (!currentSessionFile) {
				ctx.ui.notify("Pithagoras TA sessions require a saved parent session", "error");
				return;
			}
			const taPayload: DispatchPayload = { ...payload, dispatchMarkdown: editedDispatch };
			const result = await ctx.newSession({
				parentSession: currentSessionFile,
				withSession: async (replacementCtx) => {
					replacementCtx.ui.notify("Starting Pithagoras TA session", "info");
					await replacementCtx.sendUserMessage(`/pith-ta-init ${encodePayload(taPayload)}`);
				},
			});
			if (result.cancelled) ctx.ui.notify("TA session creation cancelled", "info");
		},
	});

	pi.registerCommand("pith-ta-init", {
		description: "Internal Pithagoras command: initialize the current session as a TA session",
		handler: async (args, ctx) => {
			let payload: DispatchPayload;
			try {
				payload = decodePayload<DispatchPayload>(args.trim());
			} catch (error) {
				ctx.ui.notify(`Invalid TA init payload: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			const parentSession = ctx.sessionManager.getHeader().parentSession;
			const dispatch = formatDispatch(payload);
			setRole({ role: "ta", parentSession, taKind: payload.kind, dispatch }, ctx);
			pi.setSessionName(dispatchTitle(payload));
			await pi.sendUserMessage(
				`You are now in a Pithagoras TA session. Work with the user on the PI dispatch below.\n\n${dispatch}\n\nStart by orienting the user to this task and then proceed in small collaborative steps.`,
			);
		},
	});

	pi.registerCommand("pith-return", {
		description: "Return the current Pithagoras TA session to its PI session",
		handler: async (args, ctx) => {
			if (state.role !== "ta") {
				ctx.ui.notify("/pith-return can only be used from a Pithagoras TA session", "warning");
				return;
			}
			const encoded = args.trim();
			let initial = defaultHandback(state);
			if (encoded) {
				try {
					const payload = decodePayload<{ handback?: string }>(encoded);
					if (payload.handback?.trim()) initial = payload.handback.trim();
				} catch {
					initial = encoded;
				}
			}

			const handback = ctx.hasUI ? await ctx.ui.editor("Confirm handback to PI", initial) : initial;
			if (handback === undefined) {
				ctx.ui.notify("Return to PI cancelled", "info");
				return;
			}
			const parentSession = state.parentSession;
			if (!parentSession) {
				ctx.ui.notify("This TA session has no parent PI session recorded", "error");
				return;
			}

			const result = await ctx.switchSession(parentSession, {
				withSession: async (replacementCtx) => {
					replacementCtx.ui.notify("Returned to Pithagoras PI session", "info");
					await replacementCtx.sendUserMessage(
						`TA handback received. Integrate it into the PI session and decide the next teaching-sized step.\n\n${handback.trim()}`,
					);
				},
			});
			if (result.cancelled) ctx.ui.notify("Switch back to PI cancelled", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		state = restoreState(ctx);
		setStatus(ctx, state);
	});

	pi.on("session_tree", async (_event, ctx) => {
		state = restoreState(ctx);
		setStatus(ctx, state);
	});

	pi.on("before_agent_start", async (event) => {
		budget = emptyBudget();
		if (state.role === "pi") return { systemPrompt: `${event.systemPrompt}\n\n${piPrompt()}` };
		if (state.role === "ta") return { systemPrompt: `${event.systemPrompt}\n\n${taPrompt(state)}` };
		return undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (state.role === "off") return;
		const input = event.input as Record<string, unknown>;
		const reason =
			state.role === "pi"
				? consumePiBudget({ toolName: event.toolName, input }, budget)
				: consumeTaBudget({ toolName: event.toolName, input }, budget, ctx.cwd);
		if (reason) return { block: true, reason };
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName !== "read" || state.role === "off") return;
		const content = event.content as Array<{ type: string; text?: string }>;
		const maxBytes = state.role === "pi" ? PI_READ_BYTES_PER_TURN : TA_READ_BYTES_PER_TURN;
		const message = state.role === "pi" ? "Pithagoras PI read budget exceeded." : "Pithagoras TA read budget exceeded.";
		const truncated = truncateReadResult(content, budget, maxBytes, message);
		if (truncated) return { content: truncated as any };
		return undefined;
	});

	pi.on("agent_end", async (_event, ctx) => {
		setStatus(ctx, state);
	});
}
