/**
 * Swarm Review — Bug & Vulnerability Hunter
 *
 * Spawns ~15 cheap flash/flash-lite models in parallel to scan code for
 * bugs and vulnerabilities. Uses consensus voting (≥80% threshold) to
 * filter false positives, then validates with a pro-model jury.
 *
 * Best for: security audits, bug hunting, vulnerability scanning.
 * NOT for: architectural decisions, deep reasoning, creative design.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
	ANSWER_END,
	combineSignals,
	getFinalOutput,
	HIVE_BUDGET_MS,
	mapWithConcurrencyLimit,
	NODE_TIMEOUT_MS,
	runModel,
} from "./hive-think.js";

import {
	aggregateFindings,
	type AggregatedFinding,
	type FileEntry,
	formatFindingLine,
	juryConfirm,
	type JuryVote,
	parseFindings,
	parseJuryVotes,
	partitionFiles,
	type RawFinding,
	type SwarmStats,
	voteFilter,
} from "./aggregation-engine.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SWARM_FLASH_MODELS = [
	// Free flash models from diverse providers for maximum scan diversity
	"cliproxy/sensenova-6.7-flash-lite",
	"cliproxy/sensenova-6.7-flash-lite",
	"cliproxy/sensenova-6.7-flash-lite",
	"cliproxy/sensenova-6.7-flash-lite",
	"cliproxy/sensenova-6.7-flash-lite",
	"cliproxy/deepseek-v4-flash",
	"cliproxy/deepseek-v4-flash",
	"cliproxy/deepseek-v4-flash",
	"cliproxy/deepseek-v4-flash",
	"cliproxy/deepseek-v4-flash",
	"ollama-cloud/minimax-m3",
	"ollama-cloud/minimax-m3",
	"ollama-cloud/minimax-m3",
	"google-aistudio/gemma-4-31b-it",
	"google-aistudio/gemma-4-31b-it",
];

const JURY_MODELS = [
	"deepseek/deepseek-v4-pro",
	"deepseek/deepseek-v4-pro",
	"deepseek/deepseek-v4-pro",
];

const MAX_CONCURRENCY = 4;
const JURY_CONCURRENCY = 3;
const MAX_CHARS_PER_MODEL = 180_000;
const BUCKET_SIZE = 5;
const VOTE_THRESHOLD = 0.8;
const MIN_JURY_UPVOTES = 2;

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

const SWARM_SCAN_PROMPT = `You are in SWARM REVIEW mode — parallel bug/vulnerability hunting.

You will receive source code files. Scan them for real bugs, vulnerabilities, and security issues.
Prioritize real vulnerabilities over style issues or minor code smells.

⚠️  CRITICAL — Output format:
Return ONLY a JSON array. No markdown, no explanation, no prose, no code blocks.
If you find nothing, return [].

Each finding MUST be:
{
  "file": "path/to/file.ext",
  "line": 142,
  "severity": "critical|high|medium|low",
  "type": "sql-injection|xss|null-pointer|race-condition|auth-bypass|path-traversal|...",
  "description": "1-2 sentences explaining the vulnerability and why it matters"
}

Severity guide:
- critical: immediate security breach, data loss, remote code execution
- high: serious vulnerability with clear exploit path
- medium: potential vulnerability, requires specific conditions
- low: defense-in-depth issue, best practice violation

Bug types to look for:
- SQL/NoSQL injection, XSS, CSRF, SSRF, path traversal
- Command injection, code injection, deserialization
- Authentication bypass, authorization flaws
- Race conditions, deadlocks, TOCTOU
- Null pointer dereference, undefined access
- Memory leaks, resource leaks, use-after-free
- Unsafe input handling, missing sanitization
- Hardcoded secrets, API keys, tokens
- Insecure cryptography, weak random generation
- Unsafe deserialization, prototype pollution
- Server-side template injection
- XML external entity injection
- Open redirect, insecure redirect

If you return prose or markdown instead of JSON, your output will be DISCARDED.
Only JSON. Only the array. Nothing else.

Return your output wrapped in <ANSWER>...</ANSWER> tags.`;

const JURY_PROMPT_BASE = `You are a senior security reviewer on a bug-hunting jury.
A swarm of cheaper models has flagged potential vulnerabilities.
Your job: review each finding and vote UP (confirmed) or DOWN (false positive).

⚠️  CRITICAL — Output format:
Return ONLY a JSON object with a "votes" array. No markdown, no prose.

{
  "votes": [
    {"fingerprint": "file:line:type", "verdict": "UP"},
    {"fingerprint": "file:line:type", "verdict": "DOWN"}
  ]
}

Guidelines:
- UP: this is a real bug/vulnerability that should be fixed
- DOWN: false positive, not exploitable, or already mitigated
- Be conservative — only UP if you're confident
- Do NOT report new findings — only vote on the listed ones
- You can read source files to verify (use read tool)

Return your output wrapped in <ANSWER>...</ANSWER> tags.`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSourceFiles(cwd: string, excludePatterns: string[]): FileEntry[] {
	const patterns = [
		"*.ts", "*.tsx", "*.js", "*.jsx", "*.py", "*.rs", "*.go",
		"*.java", "*.c", "*.cpp", "*.h", "*.hpp", "*.rb", "*.php",
		"*.swift", "*.kt", "*.scala", "*.cs", "*.sql", "*.sh", "*.bash",
		"*.yaml", "*.yml", "*.toml", "*.json", "*.tf", "*.hcl",
	];

	const exclude = new Set([
		"node_modules", ".git", "dist", "build", "target", "__pycache__",
		".next", ".nuxt", "vendor", ".venv", "venv", ".cache", "coverage",
		...excludePatterns,
	]);

	const files: FileEntry[] = [];

	function walk(dir: string, depth: number) {
		if (depth > 10) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!exclude.has(entry.name)) walk(full, depth + 1);
			} else if (entry.isFile()) {
				const ext = path.extname(entry.name);
				const name = entry.name;
				const matchPattern = (p: string) => {
					if (p.startsWith("*.")) return ext === p.slice(1);
					return name === p;
				};
				if (patterns.some(matchPattern)) {
					try {
						const stat = fs.statSync(full);
						files.push({ path: full, size: stat.size });
					} catch { /* skip unreadable */ }
				}
			}
		}
	}

	walk(cwd, 0);
	return files.sort((a, b) => b.size - a.size); // largest first for partition
}

function buildHistory(ctxMessages: any[]): string {
	let history = (ctxMessages ?? [])
		.map((m: any) => {
			const roleTag = m.role === "user" ? "[User]" : m.role === "assistant" ? "[Assistant]" : `[${m.role}]`;
			const textParts = (m.content ?? [])
				.filter((p: any) => p.type === "text")
				.map((p: any) => p.text)
				.join("\n");
			if (!textParts) return null;
			return `${roleTag}: ${textParts}`;
		})
		.filter(Boolean)
		.join("\n\n");

	const MAX_HISTORY_CHARS = 256_000;
	if (history.length > MAX_HISTORY_CHARS) {
		history = "... [earlier messages truncated]\n\n" + history.slice(history.length - MAX_HISTORY_CHARS);
	}
	return history;
}

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

export const SwarmReviewParams = Type.Object({
	targetDir: Type.Optional(
		Type.String({ description: "Directory to scan for bugs. Defaults to current working directory." }),
	),
	excludePatterns: Type.Optional(
		Type.Array(Type.String(), {
			description: "Additional directory/file patterns to exclude from scanning.",
		}),
	),
	minVoteThreshold: Type.Optional(
		Type.Number({
			default: 0.8,
			description: "Minimum fraction of models that must agree for a finding to pass the vote (0.0-1.0). Default 0.8 (80%).",
		}),
	),
	filePatterns: Type.Optional(
		Type.Array(Type.String(), {
			description: "Glob patterns to limit which files to scan (e.g., ['*.ts', '*.rs']). Overrides defaults.",
		}),
	),
});

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "swarm_review",
		label: "Swarm Review",
		description: [
			"SWARM REVIEW — parallel bug/vulnerability hunting with 15 cheap flash models.",
			"Spawns ~15 flash/flash-lite models (sensenova-6.7-flash-lite + deepseek-v4-flash) to scan code in parallel.",
			"Uses consensus voting (≥80%) to filter false positives.",
			"Validates passed findings with a pro-model jury (deepseek-v4-pro).",
			"Output: file:line:severity:type:description.",
			"Use for: security audits, bug hunting, vulnerability scanning.",
			"Do NOT use for: architecture decisions, deep reasoning, creative design — use hive_think instead.",
		].join(" "),
		parameters: SwarmReviewParams,
		promptSnippet: "Parallel bug/vulnerability hunting — 15 flash models + consensus voting + pro jury",
		promptGuidelines: [
			"Use swarm_review for security audits, bug hunting, and vulnerability scanning. Spawns 15 cheap flash models in parallel.",
			"swarm_review uses consensus voting (≥80%) to filter false positives, then validates with pro models.",
			"Do NOT use swarm_review for architecture decisions — use hive_think instead.",
			"swarm_review is read-only: it does not modify any code.",
		],

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const startTime = Date.now();
			const targetDir: string = (params.targetDir as string) || ctx.cwd;
			const excludePatterns: string[] = (params.excludePatterns as string[]) ?? [];
			const minVoteThreshold: number = (params.minVoteThreshold as number) ?? VOTE_THRESHOLD;
			const filePatterns: string[] | undefined = params.filePatterns as string[] | undefined;
			const history = buildHistory(ctx.messages ?? []);

			// -------------------------------------------------------------------
			// Phase 1: File inventory
			// -------------------------------------------------------------------
			onUpdate?.({
				content: [{ type: "text", text: "🪲 Swarm Review — Phase 1/5: scanning file tree..." }],
			});

			const allFiles = getSourceFiles(targetDir, excludePatterns);
			if (allFiles.length === 0) {
				return {
					content: [{ type: "text", text: "🪲 Swarm Review — no source files found to scan." }],
					details: { findings: [], stats: { filesScanned: 0, rawFindings: 0, passedVote: 0, juryApproved: 0, durationSeconds: 0 } },
				};
			}

			const totalChars = allFiles.reduce((s, f) => s + f.size, 0);
			const scanModels = SWARM_FLASH_MODELS;
			const partitions = partitionFiles(allFiles, scanModels.length, MAX_CHARS_PER_MODEL);

			// -------------------------------------------------------------------
			// Phase 2: Build file content strings per partition
			// -------------------------------------------------------------------
			onUpdate?.({
				content: [{ type: "text", text: `🪲 Swarm Review — Phase 2/5: partitioning ${allFiles.length} files (${(totalChars / 1024).toFixed(0)}KB) into ${partitions.length} groups...` }],
			});

			const partitionContents = partitions.map((files) => {
				let content = "";
				for (const f of files) {
					if (content.length > MAX_CHARS_PER_MODEL * 2) break; // safety cap
					try {
						const rel = path.relative(targetDir, f.path);
						const fileContent = fs.readFileSync(f.path, "utf-8");
						content += `\n// === FILE: ${rel} ===\n${fileContent}\n`;
					} catch { /* skip unreadable */ }
				}
				return content.slice(0, MAX_CHARS_PER_MODEL * 2);
			});

			// -------------------------------------------------------------------
			// Phase 3: Parallel scan
			// -------------------------------------------------------------------
			onUpdate?.({
				content: [{ type: "text", text: `🪲 Swarm Review — Phase 3/5: ${scanModels.length} flash models scanning...` }],
			});

			const swarms = await mapWithConcurrencyLimit(
				scanModels,
				MAX_CONCURRENCY,
				async (model, idx) => {
					const fileContent = partitionContents[idx] || partitionContents[0] || "";
					if (!fileContent.trim()) {
						return { model, findings: [] as RawFinding[], exitCode: 0, durationMs: 0, errorMessage: "" };
					}

					const question = `Scan the following source code for bugs and vulnerabilities. Report only findings in JSON array format.\n\n${fileContent}`;
					const result = await runModel(
						model, question, "", history, ctx.cwd, targetDir, signal, SWARM_SCAN_PROMPT,
					);

					const rawOutput = getFinalOutput(result.messages);
					const findings = parseFindings(rawOutput);

					if (findings.length === 0 && result.exitCode === 0) {
						// Model returned no findings — check if it returned prose
						if (rawOutput.length > 50 && !rawOutput.startsWith("[")) {
							return {
								model,
								findings: [] as RawFinding[],
								exitCode: 0,
								durationMs: result.durationMs,
								errorMessage: `No JSON parsed (${rawOutput.length} chars of prose returned)`,
							};
						}
					}

					return {
						model,
						findings,
						exitCode: result.exitCode,
						durationMs: result.durationMs,
						errorMessage: result.errorMessage || "",
					};
				},
			);

			const successCount = swarms.filter((s) => s.exitCode === 0).length;

			// -------------------------------------------------------------------
			// Phase 4: Aggregate & vote
			// -------------------------------------------------------------------
			onUpdate?.({
				content: [{ type: "text", text: "🪲 Swarm Review — Phase 4/5: aggregating & voting..." }],
			});

			const allRawFindings = swarms.map((s) => s.findings);
			const aggregated = aggregateFindings(allRawFindings, BUCKET_SIZE);
			const passed = voteFilter(aggregated, scanModels.length, minVoteThreshold);

			const totalRaw = allRawFindings.reduce((s, f) => s + f.length, 0);

			if (passed.length === 0) {
				const durationS = ((Date.now() - startTime) / 1000).toFixed(1);
				const stats: SwarmStats = {
					filesScanned: allFiles.length,
					totalChars,
					rawFindings: totalRaw,
					passedVote: 0,
					juryApproved: 0,
					durationSeconds: parseFloat(durationS),
					scanSuccessCount: successCount,
					scanTotalCount: scanModels.length,
				};
				return {
					content: [{
						type: "text",
						text: `🪲 Swarm Review — No findings passed vote threshold.\n\n${totalRaw} raw findings from ${successCount}/${scanModels.length} models across ${allFiles.length} files. No bugs met the ${Math.round(minVoteThreshold * 100)}% consensus threshold.\n\n💡 Tips: lower threshold, narrow file scope, or use hive_think for deeper analysis.`,
					}],
					details: { findings: [], stats },
				};
			}

			// -------------------------------------------------------------------
			// Phase 5: Pro jury
			// -------------------------------------------------------------------
			onUpdate?.({
				content: [{ type: "text", text: `🪲 Swarm Review — Phase 5/5: ${JURY_MODELS.length} pro jury models voting on ${passed.length} findings...` }],
			});

			const passedFindingsJSON = JSON.stringify(
				passed.map((a) => ({
					fingerprint: a.finding.fingerprint,
					file: a.finding.file,
					line: a.finding.line,
					severity: a.finding.severity,
					type: a.finding.type,
					description: a.finding.description,
					voteCount: a.voteCount,
				})),
				null,
				2,
			);

			const juryResults = await mapWithConcurrencyLimit(
				JURY_MODELS,
				JURY_CONCURRENCY,
				async (model) => {
					const juryPrompt = `${JURY_PROMPT_BASE}\n\n## Findings to Review\n\n${passedFindingsJSON}\n\nVote UP or DOWN on each finding.`;
					const result = await runModel(
						model,
						`Review these ${passed.length} potential bugs and vote UP (confirmed) or DOWN (false positive) on each`,
						"",
						"",
						ctx.cwd,
						targetDir,
						signal,
						juryPrompt,
					);

					const rawOutput = getFinalOutput(result.messages);
					return {
						model,
						votes: parseJuryVotes(rawOutput),
						exitCode: result.exitCode,
						durationMs: result.durationMs,
					};
				},
			);

			const allJuryVotes: JuryVote[][] = juryResults
				.filter((j) => j.exitCode === 0)
				.map((j) => j.votes);

			const jurySuccessCount = juryResults.filter((j) => j.exitCode === 0).length;

			// Apply jury verdict
			const finalFindings: { aggregated: AggregatedFinding; upVotes: number; totalVotes: number }[] = [];
			for (const a of passed) {
				const { confirmed, upVotes, totalVotes } = juryConfirm(
					a.finding.fingerprint!,
					allJuryVotes,
					MIN_JURY_UPVOTES,
				);
				if (confirmed) {
					finalFindings.push({ aggregated: a, upVotes, totalVotes });
				}
			}

			// -------------------------------------------------------------------
			// Output
			// -------------------------------------------------------------------
			const durationS = ((Date.now() - startTime) / 1000).toFixed(1);
			const stats: SwarmStats = {
				filesScanned: allFiles.length,
				totalChars,
				rawFindings: totalRaw,
				passedVote: passed.length,
				juryApproved: finalFindings.length,
				durationSeconds: parseFloat(durationS),
				scanSuccessCount: successCount,
				scanTotalCount: scanModels.length,
			};

			const lines: string[] = [];

			// Critical & High first
			const critical = finalFindings.filter((f) => f.aggregated.finding.severity === "critical");
			const high = finalFindings.filter((f) => f.aggregated.finding.severity === "high");
			const medium = finalFindings.filter((f) => f.aggregated.finding.severity === "medium");
			const low = finalFindings.filter((f) => f.aggregated.finding.severity === "low");

			if (critical.length > 0) {
				lines.push("## 🔴 CRITICAL");
				for (const f of critical) {
					lines.push(formatFindingLine(f.aggregated, true, f.upVotes, f.totalVotes));
				}
				lines.push("");
			}
			if (high.length > 0) {
				lines.push("## 🟠 HIGH");
				for (const f of high) {
					lines.push(formatFindingLine(f.aggregated, true, f.upVotes, f.totalVotes));
				}
				lines.push("");
			}
			if (medium.length > 0) {
				lines.push("## 🟡 MEDIUM");
				for (const f of medium) {
					lines.push(formatFindingLine(f.aggregated, true, f.upVotes, f.totalVotes));
				}
				lines.push("");
			}
			if (low.length > 0) {
				lines.push("## ⚪ LOW");
				for (const f of low) {
					lines.push(formatFindingLine(f.aggregated, true, f.upVotes, f.totalVotes));
				}
				lines.push("");
			}

			lines.push("---");
			lines.push(`**Stats**: ${stats.filesScanned} files · ${stats.totalChars.toLocaleString()} chars · ${stats.rawFindings} raw findings · ${stats.passedVote} passed vote · **${stats.juryApproved} jury-approved** · ${stats.durationSeconds}s`);
			lines.push(`**Coverage**: ${stats.scanSuccessCount}/${stats.scanTotalCount} scan models · ${jurySuccessCount}/${JURY_MODELS.length} jury models`);

			const output = `🪲 Swarm Review — ${stats.juryApproved} bugs found\n\n${lines.join("\n")}`;

			const detailsFindings = finalFindings.map((f) => ({
				file: f.aggregated.finding.file,
				line: f.aggregated.finding.line,
				severity: f.aggregated.finding.severity,
				type: f.aggregated.finding.type,
				description: f.aggregated.finding.description,
				fingerprint: f.aggregated.finding.fingerprint,
				voteCount: f.aggregated.voteCount,
				juryUpVotes: f.upVotes,
				juryTotalVotes: f.totalVotes,
			}));

			return {
				content: [{ type: "text", text: output }],
				details: { findings: detailsFindings, stats },
			};
		},

		renderCall(args, theme, _context) {
			const dir = (args.targetDir as string) || ".";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("swarm_review "))}${theme.fg("accent", "🪲 15 flash + jury")}${theme.fg("muted", " [80% consensus]")}\n  ${theme.fg("dim", dir)}`,
				0, 0,
			);
		},

		renderResult(result, { expanded }, theme, _context) {
			const text = result.content[0];
			const body = text?.type === "text" ? text.text : "(no output)";

			if (!expanded) {
				const firstLine = body.split("\n")[0] || body;
				return new Text(
					`${theme.fg("success", "✓")} ${theme.fg("accent", firstLine)}\n${theme.fg("muted", "(Ctrl+O to expand)")}`,
					0, 0,
				);
			}

			const mdTheme = getMarkdownTheme();
			return new Markdown(body, 0, 0, mdTheme);
		},
	});
}
