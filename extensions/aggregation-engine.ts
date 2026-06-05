/**
 * Swarm Review — Aggregation Engine
 *
 * Pure TypeScript functions for aggregating, deduplicating, and
 * voting on bug/vulnerability findings from multiple models.
 * Zero pi dependencies — fully testable with node --test.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RawFinding {
	file: string;
	line: number;
	severity: "critical" | "high" | "medium" | "low";
	type: string;
	description: string;
	fingerprint?: string;
}

export interface AggregatedFinding {
	finding: RawFinding;
	voteCount: number;
}

export interface JuryVote {
	fingerprint: string;
	verdict: "UP" | "DOWN";
}

export interface SwarmStats {
	filesScanned: number;
	totalChars: number;
	rawFindings: number;
	passedVote: number;
	juryApproved: number;
	durationSeconds: number;
	scanSuccessCount: number;
	scanTotalCount: number;
}

// ---------------------------------------------------------------------------
// Line bucketing (5-line granularity for adjacent-line dedup)
// ---------------------------------------------------------------------------

export function normalizeLine(line: number, bucketSize = 5): number {
	return Math.floor(line / bucketSize) * bucketSize;
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

export function makeFingerprint(f: RawFinding, bucketSize = 5): string {
	if (f.fingerprint) return f.fingerprint;
	return `${f.file}:${normalizeLine(f.line, bucketSize)}:${f.type}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateFinding(f: any): f is RawFinding {
	if (!f || typeof f !== "object" || Array.isArray(f)) return false;
	if (typeof f.file !== "string" || !f.file.trim()) return false;
	if (typeof f.line !== "number" || f.line < 0 || !Number.isInteger(f.line)) return false;
	if (!["critical", "high", "medium", "low"].includes(f.severity)) return false;
	if (typeof f.type !== "string" || !f.type.trim()) return false;
	if (typeof f.description !== "string" || !f.description.trim()) return false;
	return true;
}

// ---------------------------------------------------------------------------
// Parse JSON output from a model, extracting findings array
// ---------------------------------------------------------------------------

export function parseFindings(rawText: string): RawFinding[] {
	if (!rawText || !rawText.trim()) return [];

	// Try direct JSON parse first
	try {
		const parsed = JSON.parse(rawText.trim());
		if (Array.isArray(parsed)) {
			return parsed.filter(validateFinding);
		}
		// Wrapped in object with array field
		if (parsed && typeof parsed === "object") {
			for (const v of Object.values(parsed)) {
				if (Array.isArray(v)) return v.filter(validateFinding);
			}
		}
	} catch {
		// Not direct JSON — try to extract JSON array from markdown/code blocks
	}

	// Try ```json blocks
	const jsonBlock = rawText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (jsonBlock?.[1]) {
		try {
			const parsed = JSON.parse(jsonBlock[1].trim());
			if (Array.isArray(parsed)) return parsed.filter(validateFinding);
		} catch { /* continue */ }
	}

	// Try to find bare JSON array [...]
	const arrayMatch = rawText.match(/\[\s*\{[\s\S]*?\}\s*\]/);
	if (arrayMatch) {
		try {
			const parsed = JSON.parse(arrayMatch[0]);
			if (Array.isArray(parsed)) return parsed.filter(validateFinding);
		} catch { /* continue */ }
	}

	return [];
}

// ---------------------------------------------------------------------------
// Aggregate findings across models: per-model dedup → global vote count
// ---------------------------------------------------------------------------

export function aggregateFindings(
	allModelFindings: RawFinding[][],
	bucketSize = 5,
): Map<string, AggregatedFinding> {
	const map = new Map<string, AggregatedFinding>();
	const severityRank: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

	for (const modelFindings of allModelFindings) {
		const seenInModel = new Set<string>();
		for (const f of modelFindings) {
			if (!validateFinding(f)) continue;
			const fp = makeFingerprint(f, bucketSize);
			if (seenInModel.has(fp)) continue; // per-model dedup
			seenInModel.add(fp);

			const existing = map.get(fp);
			if (existing) {
				existing.voteCount++;
				// Keep the higher-severity version
				if (severityRank[f.severity] > severityRank[existing.finding.severity]) {
					existing.finding = { ...f, fingerprint: fp };
				}
			} else {
				map.set(fp, { finding: { ...f, fingerprint: fp }, voteCount: 1 });
			}
		}
	}
	return map;
}

// ---------------------------------------------------------------------------
// Vote threshold filter (default 80%)
// ---------------------------------------------------------------------------

export function voteFilter(
	aggregated: Map<string, AggregatedFinding>,
	totalModels: number,
	threshold = 0.8,
): AggregatedFinding[] {
	const minVotes = Math.ceil(totalModels * threshold);
	const severityRank: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

	return [...aggregated.values()]
		.filter((a) => a.voteCount >= minVotes)
		.sort((a, b) => {
			return severityRank[b.finding.severity] - severityRank[a.finding.severity]
				|| b.voteCount - a.voteCount;
		});
}

// ---------------------------------------------------------------------------
// Parse jury votes from JSON output
// ---------------------------------------------------------------------------

export function parseJuryVotes(rawText: string): JuryVote[] {
	if (!rawText || !rawText.trim()) return [];

	try {
		const parsed = JSON.parse(rawText.trim());
		if (Array.isArray(parsed)) {
			return parsed.filter(
				(v: any): v is JuryVote =>
					typeof v.fingerprint === "string" && ["UP", "DOWN"].includes(v.verdict),
			);
		}
		if (parsed && typeof parsed === "object") {
			if (Array.isArray(parsed.votes)) {
				return parsed.votes.filter(
					(v: any): v is JuryVote =>
						typeof v.fingerprint === "string" && ["UP", "DOWN"].includes(v.verdict),
				);
			}
		}
	} catch {
		// Try JSON block
		const jsonBlock = rawText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
		if (jsonBlock?.[1]) {
			try {
				const parsed = JSON.parse(jsonBlock[1].trim());
				if (Array.isArray(parsed)) {
					return parsed.filter(
						(v: any): v is JuryVote =>
							typeof v.fingerprint === "string" && ["UP", "DOWN"].includes(v.verdict),
					);
				}
			} catch { /* ignore */ }
		}
	}
	return [];
}

// ---------------------------------------------------------------------------
// Jury verdict: at least N UP votes for confirmation
// ---------------------------------------------------------------------------

export function juryConfirm(
	fingerprint: string,
	allJuryVotes: JuryVote[][],
	minUpVotes = 2,
): { confirmed: boolean; upVotes: number; totalVotes: number } {
	let upVotes = 0;
	let totalVotes = 0;
	for (const juryVotes of allJuryVotes) {
		const vote = juryVotes.find((v) => v.fingerprint === fingerprint);
		if (vote) {
			totalVotes++;
			if (vote.verdict === "UP") upVotes++;
		}
	}
	return { confirmed: upVotes >= minUpVotes, upVotes, totalVotes };
}

// ---------------------------------------------------------------------------
// Partition files into groups for parallel scanning
// ---------------------------------------------------------------------------

export interface FileEntry {
	path: string;
	size: number;
}

export function partitionFiles(
	files: FileEntry[],
	numModels: number,
	maxCharsPerModel = 180_000,
): FileEntry[][] {
	if (files.length === 0) return [];

	const totalChars = files.reduce((s, f) => s + f.size, 0);

	// If everything fits, all models scan everything
	if (totalChars <= maxCharsPerModel) {
		return new Array(numModels).fill(null).map(() => [...files]);
	}

	// Otherwise partition with 2× overlap
	// Simple round-robin with file-level granularity
	const partitions: FileEntry[][] = new Array(numModels).fill(null).map(() => []);
	let idx = 0;
	for (const file of files) {
		// Each file goes to at least 2 partitions (overlap)
		partitions[idx % numModels].push(file);
		partitions[(idx + 1) % numModels].push(file);
		idx++;
	}
	return partitions;
}

// ---------------------------------------------------------------------------
// Format findings for output
// ---------------------------------------------------------------------------

export function formatFindingLine(
	f: AggregatedFinding,
	confirmed: boolean,
	upVotes: number,
	totalJury: number,
): string {
	const icon = confirmed ? "🔴" : "🟡";
	const status = confirmed
		? `votes: ${f.voteCount}, jury: ${upVotes}/${totalJury} UP`
		: `votes: ${f.voteCount} (jury: ${upVotes}/${totalJury})`;
	return `${icon} \`${f.finding.file}:${f.finding.line}\` **${f.finding.severity}** \`${f.finding.type}\` — ${f.finding.description} (${status})`;
}
