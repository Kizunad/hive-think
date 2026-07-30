/**
 * Hive Think — pure utilities
 *
 * No pi imports, no I/O, no module state. Everything here is directly importable
 * by `node --test`, which is the point: the previous test suite kept hand-copied
 * duplicates of these helpers and asserted against the copies, so the assertions
 * stayed green while the originals drifted.
 */

// ---------------------------------------------------------------------------
// ANSWER blocks
// ---------------------------------------------------------------------------

export const ANSWER_START = "<ANSWER>";
export const ANSWER_END = "</ANSWER>";

/**
 * The contents of the final `<ANSWER>` block, or null when there is none.
 *
 * Anchored on the last closing tag and then the opening tag *before* it. Taking
 * the last of each independently breaks when a node emits one complete block and
 * begins another: the last opener would sit after the last closer and yield an
 * empty slice. An unterminated trailing block is still returned, because the
 * early-exit kill can cut the stream mid-tag.
 */
export function extractAnswerBlock(text: string): string | null {
	if (!text) return null;
	const end = text.lastIndexOf(ANSWER_END);
	if (end === -1) {
		const start = text.lastIndexOf(ANSWER_START);
		return start === -1 ? null : text.slice(start + ANSWER_START.length).trim();
	}
	const start = text.lastIndexOf(ANSWER_START, end);
	if (start === -1) return null;
	return text.slice(start + ANSWER_START.length, end).trim();
}

/**
 * The answer block when tagged, otherwise the whole text — a node that emitted
 * well-formed JSON but forgot the tags is still usable to the parsers.
 */
export function extractAnswer(text: string): string {
	return extractAnswerBlock(text) ?? text;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(usage: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens?: number;
	turns?: number;
}): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** Parse a non-negative millisecond env value; 0 means "disabled", junk means "default". */
export function resolvePositiveMs(raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

/**
 * FIFO counting semaphore.
 *
 * On release the slot is handed straight to the next waiter rather than
 * decremented and re-acquired: decrementing first opens a window in which a fresh
 * `acquire()` takes the fast path while a woken waiter also increments, putting
 * two holders in one slot.
 */
export class Semaphore {
	private active = 0;
	private readonly waiters: Array<() => void> = [];
	private readonly limit: number;

	// Assigned in the body rather than declared as a parameter property: Node's
	// strip-only type removal rejects `constructor(private x: T)`, and this package
	// is loaded as TypeScript at runtime, never compiled.
	constructor(limit: number) {
		this.limit = limit;
	}

	/** Number of slots currently held. Exposed for tests. */
	get inUse(): number {
		return this.active;
	}

	async acquire(): Promise<() => void> {
		if (this.active < this.limit) this.active++;
		else await new Promise<void>((resolve) => this.waiters.push(resolve));

		let released = false;
		return () => {
			if (released) return; // guard a double release from a retry path
			released = true;
			const next = this.waiters.shift();
			if (next) next(); // hand the slot over; active stays put
			else this.active--;
		};
	}
}

/**
 * Merge AbortSignals into one that fires when any input fires (e.g. an external
 * cancel plus the hive budget). Avoids depending on AbortSignal.any across runtimes.
 */
export function combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	for (const s of signals) {
		if (!s) continue;
		if (s.aborted) {
			controller.abort();
			break;
		}
		s.addEventListener("abort", onAbort, { once: true });
	}
	return controller.signal;
}
