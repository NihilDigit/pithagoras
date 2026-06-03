import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ICON = {
	branch: "",
	clean: "",
	ahead: "",
	behind: "",
	staged: "",
	modified: "",
	untracked: "",
	conflicted: "",
} as const;

const DEFAULT_COMPACTION_RESERVE_TOKENS = 16384;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && cwd === home) return "~";
	if (home && cwd.startsWith(`${home}/`)) return `~/${cwd.slice(home.length + 1)}`;
	return cwd;
}

function abbreviateSegment(segment: string): string {
	if (segment.length <= 1) return segment;
	if (segment.startsWith(".") && segment.length > 2) return segment.slice(0, 2);
	return segment[0] ?? segment;
}

function fishPath(path: string, keepLast: number): string {
	const prefix = path === "~" ? "~" : path.startsWith("~/") ? "~/" : path.startsWith("/") ? "/" : "";
	const rest = prefix ? path.slice(prefix.length) : path;
	const parts = rest.split("/").filter(Boolean);
	if (parts.length <= keepLast) return path;
	return `${prefix}${parts
		.map((part, index) => (index < parts.length - keepLast ? abbreviateSegment(part) : part))
		.join("/")}`;
}

function keepRight(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;

	let suffix = text;
	while (suffix.length > 0 && visibleWidth(`…${suffix}`) > maxWidth) {
		suffix = suffix.slice(1);
	}
	return `…${suffix}`;
}

function compactPath(cwd: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";

	const full = formatCwd(cwd);
	if (visibleWidth(full) <= maxWidth) return full;

	const keepTwo = fishPath(full, 2);
	if (visibleWidth(keepTwo) <= maxWidth) return keepTwo;

	const keepOne = fishPath(full, 1);
	if (visibleWidth(keepOne) <= maxWidth) return keepOne;

	return keepRight(keepOne, maxWidth);
}

type GitStatusKind = "ahead" | "behind" | "conflicted" | "staged" | "modified" | "untracked";
type GitStatusPart = { kind: GitStatusKind; text: string };

function parseGitStatus(stdout: string): GitStatusPart[] | null {
	let ahead = 0;
	let behind = 0;
	let staged = 0;
	let modified = 0;
	let untracked = 0;
	let conflicted = 0;

	for (const line of stdout.split("\n")) {
		if (!line) continue;

		if (line.startsWith("## ")) {
			const match = line.match(/\[([^\]]+)\]/);
			if (match) {
				for (const part of match[1].split(",")) {
					const trimmed = part.trim();
					const aheadMatch = trimmed.match(/^ahead (\d+)$/);
					const behindMatch = trimmed.match(/^behind (\d+)$/);
					if (aheadMatch) ahead = Number(aheadMatch[1]);
					if (behindMatch) behind = Number(behindMatch[1]);
				}
			}
			continue;
		}

		const x = line[0];
		const y = line[1];
		if (x === "?" && y === "?") {
			untracked += 1;
			continue;
		}
		if (x === "!" && y === "!") continue;
		if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
			conflicted += 1;
			continue;
		}
		if (x && x !== " ") staged += 1;
		if (y && y !== " ") modified += 1;
	}

	return [
		ahead ? { kind: "ahead", text: `${ICON.ahead}${ahead}` } : undefined,
		behind ? { kind: "behind", text: `${ICON.behind}${behind}` } : undefined,
		conflicted ? { kind: "conflicted", text: `${ICON.conflicted}${conflicted}` } : undefined,
		staged ? { kind: "staged", text: `${ICON.staged}${staged}` } : undefined,
		modified ? { kind: "modified", text: `${ICON.modified}${modified}` } : undefined,
		untracked ? { kind: "untracked", text: `${ICON.untracked}${untracked}` } : undefined,
	].filter((part): part is GitStatusPart => Boolean(part));
}

function gitStatusRaw(parts: GitStatusPart[] | null): string {
	return parts && parts.length > 0 ? parts.map((part) => part.text).join(" ") : "";
}

function formatGitStatus(theme: any, parts: GitStatusPart[] | null): string {
	if (!parts || parts.length === 0) return "";
	return parts
		.map((part) => {
			switch (part.kind) {
				case "conflicted":
					return theme.fg("error", part.text);
				case "staged":
				case "ahead":
					return theme.fg("success", part.text);
				case "modified":
				case "behind":
					return theme.fg("warning", part.text);
				case "untracked":
					return theme.fg("dim", part.text);
			}
		})
		.join(" ");
}

function compactThresholdPercent(contextWindow: number): number {
	if (!contextWindow) return 90;
	return ((contextWindow - DEFAULT_COMPACTION_RESERVE_TOKENS) / contextWindow) * 100;
}

function row(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	if (!right) return truncateToWidth(left, width, "…");

	const minGap = 2;
	let l = left;
	let r = right;

	if (visibleWidth(l) + minGap + visibleWidth(r) > width) {
		const rightBudget = Math.max(0, Math.min(visibleWidth(r), Math.floor(width * 0.42)));
		const leftBudget = Math.max(0, width - minGap - rightBudget);
		l = truncateToWidth(l, leftBudget, "…");
	}

	if (visibleWidth(l) + minGap + visibleWidth(r) > width) {
		const rightBudget = Math.max(0, width - minGap - visibleWidth(l));
		r = truncateToWidth(r, rightBudget, "");
	}

	const gap = " ".repeat(Math.max(minGap, width - visibleWidth(l) - visibleWidth(r)));
	return l + gap + r;
}

export default function (pi: ExtensionAPI) {
	let activeTui: { requestRender(): void } | undefined;
	let currentModel: { provider: string; id: string; contextWindow?: number; reasoning?: boolean } | undefined;
	let gitStatus: GitStatusPart[] | null = null;
	let refreshGitStatus: (() => void) | undefined;

	pi.on("model_select", (event) => {
		currentModel = event.model;
		activeTui?.requestRender();
	});

	pi.on("thinking_level_select", () => {
		activeTui?.requestRender();
	});

	pi.on("tool_execution_end", () => {
		refreshGitStatus?.();
	});

	pi.on("user_bash", () => {
		refreshGitStatus?.();
	});

	pi.on("session_shutdown", () => {
		activeTui = undefined;
		refreshGitStatus = undefined;
		gitStatus = null;
	});

	pi.on("session_start", (_event, ctx) => {
		currentModel = ctx.model;
		gitStatus = null;

		let refreshTimer: ReturnType<typeof setTimeout> | undefined;
		refreshGitStatus = () => {
			if (refreshTimer) clearTimeout(refreshTimer);
			refreshTimer = setTimeout(async () => {
				const result = await pi
					.exec("git", ["status", "--porcelain=v1", "--branch"], { cwd: ctx.cwd })
					.catch(() => undefined);
				gitStatus = result?.stdout ? parseGitStatus(result.stdout) : null;
				activeTui?.requestRender();
			}, 80);
		};
		refreshGitStatus();

		ctx.ui.setFooter((tui, theme, footerData) => {
			activeTui = tui;
			const unsubscribeBranch = footerData.onBranchChange(() => {
				refreshGitStatus?.();
				tui.requestRender();
			});

			return {
				dispose() {
					unsubscribeBranch();
					if (refreshTimer) clearTimeout(refreshTimer);
					if (activeTui === tui) activeTui = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const usage = ctx.getContextUsage();
					const contextWindow = usage?.contextWindow ?? currentModel?.contextWindow ?? 0;
					const percent = usage?.percent;
					const contextRaw =
						percent === null || percent === undefined
							? `?/${formatTokens(contextWindow)}`
							: `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
					const compactionThreshold = compactThresholdPercent(contextWindow);
					const contextText =
						percent !== null && percent !== undefined && percent >= compactionThreshold
							? theme.fg("error", contextRaw)
							: percent !== null && percent !== undefined && percent >= compactionThreshold - 10
								? theme.fg("warning", contextRaw)
								: theme.fg("dim", contextRaw);

					const thinkingLevel = pi.getThinkingLevel();
					const thinkingText = thinkingLevel ? thinkingLevel[0].toUpperCase() : "";
					const modelText = currentModel ? `${currentModel.id}${currentModel.reasoning ? ` ${thinkingText}` : ""}` : "no model";
					const right = theme.fg("dim", modelText);

					const branch = footerData.getGitBranch();
					const branchRaw = branch ? `(${ICON.branch} ${branch})` : "";
					const statusRaw = gitStatusRaw(gitStatus);
					const suffixRaw = [branchRaw, statusRaw].filter(Boolean).join(" ");
					const fixedLeftWidth = visibleWidth("π  ") + visibleWidth(contextRaw) + visibleWidth(suffixRaw ? ` ${suffixRaw}` : "");
					const rightWidth = visibleWidth(modelText);
					const pathBudget = Math.max(0, width - fixedLeftWidth - rightWidth - 4);
					const path = compactPath(ctx.sessionManager.getCwd(), pathBudget);
					const branchText = branch ? theme.fg("dim", `(${ICON.branch} ${branch})`) : "";
					const statusText = formatGitStatus(theme, gitStatus);
					const suffix = [branchText, statusText].filter(Boolean).join(" ");
					const left = theme.fg("accent", "π") + " " + theme.fg("dim", path) + (suffix ? ` ${suffix}` : "") + "  " + contextText;

					return [row(left, right, width)];
				},
			};
		});
	});
}
