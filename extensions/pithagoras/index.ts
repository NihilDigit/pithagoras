import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "pithagoras-stance";

type Stance = "frame" | "probe" | "groundup";
type GroundUpSubstate = "slice" | "clarification" | "paused";

interface PithagorasState {
	stance: Stance | undefined;
	groundup: {
		slice: number;
		substate: GroundUpSubstate;
		checkMode: "light" | "normal" | "strict";
	};
}

interface SliceBudget {
	editCalls: number;
	writeCalls: number;
	bashCalls: number;
	touchedFiles: Set<string>;
}

const DEFAULT_STATE: PithagorasState = {
	stance: undefined,
	groundup: {
		slice: 0,
		substate: "paused",
		checkMode: "normal",
	},
};

const MAX_GROUNDUP_ASSISTANT_CHARS = 1800;
const MAX_GROUNDUP_EDIT_CALLS = 1;
const MAX_GROUNDUP_WRITE_CALLS = 1;
const MAX_GROUNDUP_BASH_CALLS = 2;
const MAX_GROUNDUP_FILES = 1;
const MAX_GROUNDUP_EDIT_BLOCKS = 2;
const MAX_GROUNDUP_WRITE_BYTES = 3000;

function cloneState(state: PithagorasState): PithagorasState {
	return {
		stance: state.stance,
		groundup: { ...state.groundup },
	};
}

function stanceLabel(stance: Stance | undefined): string {
	if (stance === "frame") return "Framing";
	if (stance === "probe") return "Probe";
	if (stance === "groundup") return "GroundUp";
	return "off";
}

function textOfAssistant(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	const assistant = message as AssistantMessage;
	if (!Array.isArray(assistant.content)) return "";
	return assistant.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
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
			stance: data.stance,
			groundup: {
				slice: data.groundup?.slice ?? state.groundup.slice,
				substate: data.groundup?.substate ?? state.groundup.substate,
				checkMode: data.groundup?.checkMode ?? state.groundup.checkMode,
			},
		};
	}
	return state;
}

function setStatus(ctx: ExtensionContext, state: PithagorasState): void {
	if (!state.stance) {
		ctx.ui.setStatus("pithagoras", undefined);
		return;
	}

	const label = stanceLabel(state.stance);
	const suffix = state.stance === "groundup" ? ` · slice ${state.groundup.slice} · ${state.groundup.substate}` : "";
	ctx.ui.setStatus("pithagoras", ctx.ui.theme.fg("accent", `pithagoras:${label}${suffix}`));
}

function framePrompt(): string {
	return `Pithagoras stance: Framing.

Use this stance when the user's idea is still informal.
Your job is to turn the idea into a real, checkable engineering problem.
Use your own knowledge, web resources, GitHub projects, papers, existing tools, and analogous domains to check whether the idea already exists, is partially solved, or is isomorphic to a known problem.
Prefer reuse, adaptation, and borrowing from adjacent work over invention from scratch.

Work conversationally over several calibration rounds. Preserve the user's rough language before introducing technical terms. Offer tentative framings, invite correction, and keep the problem falsifiable.

When the framing has stabilized, write or update docs/framing.md as the first durable artifact. It should capture the original intuition, similar or existing work, the engineering problem, acceptance criteria, and probe questions. Keep it useful, not ceremonial.`;
}

function probePrompt(): string {
	return `Pithagoras stance: Probe.

Use this stance after a framing exists.
Your job is to test whether the framed engineering problem and the architecture in your head survive contact with reality.
Use docs, source code, runtime behavior, experiments, spikes, comparable projects, and the user's domain knowledge.

Move quickly, but make each external action legible. Before reading, searching, running code, or writing a spike, briefly say what you are trying to verify and why this action is cheap useful evidence.
After each action, update what became more likely, less likely, or still unknown.

Probe may write code, scripts, tests, or instrumentation. Treat those changes as evidence-gathering unless the user explicitly moves to implementation.
When the architecture has stabilized, write or update docs/probe.md with the evidence that mattered, rejected routes, the architecture that survived, and the GroundUp starting point.`;
}

function groundUpPrompt(state: PithagorasState): string {
	return `Pithagoras stance: GroundUp.

GroundUp runs as a small while loop. The goal is to finish the implementation through a path the user can follow.
Start from a spherical-cow version: the simplest useful fiction that makes the core mechanism visible.

Current slice: ${state.groundup.slice}.

For each assistant turn:
- absorb exactly one real constraint into the implementation;
- start by naming the simplifying assumption for this turn;
- make the smallest code change that demonstrates or handles that assumption;
- explain the small change in plain language;
- end by naming the next wall this version will hit, then stop.

Advanced structure should appear only when the previous simple version has met a concrete constraint that requires it.
If the next change would be large, split it and do only the first slice.
The extension will ask the user whether to continue or ask a question. Do not continue to the next slice in the same response.`;
}

function touchedPath(toolName: string, input: Record<string, unknown>): string | undefined {
	if ((toolName === "edit" || toolName === "write" || toolName === "read") && typeof input.path === "string") {
		return input.path;
	}
	return undefined;
}

function consumeGroundUpBudget(event: { toolName: string; input: Record<string, unknown> }, budget: SliceBudget) {
	const path = touchedPath(event.toolName, event.input);
	if (path) budget.touchedFiles.add(path);

	if (budget.touchedFiles.size > MAX_GROUNDUP_FILES && (event.toolName === "edit" || event.toolName === "write")) {
		return "GroundUp slice is too large: touch only one implementation file in this slice.";
	}

	if (event.toolName === "edit") {
		budget.editCalls += 1;
		if (budget.editCalls > MAX_GROUNDUP_EDIT_CALLS) {
			return "GroundUp slice is too large: use at most one edit call, then stop and explain the slice.";
		}
		const edits = event.input.edits;
		if (Array.isArray(edits) && edits.length > MAX_GROUNDUP_EDIT_BLOCKS) {
			return `GroundUp slice is too large: use at most ${MAX_GROUNDUP_EDIT_BLOCKS} edit blocks in one slice.`;
		}
	}

	if (event.toolName === "write") {
		budget.writeCalls += 1;
		if (budget.writeCalls > MAX_GROUNDUP_WRITE_CALLS) {
			return "GroundUp slice is too large: use at most one write call, then stop and explain the slice.";
		}
		const content = event.input.content;
		if (typeof content === "string" && content.length > MAX_GROUNDUP_WRITE_BYTES) {
			return `GroundUp slice is too large: write content is ${content.length} bytes; keep this slice under ${MAX_GROUNDUP_WRITE_BYTES} bytes.`;
		}
	}

	if (event.toolName === "bash") {
		budget.bashCalls += 1;
		if (budget.bashCalls > MAX_GROUNDUP_BASH_CALLS) {
			return `GroundUp slice is too large: use at most ${MAX_GROUNDUP_BASH_CALLS} bash commands before stopping for the checkpoint.`;
		}
	}

	return undefined;
}

export default function pithagoras(pi: ExtensionAPI): void {
	let state = cloneState(DEFAULT_STATE);
	let budget: SliceBudget = { editCalls: 0, writeCalls: 0, bashCalls: 0, touchedFiles: new Set() };
	let suppressNextCheckpoint = false;

	function setStance(stance: Stance | undefined, ctx: ExtensionContext): void {
		state.stance = stance;
		if (stance === "groundup") {
			state.groundup.substate = "slice";
			if (state.groundup.slice === 0) state.groundup.slice = 1;
		} else {
			state.groundup.substate = "paused";
		}
		persist(pi, state);
		setStatus(ctx, state);
	}

	pi.registerCommand("frame", {
		description: "Enter Pithagoras Framing stance",
		handler: async (args, ctx) => {
			setStance("frame", ctx);
			ctx.ui.notify("Pithagoras: Framing stance", "info");
			if (args.trim()) await pi.sendUserMessage(args.trim());
		},
	});

	pi.registerCommand("probe", {
		description: "Enter Pithagoras Probe stance",
		handler: async (args, ctx) => {
			setStance("probe", ctx);
			ctx.ui.notify("Pithagoras: Probe stance", "info");
			if (args.trim()) await pi.sendUserMessage(args.trim());
		},
	});

	pi.registerCommand("groundup", {
		description: "Enter Pithagoras GroundUp stance",
		handler: async (args, ctx) => {
			setStance("groundup", ctx);
			ctx.ui.notify("Pithagoras: GroundUp stance", "info");
			if (args.trim()) await pi.sendUserMessage(args.trim());
		},
	});

	pi.registerCommand("pithagoras", {
		description: "Show or clear Pithagoras stance",
		handler: async (args, ctx) => {
			const value = args.trim();
			if (value === "off" || value === "clear") {
				setStance(undefined, ctx);
				ctx.ui.notify("Pithagoras stance cleared", "info");
				return;
			}
			ctx.ui.notify(`Pithagoras stance: ${stanceLabel(state.stance)}`, "info");
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
		budget = { editCalls: 0, writeCalls: 0, bashCalls: 0, touchedFiles: new Set() };
		if (!state.stance) return;

		const stancePrompt =
			state.stance === "frame" ? framePrompt() : state.stance === "probe" ? probePrompt() : groundUpPrompt(state);
		return { systemPrompt: `${event.systemPrompt}\n\n${stancePrompt}` };
	});

	pi.on("tool_call", async (event) => {
		if (state.stance !== "groundup") return;
		const reason = consumeGroundUpBudget(
			{ toolName: event.toolName, input: event.input as Record<string, unknown> },
			budget,
		);
		if (reason) return { block: true, reason };
	});

	pi.on("agent_end", async (event, ctx) => {
		setStatus(ctx, state);
		if (state.stance !== "groundup" || !ctx.hasUI) {
			return;
		}

		const skipLengthCheck = suppressNextCheckpoint;
		suppressNextCheckpoint = false;
		const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
		const assistantText = lastAssistant ? textOfAssistant(lastAssistant) : "";
		if (!skipLengthCheck && assistantText.length > MAX_GROUNDUP_ASSISTANT_CHARS) {
			suppressNextCheckpoint = true;
			await pi.sendUserMessage(
				"上一轮 GroundUp 步长太大。请只压缩解释，不推进实现：说明这一小步的简化假设、改动、学到的机制、下一堵墙。",
			);
			return;
		}

		state.groundup.substate = "paused";
		persist(pi, state);
		setStatus(ctx, state);

		const question = await ctx.ui.input("GroundUp checkpoint", "按 Enter 继续；有问题就输入问题；Esc 暂停");
		if (question === undefined) return;

		const trimmed = question.trim();
		if (trimmed.length === 0) {
			state.groundup.slice += 1;
			state.groundup.substate = "slice";
			persist(pi, state);
			setStatus(ctx, state);
			await pi.sendUserMessage("继续 GroundUp：只推进下一小步，只吸收一个现实约束。", {
				deliverAs: "followUp",
			});
			return;
		}

		state.groundup.substate = "clarification";
		persist(pi, state);
		setStatus(ctx, state);
		await pi.sendUserMessage(
			`先回答这个关于上一小步的问题，不推进实现。回答完后回到 GroundUp checkpoint：\n\n${trimmed}`,
			{ deliverAs: "followUp" },
		);
	});
}
