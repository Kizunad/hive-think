/**
 * Hive Think — Aggregation Engine
 *
 * Pure functions for merging and voting on the items the pipeline passes between
 * stages: propositions (decomposed problems) and solutions. Zero pi dependencies
 * — fully testable with `node --test`.
 *
 * Two invariants carry the correctness of the whole vote:
 *
 *   1. A node votes at most once per item. Without per-node dedup a single
 *      verbose node can manufacture consensus by restating the same item.
 *   2. Vote math is integral: `yes * 100 >= voters * pct`. `Math.ceil(n * 0.6)`
 *      is unsafe (`3 * 0.6` is 1.7999999999999998) and an off-by-one in the
 *      minimum vote count moves the real threshold a full notch.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One decomposed problem. Emitted by the 解剖 stage. */
export interface Proposition {
	/** Short kebab-case id. Used for coarse merging before an LLM merge pass. */
	slug: string;
	/** A single verifiable claim. */
	statement: string;
	/** Where the claim comes from — `file:line`, a command, or free text. */
	evidence?: string;
	/** Decomposition depth, 1 = surface, 3 = first-principles floor. */
	level: number;
}

/** A merged proposition, carrying how many nodes independently raised it. */
export interface MergedProposition extends Proposition {
	/** Number of distinct nodes that proposed this item. Pre-vote signal only. */
	proposedBy: number;
}

/** One proposed solution. Emitted by the 解法 stage. */
export interface Solution {
	slug: string;
	/** Proposition slugs this addresses. */
	addresses: string[];
	summary: string;
	/**
	 * Solutions sharing a mutex group are alternatives to each other, so the group
	 * is decided by relative majority instead of an independent threshold — a
	 * three-way split can leave every option under any sane threshold.
	 */
	mutexGroup?: string;
}

/** One node's vote on one item. */
export interface Ballot {
	slug: string;
	vote: boolean;
	reason?: string;
}

export interface VoteTally {
	slug: string;
	yes: number;
	no: number;
	/** Participating nodes that returned ballots but omitted this item. */
	abstain: number;
	/** yes + no. The denominator for the threshold. */
	voters: number;
	pass: boolean;
	/** Actual support, 0-100, rounded. Always reported — never just the nominal threshold. */
	actualPct: number;
	/** Votes needed to pass at this voter count. */
	minVotes: number;
	/** minVotes / voters as a percentage — the threshold that was *really* applied. */
	effectivePct: number;
}

export interface MutexOutcome {
	group: string;
	/** Options ordered by support, highest first. */
	ranked: VoteTally[];
	/** Sole highest-support option, or undefined when tied. */
	leader?: VoteTally;
	/** True when two or more options share the top support count. */
	tied: boolean;
}

/**
 * Below this many actual voters an item cannot pass at any percentage: 2/2 is
 * 100% support and means nothing. Relaxed when the whole round has fewer
 * participants than this.
 */
export const MIN_VOTERS = 3;

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

const SLUG_MAX_LENGTH = 64;

/** Canonical slug form, so trivial spelling differences merge. */
export function normalizeSlug(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, SLUG_MAX_LENGTH);
}

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

/**
 * Pull a JSON value out of model output. Models wrap JSON in prose, in fenced
 * blocks, or in a one-key envelope, so this tries each in turn rather than
 * trusting any single shape. Returns undefined when nothing parses.
 */
export function extractJsonValue(rawText: string): unknown {
	if (!rawText || !rawText.trim()) return undefined;
	const text = rawText.trim();

	try {
		return JSON.parse(text);
	} catch {
		// fall through to the looser strategies
	}

	const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (fenced?.[1]) {
		try {
			return JSON.parse(fenced[1].trim());
		} catch {
			// keep going
		}
	}

	// Greedy so a trailing prose sentence doesn't truncate the structure.
	const bare = text.match(/[[{][\s\S]*[\]}]/);
	if (bare) {
		try {
			return JSON.parse(bare[0]);
		} catch {
			// give up below
		}
	}

	return undefined;
}

/**
 * Coerce an extracted value to an array of records. Accepts a bare array or a
 * single-array-field envelope like `{ "problems": [...] }`.
 */
function toRecordArray(value: unknown): Record<string, unknown>[] {
	const asArray = (v: unknown): unknown[] | undefined => {
		if (Array.isArray(v)) return v;
		if (v && typeof v === "object") {
			for (const nested of Object.values(v)) {
				if (Array.isArray(nested)) return nested;
			}
		}
		return undefined;
	};
	const arr = asArray(value);
	if (!arr) return [];
	return arr.filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && !Array.isArray(e));
}

function readString(obj: Record<string, unknown>, ...keys: string[]): string {
	for (const key of keys) {
		const value = obj[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

// ---------------------------------------------------------------------------
// Parsing stage output
// ---------------------------------------------------------------------------

export function parsePropositions(rawText: string): Proposition[] {
	const out: Proposition[] = [];
	for (const entry of toRecordArray(extractJsonValue(rawText))) {
		const statement = readString(entry, "statement", "problem", "claim");
		if (!statement) continue; // an item with nothing asserted is not a proposition
		const slug = normalizeSlug(readString(entry, "slug", "id") || statement);
		if (!slug) continue;
		const rawLevel = entry.level;
		const level =
			typeof rawLevel === "number" && Number.isFinite(rawLevel) ? Math.min(3, Math.max(1, Math.round(rawLevel))) : 1;
		const evidence = readString(entry, "evidence", "where", "source");
		out.push(evidence ? { slug, statement, evidence, level } : { slug, statement, level });
	}
	return out;
}

export function parseSolutions(rawText: string): Solution[] {
	const out: Solution[] = [];
	for (const entry of toRecordArray(extractJsonValue(rawText))) {
		const summary = readString(entry, "summary", "solution", "approach");
		if (!summary) continue;
		const slug = normalizeSlug(readString(entry, "slug", "id") || summary);
		if (!slug) continue;
		const rawAddresses = entry.addresses ?? entry.solves ?? entry.for;
		const addresses = Array.isArray(rawAddresses)
			? rawAddresses.filter((a): a is string => typeof a === "string").map(normalizeSlug).filter(Boolean)
			: [];
		const group = normalizeSlug(readString(entry, "mutexGroup", "mutex_group", "group"));
		out.push(group ? { slug, addresses, summary, mutexGroup: group } : { slug, addresses, summary });
	}
	return out;
}

export function parseBallots(rawText: string): Ballot[] {
	const out: Ballot[] = [];
	for (const entry of toRecordArray(extractJsonValue(rawText))) {
		const slug = normalizeSlug(readString(entry, "slug", "id"));
		if (!slug) continue;
		const raw = entry.vote ?? entry.verdict;
		let vote: boolean;
		if (typeof raw === "boolean") {
			vote = raw;
		} else if (typeof raw === "string") {
			const v = raw.trim().toLowerCase();
			if (["yes", "y", "true", "up", "agree", "pass"].includes(v)) vote = true;
			else if (["no", "n", "false", "down", "disagree", "fail"].includes(v)) vote = false;
			else continue; // unrecognized verdict is an abstention, not a guess
		} else {
			continue;
		}
		const reason = readString(entry, "reason", "why", "rationale");
		out.push(reason ? { slug, vote, reason } : { slug, vote });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Coarse merge of per-node propositions by slug. This is a cheap pre-pass, not
 * the semantic merge — two nodes describing one problem in different words keep
 * different slugs and are only united by the 归并 stage. Deliberately dumb so it
 * cannot silently drop a distinct problem.
 */
export function mergePropositions(perNode: Proposition[][]): MergedProposition[] {
	const merged = new Map<string, MergedProposition>();

	for (const nodeItems of perNode) {
		const seenInNode = new Set<string>();
		for (const item of nodeItems) {
			if (seenInNode.has(item.slug)) continue; // invariant 1: one vote per node
			seenInNode.add(item.slug);

			const existing = merged.get(item.slug);
			if (existing) {
				existing.proposedBy++;
				// Prefer the deeper decomposition: a first-principles statement of the
				// same problem is the more useful one to carry forward.
				if (item.level > existing.level) {
					existing.statement = item.statement;
					existing.level = item.level;
					if (item.evidence) existing.evidence = item.evidence;
				} else if (!existing.evidence && item.evidence) {
					existing.evidence = item.evidence;
				}
			} else {
				merged.set(item.slug, { ...item, proposedBy: 1 });
			}
		}
	}

	return [...merged.values()].sort((a, b) => b.proposedBy - a.proposedBy || b.level - a.level);
}

// ---------------------------------------------------------------------------
// Vote math
// ---------------------------------------------------------------------------

/**
 * Minimum yes-votes to pass at a given voter count. Integer-only.
 * Equivalent to ceil(voters * pct / 100) without touching a float.
 */
export function minVotesFor(voters: number, thresholdPct: number): number {
	if (voters <= 0) return 0;
	// ceil(voters * pct / 100) by integer division only — no float ever forms.
	const scaled = voters * thresholdPct;
	return Math.floor(scaled / 100) + (scaled % 100 === 0 ? 0 : 1);
}

function pctOf(part: number, whole: number): number {
	return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/**
 * Tally one item.
 *
 * `participants` counts nodes that returned usable ballots — a crashed node is
 * excluded rather than counted as dissent — and participants who skipped this
 * item are recorded as abstentions.
 *
 * `dispatched` counts nodes the round actually launched, and is what the
 * minimum-voter floor is measured against. Deriving the floor from `participants`
 * instead would let it relax exactly when nodes die: 4 nodes launched, 2 crashed,
 * 2 vote yes, and 2/2 = 100% sails through. The floor is meant to relax only for
 * a round that was deliberately small.
 */
export function tallyItem(
	slug: string,
	yes: number,
	no: number,
	participants: number,
	thresholdPct: number,
	dispatched: number = participants,
): VoteTally {
	const voters = yes + no;
	const floor = Math.min(MIN_VOTERS, Math.max(dispatched, participants));
	const minVotes = minVotesFor(voters, thresholdPct);
	// Derived from minVotes rather than recomputed, so the reported bar and the
	// applied bar cannot drift apart.
	const meetsThreshold = voters > 0 && yes >= minVotes;
	return {
		slug,
		yes,
		no,
		abstain: Math.max(0, participants - voters),
		voters,
		pass: meetsThreshold && voters >= floor,
		actualPct: pctOf(yes, voters),
		minVotes,
		effectivePct: pctOf(minVotes, voters),
	};
}

/**
 * Tally every candidate slug across all nodes' ballots.
 *
 * `perNode` holds one entry per dispatched node; pass an empty array for a node
 * that produced nothing, so it is excluded from the denominator instead of
 * silently voting no.
 */
export function tallyBallots(perNode: Ballot[][], slugs: string[], thresholdPct: number): Map<string, VoteTally> {
	const participating = perNode.filter((ballots) => ballots.length > 0);
	const participants = participating.length;

	const yesCount = new Map<string, number>();
	const noCount = new Map<string, number>();
	for (const slug of slugs) {
		yesCount.set(slug, 0);
		noCount.set(slug, 0);
	}

	for (const ballots of participating) {
		const seenInNode = new Set<string>();
		for (const ballot of ballots) {
			if (!yesCount.has(ballot.slug)) continue; // vote for an item not on the list
			if (seenInNode.has(ballot.slug)) continue; // invariant 1: one vote per node
			seenInNode.add(ballot.slug);
			const bucket = ballot.vote ? yesCount : noCount;
			bucket.set(ballot.slug, (bucket.get(ballot.slug) ?? 0) + 1);
		}
	}

	const out = new Map<string, VoteTally>();
	for (const slug of slugs) {
		out.set(
			slug,
			tallyItem(slug, yesCount.get(slug) ?? 0, noCount.get(slug) ?? 0, participants, thresholdPct, perNode.length),
		);
	}
	return out;
}

/**
 * Resolve mutually exclusive solution groups by relative majority. Ties are
 * reported rather than broken — the vote split is the useful output, and the main
 * agent is better placed to break it than an arbitrary rule.
 */
export function tallyMutexGroups(solutions: Solution[], tallies: Map<string, VoteTally>): MutexOutcome[] {
	const groups = new Map<string, VoteTally[]>();
	for (const solution of solutions) {
		if (!solution.mutexGroup) continue;
		const tally = tallies.get(solution.slug);
		if (!tally) continue;
		const bucket = groups.get(solution.mutexGroup);
		if (bucket) bucket.push(tally);
		else groups.set(solution.mutexGroup, [tally]);
	}

	const out: MutexOutcome[] = [];
	for (const [group, members] of groups) {
		const ranked = [...members].sort((a, b) => b.yes - a.yes || b.actualPct - a.actualPct);
		const top = ranked[0];
		const tied = ranked.length > 1 && ranked[1].yes === top.yes;
		out.push({ group, ranked, leader: tied ? undefined : top, tied });
	}
	return out;
}

/** Independent solutions are the ones not in any mutex group. */
export function independentSolutions(solutions: Solution[]): Solution[] {
	return solutions.filter((s) => !s.mutexGroup);
}

// ---------------------------------------------------------------------------
// Dynamic fan-out
// ---------------------------------------------------------------------------

export interface NodeDecision {
	nodes: number;
	rationale: string;
}

/**
 * Decide how wide the voting stages should run, from what the decomposition
 * actually found. Deciding here rather than asking the caller up front is the
 * point: before decomposing, any node count is a guess.
 *
 * More distinct problems need more independent judgements to separate real from
 * imagined; a deeper decomposition means the problem resisted the first pass.
 */
export function decideNodeCount(
	propositionCount: number,
	maxLevel: number,
	minNodes: number,
	maxNodes: number,
): NodeDecision {
	const lo = Math.min(minNodes, maxNodes);
	const hi = Math.max(minNodes, maxNodes);

	if (propositionCount <= 0) {
		return { nodes: lo, rationale: `no propositions survived decomposition — running the ${lo}-node floor` };
	}

	const depthBonus = Math.max(0, Math.min(3, maxLevel) - 1);
	const want = 2 + Math.ceil(propositionCount / 2) + depthBonus;
	const nodes = Math.min(hi, Math.max(lo, want));

	const clamped = want > hi ? ` (capped at ${hi})` : want < lo ? ` (raised to the ${lo} floor)` : "";
	return {
		nodes,
		rationale: `${propositionCount} proposition${propositionCount === 1 ? "" : "s"} at depth ${Math.min(3, maxLevel)} → ${nodes} nodes${clamped}`,
	};
}

// ---------------------------------------------------------------------------
// Node selection
// ---------------------------------------------------------------------------

/**
 * Draw `count` nodes from the roster round-robin, so a roster smaller than the
 * fan-out still works — a 2-model roster fans out to 10 nodes as 5 each.
 */
export function drawNodes(models: string[], count: number): string[] {
	if (models.length === 0 || count <= 0) return [];
	return Array.from({ length: count }, (_, i) => models[i % models.length]);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Render one vote line. The actual count and percentage are always shown next to
 * the threshold that was really applied, because with at most 10 ballots the
 * effective threshold drifts from the nominal one (3/4 is 75% at a nominal 60%).
 */
export function formatVoteLine(statement: string, tally: VoteTally): string {
	const icon = tally.pass ? "✅" : "❌";
	const abstained = tally.abstain > 0 ? `, ${tally.abstain} abstained` : "";
	const weak = tally.voters > 0 && tally.voters < MIN_VOTERS ? " ⚠ too few voters to pass" : "";
	return `${icon} ${statement} — ${tally.yes}/${tally.voters} (${tally.actualPct}%, needed ${tally.minVotes} = ${tally.effectivePct}%${abstained})${weak}`;
}
