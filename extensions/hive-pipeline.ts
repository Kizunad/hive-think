/**
 * Hive Think — the pipeline
 *
 * One dynamic thinking workflow, run identically by the synchronous and the
 * background paths:
 *
 *   0  解剖    dissect the question to first-principles, verifiable claims
 *   1  归并    collapse restatements into one candidate list (merge only)
 *   2  投票    every node votes on that same list
 *   3  解法    solutions for the problems that passed
 *   4  投票    every node votes on the solutions
 *
 * Two structural choices are worth knowing before reading the code.
 *
 * Consensus does the arbitrating, so no node holds a privileged role and the
 * model roster needs no strong/fast tiers. Earlier designs designated one node as
 * arbiter, which silently downgraded the whole result when that slot drew a weak
 * model.
 *
 * The fan-out is decided *after* stage 0, from what decomposition actually found.
 * Asking the caller for a node count up front would only ever get a guess.
 */

import type { HiveConfig, ThinkingLevel } from "./hive-config.js";
import {
	type Ballot,
	decideNodeCount,
	drawNodes,
	formatVoteLine,
	independentSolutions,
	type MergedProposition,
	mergePropositions,
	type MutexOutcome,
	type NodeDecision,
	parseBallots,
	parsePropositions,
	parseSolutions,
	type Proposition,
	type Solution,
	tallyBallots,
	tallyMutexGroups,
	type VoteTally,
} from "./aggregation-engine.js";
import { aggregateUsage, getFinalOutput, type ModelResult, runNode } from "./hive-runner.js";
import { extractAnswer, formatUsageStats, mapWithConcurrencyLimit } from "./hive-util.js";

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

export const STAGES = {
	dissect: "解剖 dissect",
	merge: "归并 merge",
	voteProblems: "投票 vote-problems",
	solve: "解法 solve",
	voteSolutions: "投票 vote-solutions",
} as const;

export type StageName = (typeof STAGES)[keyof typeof STAGES];

/** Voting and merging are cheap bookkeeping passes, not deliberation. */
const CHEAP_THINKING: ThinkingLevel = "low";

// ---------------------------------------------------------------------------
// Shared prompt preamble
// ---------------------------------------------------------------------------

const NO_WRITE = `You have read-only tools (read, grep, find, ls) and bash for verification.
⚠️  DO NOT modify anything. No write, no edit. Read and test only.`;

const ANSWER_CONTRACT = `## Output contract

Emit ONLY the JSON described below, wrapped in <ANSWER></ANSWER> tags. No prose
before or after it, no explanation of the JSON. The tags let the orchestrator stop
your process the moment you are done, so nothing you write after them is read.`;

// ---------------------------------------------------------------------------
// Stage prompts
// ---------------------------------------------------------------------------

const DISSECT_PROMPT = `You are one node in a hive performing FIRST-PRINCIPLES DECOMPOSITION.

${NO_WRITE}

Your only job is to take the question apart until you reach claims that can be
checked. You are NOT solving anything yet, and you are NOT giving opinions.

## Rules

1. **Verifiable leaves.** Every proposition must be ONE claim checkable against
   code, config, data, or a command's output. "The design is bad" is not a claim.
   "handleAuth() re-reads the token file on every request (src/auth.ts:88)" is.
2. **At most 3 levels.** Level 1 is the problem as posed; level 3 is irreducible.
   Stop there — deeper is not better, and nodes stopping at different depths makes
   the results impossible to compare.
3. **Investigate, don't imagine.** Read the actual code, grep for the real call
   sites, run tests. A proposition with no evidence field is nearly worthless.
4. **Question the premise.** If the problem as posed is not the real problem, that
   itself is a proposition — say so plainly.
5. **3 to 8 propositions.** Fewer and sharper beats more and vaguer.

## Slugs

Give each proposition a short kebab-case slug naming the thing itself
(\`token-file-reread\`, not \`problem-1\`). Other nodes are decomposing the same
question independently; a slug that describes the substance lets identical
findings be recognised as identical.

${ANSWER_CONTRACT}

<ANSWER>
[
  {"slug":"token-file-reread","statement":"handleAuth() re-reads /etc/token on every request instead of caching it","evidence":"src/auth.ts:88","level":3},
  {"slug":"no-auth-test-coverage","statement":"No test exercises the expired-token path","evidence":"grep -r expired test/ returns nothing","level":2}
]
</ANSWER>`;

const MERGE_PROMPT = `You are the MERGE step of a hive. You are NOT judging anything.

${NO_WRITE}

Several nodes decomposed the same question independently. Some of their
propositions describe one underlying problem in different words. Your only job is
to produce a single list in which restatements are collapsed.

## Rules

1. **No opinions.** Never drop a proposition because you think it is wrong,
   unimportant, or unlikely. Judging happens in the next stage, by vote. Dropping
   something here removes it from the vote entirely, which is a decision you are
   not authorised to make.
2. **Never invent.** Every entry in your output must trace to a proposition some
   node actually raised.
3. **Collapse only true restatements.** Two propositions merge only if acting on
   one would be acting on the other. Related-but-distinct stays distinct.
4. **When collapsing:** keep the most specific statement, keep the slug of the
   entry you kept, and union the evidence from the merged entries.

${ANSWER_CONTRACT}

<ANSWER>
[
  {"slug":"token-file-reread","statement":"...","evidence":"src/auth.ts:88; also seen at src/mw.ts:12","level":3}
]
</ANSWER>`;

const VOTE_PROBLEMS_PROMPT = `You are one voter in a hive. Vote on whether each proposition below is a REAL
and MATERIAL problem for the question at hand.

${NO_WRITE}

## How to vote

- \`yes\` — the claim holds up and you would act on it.
- \`no\` — it is factually wrong, immaterial to the question, or unsupported.

Where a claim is cheap to check, check it: read the cited file, run the cited
command. A vote backed by a two-second grep beats a vote backed by a hunch.

Vote on **every** item, using its exact slug. Omitting an item counts as an
abstention and weakens the tally rather than helping your preferred outcome. Keep
each reason to one sentence.

${ANSWER_CONTRACT}

<ANSWER>
[
  {"slug":"token-file-reread","vote":"yes","reason":"Confirmed at src/auth.ts:88, no cache in the path"},
  {"slug":"no-auth-test-coverage","vote":"no","reason":"test/auth.test.ts:40 already covers expiry"}
]
</ANSWER>`;

const SOLVE_PROMPT = `You are one node in a hive proposing SOLUTIONS to problems the hive has already
confirmed by vote.

${NO_WRITE}

## Rules

1. **Concrete enough to implement.** Name the files, the functions, the shape of
   the change. "Improve error handling" is not a solution.
2. **Mark alternatives.** Two solutions that cannot both be adopted must share the
   same \`mutexGroup\` string (e.g. \`storage-choice\`). Independent improvements
   that can all ship together must have NO \`mutexGroup\`.
   This matters: alternatives are decided by relative majority, while independent
   items each face a threshold. Mislabelling an alternative as independent can get
   two contradictory changes both approved.
3. **Say what it addresses.** \`addresses\` lists the proposition slugs the
   solution actually resolves.
4. **Investigate first.** Verify your solution is possible in this codebase before
   proposing it.

${ANSWER_CONTRACT}

<ANSWER>
[
  {"slug":"cache-token-in-memory","addresses":["token-file-reread"],"summary":"Read /etc/token once into a module-level cache in src/auth.ts, invalidate on SIGHUP","mutexGroup":"token-strategy"},
  {"slug":"mmap-token-file","addresses":["token-file-reread"],"summary":"mmap the token file so the kernel caches it","mutexGroup":"token-strategy"},
  {"slug":"add-expiry-test","addresses":["no-auth-test-coverage"],"summary":"Add test/auth.expiry.test.ts covering the expired-token branch"}
]
</ANSWER>`;

const VOTE_SOLUTIONS_PROMPT = `You are one voter in a hive. Vote on whether each proposed solution should be
adopted.

${NO_WRITE}

## How to vote

- **Independent solutions** (no mutex group): \`yes\` if it should ship, \`no\` if
  it should not. These are judged separately, so several can pass together.
- **Mutex groups** (alternatives): vote \`yes\` on **at most one** option in each
  group — the one you would actually pick — and \`no\` on the rest. The group is
  decided by relative majority, so spreading \`yes\` votes across a group's options
  makes the group unresolvable.

Verify feasibility where it is cheap to do so. One sentence of reasoning each.
Vote on every item, using its exact slug.

${ANSWER_CONTRACT}

<ANSWER>
[
  {"slug":"cache-token-in-memory","vote":"yes","reason":"Simplest fix, SIGHUP handler already exists at src/main.ts:31"},
  {"slug":"mmap-token-file","vote":"no","reason":"Adds platform-specific code for no measurable gain at this file size"},
  {"slug":"add-expiry-test","vote":"yes","reason":"Trivial and closes a real gap"}
]
</ANSWER>`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineInput {
	question: string;
	context: string;
	history: string;
	cwd: string;
	config: HiveConfig;
	signal?: AbortSignal;
	/** Optional caller-supplied cap on the fan-out, clamped to the config bounds. */
	maxNodes?: number;
	onProgress?: (progress: PipelineProgress) => void;
}

export interface PipelineProgress {
	stage: StageName;
	done: number;
	total: number;
	results: ModelResult[];
}

export interface PipelineOutcome {
	question: string;
	/** The configured roster the nodes were drawn from. */
	roster: string[];
	nodes: number;
	nodeDecision?: NodeDecision;
	thresholdPct: number;
	stagesRun: StageName[];
	/** Set when the pipeline stopped early; explains why in caller-facing terms. */
	haltedAt?: StageName;
	haltReason?: string;
	candidates: MergedProposition[];
	problemTallies: Map<string, VoteTally>;
	confirmedProblems: MergedProposition[];
	solutions: Solution[];
	solutionTallies: Map<string, VoteTally>;
	mutexOutcomes: MutexOutcome[];
	adoptedSolutions: Solution[];
	/** Every node from every stage, in run order. */
	results: ModelResult[];
	durationMs: number;
}

// ---------------------------------------------------------------------------
// Task payload assembly
// ---------------------------------------------------------------------------

function buildTask(parts: Array<[string, string]>): string {
	return parts
		.filter(([, body]) => body?.trim())
		.map(([heading, body]) => `## ${heading}\n\n${body.trim()}`)
		.join("\n\n");
}

function renderCandidateList(items: Array<{ slug: string; text: string; group?: string }>): string {
	return items
		.map((item, i) => {
			const group = item.group ? `  [alternatives: ${item.group}]` : "";
			return `${i + 1}. \`${item.slug}\`${group}\n   ${item.text}`;
		})
		.join("\n");
}

function describePropositions(items: Proposition[]): string {
	return items
		.map((p) => {
			const evidence = p.evidence ? `\n   evidence: ${p.evidence}` : "";
			return `- \`${p.slug}\` (level ${p.level})\n   ${p.statement}${evidence}`;
		})
		.join("\n");
}

// ---------------------------------------------------------------------------
// Stage execution
// ---------------------------------------------------------------------------

interface StageRun {
	stage: StageName;
	models: string[];
	systemPrompt: string;
	task: string;
	thinking: ThinkingLevel;
}

async function runStage(
	run: StageRun,
	input: PipelineInput,
	collected: ModelResult[],
): Promise<ModelResult[]> {
	// Dispatch the whole stage at once and let the runner's process-wide semaphore
	// do the throttling. A stage-level cap here would let one hive's stage claim
	// every slot, starving a concurrent background hive.
	const stageResults = await mapWithConcurrencyLimit(run.models, run.models.length, async (model) => {
		const result = await runNode({
			model,
			systemPrompt: run.systemPrompt,
			task: run.task,
			cwd: input.cwd,
			thinking: run.thinking,
			signal: input.signal,
			stage: run.stage,
		});
		collected.push(result);
		input.onProgress?.({
			stage: run.stage,
			done: collected.filter((r) => r.stage === run.stage).length,
			total: run.models.length,
			results: [...collected],
		});
		return result;
	});
	return stageResults;
}

/** The answer payload of each node that succeeded, ready for parsing. */
function successfulAnswers(results: ModelResult[]): string[] {
	return results.filter((r) => r.exitCode === 0).map((r) => extractAnswer(getFinalOutput(r.messages)));
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export async function runPipeline(input: PipelineInput): Promise<PipelineOutcome> {
	const startTime = Date.now();
	const { config } = input;
	const results: ModelResult[] = [];
	const stagesRun: StageName[] = [];

	const outcome = (extra: Partial<PipelineOutcome>): PipelineOutcome => ({
		question: input.question,
		roster: config.models,
		nodes: 0,
		thresholdPct: config.thresholdPct,
		stagesRun,
		candidates: [],
		problemTallies: new Map(),
		confirmedProblems: [],
		solutions: [],
		solutionTallies: new Map(),
		mutexOutcomes: [],
		adoptedSolutions: [],
		results,
		durationMs: Date.now() - startTime,
		...extra,
	});

	const aborted = () => input.signal?.aborted === true;

	// ── Stage 0: 解剖 ────────────────────────────────────────────────────────
	// Run at the floor width: decomposition is the cheapest way to learn how wide
	// the rest of the run should be, so paying for full width here would defeat
	// the point of deciding afterwards.
	const dissectModels = drawNodes(config.models, config.minNodes);
	stagesRun.push(STAGES.dissect);
	const dissectResults = await runStage(
		{
			stage: STAGES.dissect,
			models: dissectModels,
			systemPrompt: DISSECT_PROMPT,
			task: buildTask([
				["Full Conversation History", input.history],
				["Additional Context", input.context],
				["Question to decompose", input.question],
			]),
			thinking: config.thinking,
		},
		input,
		results,
	);

	if (aborted()) {
		return outcome({ haltedAt: STAGES.dissect, haltReason: "aborted during decomposition" });
	}

	const perNodePropositions = successfulAnswers(dissectResults).map(parsePropositions);
	const rawCount = perNodePropositions.reduce((sum, list) => sum + list.length, 0);
	if (rawCount === 0) {
		return outcome({
			haltedAt: STAGES.dissect,
			haltReason:
				"no node produced a parseable decomposition — inspect the raw output with hive_read({ extract_answer: false }) before retrying",
		});
	}

	const coarse = mergePropositions(perNodePropositions);

	// ── Stage 1: 归并 ────────────────────────────────────────────────────────
	// A single cheap node, and deliberately powerless: it may only collapse
	// restatements, so it is not an arbiter smuggled back in.
	let candidates = coarse;
	if (coarse.length > 1) {
		stagesRun.push(STAGES.merge);
		const mergeResults = await runStage(
			{
				stage: STAGES.merge,
				models: drawNodes(config.models, 1),
				systemPrompt: MERGE_PROMPT,
				task: buildTask([
					["Question", input.question],
					["Propositions from all nodes", describePropositions(coarse)],
				]),
				thinking: CHEAP_THINKING,
			},
			input,
			results,
		);
		const merged = successfulAnswers(mergeResults).flatMap(parsePropositions);
		// Trust the merge only if it returned something and did not inflate the list;
		// a merge step that grows the list has not merged, it has invented.
		if (merged.length > 0 && merged.length <= coarse.length) {
			const bySlug = new Map(coarse.map((c) => [c.slug, c]));
			candidates = merged.map((m) => ({ ...m, proposedBy: bySlug.get(m.slug)?.proposedBy ?? 1 }));
		}
	}

	if (aborted()) {
		return outcome({ candidates, haltedAt: STAGES.merge, haltReason: "aborted during merge" });
	}

	// ── Fan-out decision ────────────────────────────────────────────────────
	const maxLevel = candidates.reduce((max, c) => Math.max(max, c.level), 1);
	const cap = input.maxNodes
		? Math.min(config.maxNodes, Math.max(config.minNodes, input.maxNodes))
		: config.maxNodes;
	const nodeDecision = decideNodeCount(candidates.length, maxLevel, config.minNodes, cap);
	const voters = drawNodes(config.models, nodeDecision.nodes);

	// ── Stage 2: 问题投票 ────────────────────────────────────────────────────
	stagesRun.push(STAGES.voteProblems);
	const problemVoteResults = await runStage(
		{
			stage: STAGES.voteProblems,
			models: voters,
			systemPrompt: VOTE_PROBLEMS_PROMPT,
			task: buildTask([
				["Additional Context", input.context],
				["Question", input.question],
				[
					"Propositions to vote on",
					renderCandidateList(
						candidates.map((c) => ({
							slug: c.slug,
							text: c.evidence ? `${c.statement}\n   evidence: ${c.evidence}` : c.statement,
						})),
					),
				],
			]),
			thinking: CHEAP_THINKING,
		},
		input,
		results,
	);

	const problemBallots: Ballot[][] = problemVoteResults.map((r) =>
		r.exitCode === 0 ? parseBallots(extractAnswer(getFinalOutput(r.messages))) : [],
	);
	const problemTallies = tallyBallots(
		problemBallots,
		candidates.map((c) => c.slug),
		config.thresholdPct,
	);
	const confirmedProblems = candidates.filter((c) => problemTallies.get(c.slug)?.pass);

	if (aborted()) {
		return outcome({
			nodes: nodeDecision.nodes,
			nodeDecision,
			candidates,
			problemTallies,
			confirmedProblems,
			haltedAt: STAGES.voteProblems,
			haltReason: "aborted during the problem vote",
		});
	}

	if (confirmedProblems.length === 0) {
		// A real result, not a failure: the hive looked and did not agree that any of
		// the decomposed claims holds up.
		return outcome({
			nodes: nodeDecision.nodes,
			nodeDecision,
			candidates,
			problemTallies,
			confirmedProblems,
			haltedAt: STAGES.voteProblems,
			haltReason: `no proposition reached ${config.thresholdPct}% support — the hive does not agree there is a confirmed problem here`,
		});
	}

	// ── Stage 3: 解法 ────────────────────────────────────────────────────────
	stagesRun.push(STAGES.solve);
	const solveResults = await runStage(
		{
			stage: STAGES.solve,
			models: voters,
			systemPrompt: SOLVE_PROMPT,
			task: buildTask([
				["Full Conversation History", input.history],
				["Additional Context", input.context],
				["Original question", input.question],
				["Confirmed problems to solve", describePropositions(confirmedProblems)],
			]),
			thinking: config.thinking,
		},
		input,
		results,
	);

	const solutions = dedupeSolutions(successfulAnswers(solveResults).map(parseSolutions));

	if (aborted() || solutions.length === 0) {
		return outcome({
			nodes: nodeDecision.nodes,
			nodeDecision,
			candidates,
			problemTallies,
			confirmedProblems,
			solutions,
			haltedAt: STAGES.solve,
			haltReason: aborted()
				? "aborted during the solution stage"
				: "no node produced a parseable solution — the confirmed problems above still stand",
		});
	}

	// ── Stage 4: 解法投票 ────────────────────────────────────────────────────
	stagesRun.push(STAGES.voteSolutions);
	const solutionVoteResults = await runStage(
		{
			stage: STAGES.voteSolutions,
			models: voters,
			systemPrompt: VOTE_SOLUTIONS_PROMPT,
			task: buildTask([
				["Original question", input.question],
				["Confirmed problems", describePropositions(confirmedProblems)],
				[
					"Solutions to vote on",
					renderCandidateList(
						solutions.map((s) => ({
							slug: s.slug,
							text: `${s.summary}\n   addresses: ${s.addresses.join(", ") || "(unstated)"}`,
							group: s.mutexGroup,
						})),
					),
				],
			]),
			thinking: CHEAP_THINKING,
		},
		input,
		results,
	);

	const solutionBallots: Ballot[][] = solutionVoteResults.map((r) =>
		r.exitCode === 0 ? parseBallots(extractAnswer(getFinalOutput(r.messages))) : [],
	);
	const solutionTallies = tallyBallots(
		solutionBallots,
		solutions.map((s) => s.slug),
		config.thresholdPct,
	);
	const mutexOutcomes = tallyMutexGroups(solutions, solutionTallies);

	// Independent solutions pass on their own threshold; a mutex group contributes
	// its single leader, and contributes nothing when tied.
	const adoptedSolutions = [
		...independentSolutions(solutions).filter((s) => solutionTallies.get(s.slug)?.pass),
		...mutexOutcomes
			.filter((g) => g.leader)
			.map((g) => solutions.find((s) => s.slug === g.leader?.slug))
			.filter((s): s is Solution => !!s),
	];

	return outcome({
		nodes: nodeDecision.nodes,
		nodeDecision,
		candidates,
		problemTallies,
		confirmedProblems,
		solutions,
		solutionTallies,
		mutexOutcomes,
		adoptedSolutions,
	});
}

/**
 * Collapse identical solution slugs proposed by several nodes. Unlike the
 * proposition merge this needs no model: solutions are voted on by slug, so only
 * exact collisions matter here.
 */
function dedupeSolutions(perNode: Solution[][]): Solution[] {
	const bySlug = new Map<string, Solution>();
	for (const nodeSolutions of perNode) {
		for (const solution of nodeSolutions) {
			const existing = bySlug.get(solution.slug);
			if (!existing) {
				bySlug.set(solution.slug, solution);
				continue;
			}
			// Union what each node knew: the longer summary, and any mutex group or
			// addressed slugs the other node supplied.
			if (solution.summary.length > existing.summary.length) existing.summary = solution.summary;
			if (!existing.mutexGroup && solution.mutexGroup) existing.mutexGroup = solution.mutexGroup;
			existing.addresses = [...new Set([...existing.addresses, ...solution.addresses])];
		}
	}
	return [...bySlug.values()];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render the outcome as the tool's text result.
 *
 * Every vote is printed with its actual count, actual percentage, and the
 * threshold that was really applied — with at most ten ballots the effective
 * threshold drifts from the nominal one (3 of 4 is 75% at a nominal 60%), and a
 * bare "passed" would hide that.
 */
export function renderOutcome(o: PipelineOutcome): string {
	const lines: string[] = [];
	const succeeded = o.results.filter((r) => r.exitCode === 0).length;
	const seconds = (o.durationMs / 1000).toFixed(1);

	lines.push(
		`🐝 Hive Think — ${succeeded}/${o.results.length} nodes over ${o.stagesRun.length} stage${o.stagesRun.length === 1 ? "" : "s"} in ${seconds}s`,
	);
	if (o.nodeDecision) lines.push(`Fan-out: ${o.nodeDecision.rationale}`);
	lines.push(`Threshold: ${o.thresholdPct}% (actual support shown per item)`);

	if (o.haltReason) {
		lines.push("", `⚠ Halted at ${o.haltedAt}: ${o.haltReason}`);
	}

	// --- Problems ---
	if (o.candidates.length > 0) {
		lines.push("", `## Problems (${o.confirmedProblems.length}/${o.candidates.length} confirmed)`, "");
		for (const c of o.candidates) {
			const tally = o.problemTallies.get(c.slug);
			const statement = `\`${c.slug}\` — ${c.statement}`;
			lines.push(
				tally
					? formatVoteLine(statement, tally)
					: `· ${statement} (not voted on)`,
			);
			if (c.evidence) lines.push(`    evidence: ${c.evidence}`);
		}
	}

	// --- Solutions ---
	const independent = independentSolutions(o.solutions);
	if (independent.length > 0) {
		lines.push("", "## Solutions — independent", "");
		for (const s of independent) {
			const tally = o.solutionTallies.get(s.slug);
			const statement = `\`${s.slug}\` — ${s.summary}`;
			lines.push(tally ? formatVoteLine(statement, tally) : `· ${statement} (not voted on)`);
			if (s.addresses.length) lines.push(`    addresses: ${s.addresses.join(", ")}`);
		}
	}

	for (const group of o.mutexOutcomes) {
		lines.push("", `## Solutions — alternatives: ${group.group}`, "");
		for (const [i, tally] of group.ranked.entries()) {
			const solution = o.solutions.find((s) => s.slug === tally.slug);
			const marker = !group.tied && i === 0 ? "◀ relative majority" : "";
			lines.push(
				`${i + 1}. \`${tally.slug}\` — ${tally.yes}/${tally.voters} (${tally.actualPct}%) ${marker}`.trimEnd(),
			);
			if (solution) lines.push(`    ${solution.summary}`);
		}
		if (group.tied) {
			lines.push(
				`→ tied at ${group.ranked[0].yes} votes — the hive did not separate these; decide from the split above.`,
			);
		}
	}

	// --- Bottom line ---
	lines.push("", "---");
	if (o.adoptedSolutions.length > 0) {
		lines.push(`**Carried by the hive**: ${o.adoptedSolutions.map((s) => s.slug).join(", ")}`);
	} else if (o.confirmedProblems.length > 0) {
		lines.push("**No solution carried.** The confirmed problems stand; choose from the splits above yourself.");
	} else {
		lines.push("**Nothing carried.** Treat this as no signal and proceed with your own analysis.");
	}

	const usage = formatUsageStats(aggregateUsage(o.results));
	if (usage) lines.push(`**Cost**: ${usage}`);
	lines.push("", "Use `hive_read({ extract_answer: false })` for the full per-node output.");

	return lines.join("\n");
}
