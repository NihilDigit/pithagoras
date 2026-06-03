import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isAbsolute, normalize, relative } from "node:path";

const CUSTOM_TYPE = "pithagoras-stance";

type Stance = "frame" | "probe" | "groundup";
type GroundUpSubstate = "slice" | "clarification" | "paused";

interface PithagorasState {
	stance: Stance | undefined;
	block: number;
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
	block: 0,
	groundup: {
		slice: 0,
		substate: "paused",
		checkMode: "normal",
	},
};

const PITHAGORAS_DIR = ".pithagoras";
const MAX_ASSISTANT_CHARS = 2000;
const MAX_GROUNDUP_ASSISTANT_CHARS = 1800;
const MAX_GROUNDUP_EDIT_CALLS = 1;
const MAX_GROUNDUP_WRITE_CALLS = 1;
const MAX_GROUNDUP_BASH_CALLS = 2;
const MAX_GROUNDUP_FILES = 1;
const MAX_GROUNDUP_EDIT_BLOCKS = 2;
const MAX_GROUNDUP_WRITE_BYTES = 3000;
const MAX_FRAME_EDIT_BLOCKS = 1;
const MAX_FRAME_WRITE_BYTES = 2000;
const MAX_FRAME_BASH_CALLS = 2;
const MAX_PROBE_EDIT_BLOCKS = 2;
const MAX_PROBE_WRITE_BYTES = 5000;
const MAX_PROBE_BASH_CALLS = 4;

function cloneState(state: PithagorasState): PithagorasState {
	return {
		stance: state.stance,
		block: state.block,
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
			block: data.block ?? state.block,
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
	const suffix = state.stance === "groundup" ? ` · slice ${state.groundup.slice} · ${state.groundup.substate}` : ` · block ${state.block}`;
	ctx.ui.setStatus("pithagoras", ctx.ui.theme.fg("accent", `pithagoras:${label}${suffix}`));
}

function corePrinciplePrompt(): string {
	return `Pithagoras core principle.

Work from the user's current mental model. First build a rough model the user can inspect, then add real-world constraints one at a time.
Every concept, document block, experiment, code structure, and abstraction must come from a visible decision point or constraint.

Move in small building blocks. Do not produce complete documents, complete architectures, or complete implementations in one pass.
Keep written artifacts progressive: one stable block at a time, with unknowns left visible.
Follow the user's language for normal replies and written artifacts. Keep code comments in English.
A successful session leaves the user able to explain why each part of the final solution exists.`;
}

function framePrompt(): string {
	return `Pithagoras stance: Framing.

Use this stance when the user's idea is still informal.
Your job is to help the user and agent arrive at a shared, checkable framing of the work.

Start by understanding the user's current mental model: what they know, what they vaguely recognize, what assumptions they are making, and what knowledge gaps would block them from judging the framing.
Use diagnostic questions when needed. Questions should reveal how the user thinks about the system, not merely collect requirements.
If a knowledge gap blocks participation, teach the missing concept in the context of the user's problem before continuing.

Use your own knowledge, light web research, GitHub projects, papers, existing tools, and analogous domains to check whether the idea already exists, is partially solved, or is isomorphic to a known problem.
Prefer reuse, adaptation, and borrowing from adjacent work over invention from scratch.

Written Framing work belongs in ${PITHAGORAS_DIR}/framing.md. Treat it as a shared whiteboard for small building blocks, not as a final document.
Do not write docs/framing.md or other project docs during Framing. Add or revise only the small block that has just stabilized in conversation.`;
}

function probePrompt(): string {
	return `Pithagoras stance: Probe.

Use this stance after a framing exists.
Your job is to test whether the framed engineering problem and the architecture in your head survive contact with reality.
Use docs, source code, runtime behavior, experiments, spikes, comparable projects, and the user's domain knowledge.

Probe one hypothesis or experiment per assistant turn. Before reading, searching, running code, or writing a spike, briefly say what you are trying to verify and why this action is cheap useful evidence.
After the action, explain what became more likely, less likely, contradicted, or still unknown. Do not roll multiple experiments into one turn.

Written Probe work belongs in ${PITHAGORAS_DIR}/probe.md or ${PITHAGORAS_DIR}/experiments/.
Do not write docs/probe.md or implementation files during Probe. Probe artifacts are evidence-gathering building blocks unless the user explicitly moves to GroundUp.`;
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

function relativeToolPath(path: string, cwd: string): string {
	const cleaned = path.replace(/^@/, "");
	const normalized = normalize(cleaned);
	const rel = isAbsolute(normalized) ? relative(cwd, normalized) : normalized;
	return normalize(rel).replace(/\\/g, "/").replace(/^\.\//, "");
}

function isPithagorasPath(path: string, cwd: string): boolean {
	const rel = relativeToolPath(path, cwd);
	return rel === PITHAGORAS_DIR || rel.startsWith(`${PITHAGORAS_DIR}/`);
}

function countEditBlocks(input: Record<string, unknown>): number {
	const edits = input.edits;
	return Array.isArray(edits) ? edits.length : 0;
}

function writeBytes(input: Record<string, unknown>): number {
	const content = input.content;
	return typeof content === "string" ? content.length : 0;
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
		if (countEditBlocks(event.input) > MAX_GROUNDUP_EDIT_BLOCKS) {
			return `GroundUp slice is too large: use at most ${MAX_GROUNDUP_EDIT_BLOCKS} edit blocks in one slice.`;
		}
	}

	if (event.toolName === "write") {
		budget.writeCalls += 1;
		if (budget.writeCalls > MAX_GROUNDUP_WRITE_CALLS) {
			return "GroundUp slice is too large: use at most one write call, then stop and explain the slice.";
		}
		const bytes = writeBytes(event.input);
		if (bytes > MAX_GROUNDUP_WRITE_BYTES) {
			return `GroundUp slice is too large: write content is ${bytes} bytes; keep this slice under ${MAX_GROUNDUP_WRITE_BYTES} bytes.`;
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

function consumePithagorasWorkspaceBudget(
	stance: "frame" | "probe",
	event: { toolName: string; input: Record<string, unknown> },
	budget: SliceBudget,
	cwd: string,
) {
	const path = touchedPath(event.toolName, event.input);
	const isWriteTool = event.toolName === "edit" || event.toolName === "write";
	if (path && isWriteTool) {
		if (!isPithagorasPath(path, cwd)) {
			return `${stanceLabel(stance)} writes must stay under ${PITHAGORAS_DIR}/. GroundUp is the stance for implementation files.`;
		}
		budget.touchedFiles.add(relativeToolPath(path, cwd));
	}

	if (isWriteTool && budget.touchedFiles.size > 1) {
		return `${stanceLabel(stance)} can write only one ${PITHAGORAS_DIR}/ file in this building block.`;
	}

	if (event.toolName === "edit") {
		budget.editCalls += 1;
		if (budget.editCalls > 1) return `${stanceLabel(stance)} can use at most one edit call in this building block.`;
		const maxBlocks = stance === "frame" ? MAX_FRAME_EDIT_BLOCKS : MAX_PROBE_EDIT_BLOCKS;
		if (countEditBlocks(event.input) > maxBlocks) {
			return `${stanceLabel(stance)} edit is too large: use at most ${maxBlocks} edit block(s).`;
		}
	}

	if (event.toolName === "write") {
		budget.writeCalls += 1;
		if (budget.writeCalls > 1) return `${stanceLabel(stance)} can use at most one write call in this building block.`;
		const maxBytes = stance === "frame" ? MAX_FRAME_WRITE_BYTES : MAX_PROBE_WRITE_BYTES;
		const bytes = writeBytes(event.input);
		if (bytes > maxBytes) {
			return `${stanceLabel(stance)} write is too large: ${bytes} bytes; keep this building block under ${maxBytes} bytes.`;
		}
	}

	if (event.toolName === "bash") {
		budget.bashCalls += 1;
		const maxBash = stance === "frame" ? MAX_FRAME_BASH_CALLS : MAX_PROBE_BASH_CALLS;
		if (budget.bashCalls > maxBash) {
			return `${stanceLabel(stance)} can use at most ${maxBash} bash commands before stopping to explain the block.`;
		}
	}

	return undefined;
}

function consumeStanceBudget(
	state: PithagorasState,
	event: { toolName: string; input: Record<string, unknown> },
	budget: SliceBudget,
	cwd: string,
) {
	if (state.stance === "groundup") return consumeGroundUpBudget(event, budget);
	if (state.stance === "frame" || state.stance === "probe") {
		return consumePithagorasWorkspaceBudget(state.stance, event, budget, cwd);
	}
	return undefined;
}

export default function pithagoras(pi: ExtensionAPI): void {
	let state = cloneState(DEFAULT_STATE);
	let budget: SliceBudget = { editCalls: 0, writeCalls: 0, bashCalls: 0, touchedFiles: new Set() };
	let suppressNextCheckpoint = false;

	function setStance(stance: Stance | undefined, ctx: ExtensionContext): void {
		state.stance = stance;
		if (stance && state.block === 0) state.block = 1;
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
		return { systemPrompt: `${event.systemPrompt}\n\n${corePrinciplePrompt()}\n\n${stancePrompt}` };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!state.stance) return;
		const reason = consumeStanceBudget(
			state,
			{ toolName: event.toolName, input: event.input as Record<string, unknown> },
			budget,
			ctx.cwd,
		);
		if (reason) return { block: true, reason };
	});

	pi.on("agent_end", async (event, ctx) => {
		setStatus(ctx, state);
		if (!state.stance || !ctx.hasUI) {
			return;
		}

		const skipLengthCheck = suppressNextCheckpoint;
		suppressNextCheckpoint = false;
		const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
		const assistantText = lastAssistant ? textOfAssistant(lastAssistant) : "";
		const maxChars = state.stance === "groundup" ? MAX_GROUNDUP_ASSISTANT_CHARS : MAX_ASSISTANT_CHARS;
		if (!skipLengthCheck && assistantText.length > maxChars) {
			suppressNextCheckpoint = true;
			await pi.sendUserMessage(
				`The previous ${stanceLabel(state.stance)} block was too large. Do not advance to the next block. Compress the explanation only: name the rough model, the real-world constraint, the produced block, and the next decision point.`,
			);
			return;
		}

		state.groundup.substate = "paused";
		persist(pi, state);
		setStatus(ctx, state);

		const question = await ctx.ui.input(`${stanceLabel(state.stance)} checkpoint`, "Press Enter to continue one small block; type a question to clarify; Esc to pause");
		if (question === undefined) return;

		const trimmed = question.trim();
		if (trimmed.length === 0) {
			state.block += 1;
			if (state.stance === "groundup") {
				state.groundup.slice += 1;
				state.groundup.substate = "slice";
			}
			persist(pi, state);
			setStatus(ctx, state);
			await pi.sendUserMessage(`Continue ${stanceLabel(state.stance)}. Advance only the next small building block, and add only one real-world constraint or decision point.`, {
				deliverAs: "followUp",
			});
			return;
		}

		if (state.stance === "groundup") state.groundup.substate = "clarification";
		persist(pi, state);
		setStatus(ctx, state);
		await pi.sendUserMessage(
			`Answer this question about the previous building block first. Do not advance to the next block. After answering, return to the ${stanceLabel(state.stance)} checkpoint:\n\n${trimmed}`,
			{ deliverAs: "followUp" },
		);
	});
}
