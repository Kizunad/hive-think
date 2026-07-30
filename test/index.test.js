/**
 * Tests for hive-think.
 * Run: node --test test/index.test.js   (Node >= 22.18 strips TS types natively)
 *
 * These import the real modules. The previous suite kept hand-copied duplicates of
 * every helper and asserted against the copies, so its DEFAULT_MODELS assertions
 * stayed green for months while the source drifted to a different list entirely.
 * Anything pure enough to test lives in hive-util.ts, hive-config.ts, or
 * aggregation-engine.ts precisely so it can be imported here rather than mirrored.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	ANSWER_END,
	ANSWER_START,
	Semaphore,
	combineSignals,
	extractAnswer,
	extractAnswerBlock,
	formatTokens,
	formatUsageStats,
	mapWithConcurrencyLimit,
	resolvePositiveMs,
} from "../extensions/hive-util.ts";

import {
	DEFAULT_THINKING,
	DEFAULT_THRESHOLD_PCT,
	NODES_CEILING,
	NODES_FLOOR,
	configSearchPaths,
	loadConfig,
	parseConfig,
	unconfiguredError,
} from "../extensions/hive-config.ts";

import {
	MIN_VOTERS,
	decideNodeCount,
	drawNodes,
	extractJsonValue,
	formatVoteLine,
	independentSolutions,
	mergePropositions,
	minVotesFor,
	normalizeSlug,
	parseBallots,
	parsePropositions,
	parseSolutions,
	tallyBallots,
	tallyItem,
	tallyMutexGroups,
} from "../extensions/aggregation-engine.ts";

// ===========================================================================
// hive-util
// ===========================================================================

describe("formatTokens", () => {
	it("passes through counts under 1k", () => {
		assert.equal(formatTokens(0), "0");
		assert.equal(formatTokens(999), "999");
	});

	it("uses one decimal under 10k and rounds above", () => {
		assert.equal(formatTokens(1500), "1.5k");
		assert.equal(formatTokens(12_400), "12k");
	});

	it("switches to M at a million", () => {
		assert.equal(formatTokens(2_500_000), "2.5M");
	});
});

describe("formatUsageStats", () => {
	it("omits zero fields entirely", () => {
		assert.equal(formatUsageStats({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }), "");
	});

	it("renders the fields that are present", () => {
		const out = formatUsageStats({
			input: 1200,
			output: 340,
			cacheRead: 5000,
			cacheWrite: 0,
			cost: 0.0123,
			turns: 2,
			contextTokens: 8000,
		});
		assert.equal(out, "2 turns ↑1.2k ↓340 R5.0k $0.0123 ctx:8.0k");
	});
});

describe("resolvePositiveMs", () => {
	it("falls back on undefined, blank, and junk", () => {
		assert.equal(resolvePositiveMs(undefined, 42), 42);
		assert.equal(resolvePositiveMs("   ", 42), 42);
		assert.equal(resolvePositiveMs("abc", 42), 42);
		assert.equal(resolvePositiveMs("-1", 42), 42);
	});

	it("treats 0 as an explicit disable rather than a fallback", () => {
		assert.equal(resolvePositiveMs("0", 42), 0);
	});

	it("accepts a positive value", () => {
		assert.equal(resolvePositiveMs("60000", 42), 60_000);
	});
});

describe("extractAnswerBlock", () => {
	it("returns null when there is no tag", () => {
		assert.equal(extractAnswerBlock("just prose"), null);
		assert.equal(extractAnswerBlock(""), null);
	});

	it("extracts and trims a well-formed block", () => {
		assert.equal(extractAnswerBlock(`before ${ANSWER_START}\n  hello \n${ANSWER_END} after`), "hello");
	});

	it("returns the tail of an unterminated block", () => {
		// The ANSWER early-exit kills the subprocess, which can cut the stream mid-tag.
		assert.equal(extractAnswerBlock(`x ${ANSWER_START} partial output`), "partial output");
	});

	it("takes the last complete block when several are emitted", () => {
		const text = `${ANSWER_START}first${ANSWER_END} noise ${ANSWER_START}second${ANSWER_END}`;
		assert.equal(extractAnswerBlock(text), "second");
	});

	it("prefers a complete block over a later unterminated one", () => {
		// Anchoring on lastIndexOf for each tag independently would put the opener
		// after the closer here and slice backwards to "". Preferring the complete
		// block is also the safer choice: a fragment may be truncated mid-JSON.
		const text = `${ANSWER_START}complete${ANSWER_END} then ${ANSWER_START}started`;
		const got = extractAnswerBlock(text);
		assert.notEqual(got, "");
		assert.equal(got, "complete");
	});
});

describe("extractAnswer", () => {
	it("falls back to the whole text so untagged JSON is still parseable", () => {
		assert.equal(extractAnswer('[{"slug":"a"}]'), '[{"slug":"a"}]');
	});

	it("prefers the tagged block when present", () => {
		assert.equal(extractAnswer(`noise ${ANSWER_START}kept${ANSWER_END}`), "kept");
	});
});

describe("mapWithConcurrencyLimit", () => {
	it("returns results in input order regardless of completion order", async () => {
		const out = await mapWithConcurrencyLimit([30, 10, 20], 3, async (ms, i) => {
			await new Promise((r) => setTimeout(r, ms));
			return `${i}:${ms}`;
		});
		assert.deepEqual(out, ["0:30", "1:10", "2:20"]);
	});

	it("never exceeds the limit", async () => {
		let active = 0;
		let peak = 0;
		await mapWithConcurrencyLimit([...Array(10).keys()], 3, async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 5));
			active--;
		});
		assert.ok(peak <= 3, `peak concurrency ${peak} exceeded limit 3`);
	});

	it("handles an empty list and a limit above the item count", async () => {
		assert.deepEqual(await mapWithConcurrencyLimit([], 4, async () => 1), []);
		assert.deepEqual(await mapWithConcurrencyLimit([1, 2], 99, async (n) => n * 2), [2, 4]);
	});
});

describe("Semaphore", () => {
	it("never lets more than `limit` holders in at once", async () => {
		const sem = new Semaphore(2);
		let peak = 0;
		await Promise.all(
			[...Array(8).keys()].map(async () => {
				const release = await sem.acquire();
				peak = Math.max(peak, sem.inUse);
				await new Promise((r) => setTimeout(r, 5));
				release();
			}),
		);
		assert.equal(peak, 2);
		assert.equal(sem.inUse, 0);
	});

	it("hands a released slot to the waiter instead of double-counting it", async () => {
		// Releasing by decrementing first would let a fresh acquire take the fast path
		// while the woken waiter also increments, putting two holders in one slot.
		const sem = new Semaphore(1);
		const first = await sem.acquire();
		let secondEntered = false;
		const second = sem.acquire().then((release) => {
			secondEntered = true;
			assert.equal(sem.inUse, 1);
			return release;
		});
		assert.equal(secondEntered, false);
		first();
		(await second)();
		assert.equal(sem.inUse, 0);
	});

	it("ignores a double release", async () => {
		const sem = new Semaphore(1);
		const release = await sem.acquire();
		release();
		release();
		assert.equal(sem.inUse, 0);
	});

	it("serves waiters first-in-first-out", async () => {
		const sem = new Semaphore(1);
		const held = await sem.acquire();
		const order = [];
		const waiters = [1, 2, 3].map((n) =>
			sem.acquire().then((release) => {
				order.push(n);
				release();
			}),
		);
		held();
		await Promise.all(waiters);
		assert.deepEqual(order, [1, 2, 3]);
	});
});

describe("combineSignals", () => {
	it("fires when any input fires", () => {
		const a = new AbortController();
		const b = new AbortController();
		const merged = combineSignals(a.signal, b.signal, undefined);
		assert.equal(merged.aborted, false);
		b.abort();
		assert.equal(merged.aborted, true);
	});

	it("is already aborted when an input was", () => {
		const a = new AbortController();
		a.abort();
		assert.equal(combineSignals(a.signal).aborted, true);
	});

	it("tolerates being given nothing", () => {
		assert.equal(combineSignals(undefined, undefined).aborted, false);
	});
});

// ===========================================================================
// hive-config
// ===========================================================================

describe("configSearchPaths", () => {
	it("puts the project-local file first so a repo can pin a roster", () => {
		const paths = configSearchPaths("/work/proj", {}, "/home/u");
		assert.equal(paths[0], path.join("/work/proj", ".hive-think.json"));
		assert.equal(paths[1], path.join("/home/u", ".config", "pi", "hive-think.json"));
	});

	it("honours XDG_CONFIG_HOME", () => {
		const paths = configSearchPaths("/work", { XDG_CONFIG_HOME: "/xdg" }, "/home/u");
		assert.equal(paths[1], path.join("/xdg", "pi", "hive-think.json"));
	});

	it("ignores a blank XDG_CONFIG_HOME", () => {
		const paths = configSearchPaths("/work", { XDG_CONFIG_HOME: "  " }, "/home/u");
		assert.equal(paths[1], path.join("/home/u", ".config", "pi", "hive-think.json"));
	});
});

describe("parseConfig", () => {
	const ok = (json) => {
		const r = parseConfig(JSON.stringify(json), "/cfg");
		assert.equal(r.ok, true, r.ok ? "" : r.error);
		return r.config;
	};
	const err = (json) => {
		const raw = typeof json === "string" ? json : JSON.stringify(json);
		const r = parseConfig(raw, "/cfg");
		assert.equal(r.ok, false, "expected rejection");
		return r.error;
	};

	it("accepts a minimal roster and fills in defaults", () => {
		const c = ok({ models: ["p/a", "p/b"] });
		assert.deepEqual(c.models, ["p/a", "p/b"]);
		assert.equal(c.minNodes, NODES_FLOOR);
		assert.equal(c.maxNodes, NODES_CEILING);
		assert.equal(c.thresholdPct, DEFAULT_THRESHOLD_PCT);
		assert.equal(c.thinking, DEFAULT_THINKING);
		assert.equal(c.source, "/cfg");
	});

	it("trims model ids", () => {
		assert.deepEqual(ok({ models: ["  p/a  "] }).models, ["p/a"]);
	});

	it("rejects malformed JSON, naming the source", () => {
		assert.match(err("{not json"), /\/cfg is invalid: not valid JSON/);
	});

	it("rejects a non-object top level", () => {
		assert.match(err(["p/a"]), /top level must be a JSON object/);
	});

	it("requires models", () => {
		assert.match(err({}), /missing required "models"/);
		assert.match(err({ models: "p/a" }), /"models" must be an array/);
		assert.match(err({ models: [] }), /"models" is empty/);
	});

	it("rejects a blank or non-string model rather than silently dropping it", () => {
		// Skipping it would change the roster size without saying so.
		assert.match(err({ models: ["p/a", "  "] }), /"models\[1\]" is empty/);
		assert.match(err({ models: ["p/a", 7] }), /"models\[1\]" must be a string, got number/);
		assert.match(err({ models: [null] }), /"models\[0\]" must be a string, got null/);
	});

	it("accepts node bounds inside the allowed range", () => {
		const c = ok({ models: ["p/a"], nodes: { min: 4, max: 8 } });
		assert.equal(c.minNodes, 4);
		assert.equal(c.maxNodes, 8);
	});

	it("rejects node bounds outside the range, non-integers, and min > max", () => {
		assert.match(err({ models: ["p/a"], nodes: { min: 2 } }), /"nodes.min" must be between 3 and 10/);
		assert.match(err({ models: ["p/a"], nodes: { max: 11 } }), /"nodes.max" must be between 3 and 10/);
		assert.match(err({ models: ["p/a"], nodes: { min: 3.5 } }), /"nodes.min" must be an integer/);
		assert.match(err({ models: ["p/a"], nodes: { min: 9, max: 4 } }), /exceeds "nodes.max"/);
		assert.match(err({ models: ["p/a"], nodes: [] }), /"nodes" must be an object/);
	});

	it("takes threshold as a fraction and converts to integer percent", () => {
		assert.equal(ok({ models: ["p/a"], threshold: 0.65 }).thresholdPct, 65);
		assert.equal(ok({ models: ["p/a"], threshold: 1 }).thresholdPct, 100);
	});

	it("names the fraction-vs-percent mistake explicitly", () => {
		assert.match(err({ models: ["p/a"], threshold: 60 }), /write 0\.6 for 60%/);
		assert.match(err({ models: ["p/a"], threshold: 0 }), /must be a fraction/);
		assert.match(err({ models: ["p/a"], threshold: "0.6" }), /"threshold" must be a number/);
	});

	it("validates thinking against the known levels", () => {
		assert.equal(ok({ models: ["p/a"], thinking: "low" }).thinking, "low");
		assert.match(err({ models: ["p/a"], thinking: "extreme" }), /"thinking" must be one of/);
	});
});

describe("loadConfig", () => {
	it("reports the unconfigured state with both candidate paths", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-cfg-"));
		try {
			const r = loadConfig(dir);
			assert.equal(r.ok, false);
			assert.match(r.error, /no model roster configured/);
			assert.match(r.error, /\.hive-think\.json/);
			// The agent must be told not to retry, or the autopilot loops on it.
			assert.match(r.error, /Do not retry/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loads a project-local config", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-cfg-"));
		try {
			fs.writeFileSync(path.join(dir, ".hive-think.json"), JSON.stringify({ models: ["p/x"], threshold: 0.7 }));
			const r = loadConfig(dir);
			assert.equal(r.ok, true);
			assert.deepEqual(r.config.models, ["p/x"]);
			assert.equal(r.config.thresholdPct, 70);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports a broken project config instead of falling through to the user one", () => {
		// Silently ignoring a config the user clearly meant to use is worse than
		// telling them it is broken.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-cfg-"));
		try {
			fs.writeFileSync(path.join(dir, ".hive-think.json"), "{oops");
			const r = loadConfig(dir);
			assert.equal(r.ok, false);
			assert.match(r.error, /not valid JSON/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("unconfiguredError", () => {
	it("lists every candidate path and a copyable example", () => {
		const msg = unconfiguredError(["/a/.hive-think.json", "/b/hive-think.json"]);
		assert.match(msg, /\/a\/\.hive-think\.json/);
		assert.match(msg, /\/b\/hive-think\.json/);
		assert.match(msg, /"models"/);
	});
});

// ===========================================================================
// aggregation-engine — slugs and parsing
// ===========================================================================

describe("normalizeSlug", () => {
	it("canonicalises so trivial spelling differences merge", () => {
		assert.equal(normalizeSlug("Token File Reread"), "token-file-reread");
		assert.equal(normalizeSlug("--token__file--"), "token-file");
		assert.equal(normalizeSlug("a/b:c"), "a-b-c");
	});

	it("returns empty for input with nothing usable", () => {
		assert.equal(normalizeSlug("!!!"), "");
		assert.equal(normalizeSlug(""), "");
	});

	it("caps length", () => {
		assert.ok(normalizeSlug("x".repeat(200)).length <= 64);
	});
});

describe("extractJsonValue", () => {
	it("parses bare JSON", () => {
		assert.deepEqual(extractJsonValue('[{"a":1}]'), [{ a: 1 }]);
	});

	it("parses a fenced block", () => {
		assert.deepEqual(extractJsonValue('prose\n```json\n[{"a":1}]\n```\nmore'), [{ a: 1 }]);
	});

	it("parses an unlabelled fence", () => {
		assert.deepEqual(extractJsonValue("```\n{\"a\":1}\n```"), { a: 1 });
	});

	it("finds a structure embedded in prose", () => {
		assert.deepEqual(extractJsonValue('Here you go: [{"a":1}] — done'), [{ a: 1 }]);
	});

	it("returns undefined when nothing parses", () => {
		assert.equal(extractJsonValue("no json here"), undefined);
		assert.equal(extractJsonValue(""), undefined);
		assert.equal(extractJsonValue("[unclosed"), undefined);
	});
});

describe("parsePropositions", () => {
	it("reads the documented shape", () => {
		const out = parsePropositions('[{"slug":"a-b","statement":"S","evidence":"f.ts:1","level":3}]');
		assert.deepEqual(out, [{ slug: "a-b", statement: "S", evidence: "f.ts:1", level: 3 }]);
	});

	it("accepts an array under an envelope key", () => {
		const out = parsePropositions('{"problems":[{"slug":"a","statement":"S","level":1}]}');
		assert.equal(out.length, 1);
	});

	it("derives a slug from the statement when none is given", () => {
		assert.equal(parsePropositions('[{"statement":"Token File Reread"}]')[0].slug, "token-file-reread");
	});

	it("defaults level to 1 and clamps it to 1-3", () => {
		assert.equal(parsePropositions('[{"slug":"a","statement":"S"}]')[0].level, 1);
		assert.equal(parsePropositions('[{"slug":"a","statement":"S","level":9}]')[0].level, 3);
		assert.equal(parsePropositions('[{"slug":"a","statement":"S","level":0}]')[0].level, 1);
	});

	it("drops entries that assert nothing", () => {
		assert.deepEqual(parsePropositions('[{"slug":"a"},{"statement":"   "}]'), []);
	});

	it("returns empty rather than throwing on garbage", () => {
		assert.deepEqual(parsePropositions("not json"), []);
	});
});

describe("parseSolutions", () => {
	it("reads addresses and normalises the mutex group", () => {
		const out = parseSolutions('[{"slug":"s1","addresses":["A B","c"],"summary":"do it","mutexGroup":"Storage Choice"}]');
		assert.deepEqual(out, [{ slug: "s1", addresses: ["a-b", "c"], summary: "do it", mutexGroup: "storage-choice" }]);
	});

	it("leaves mutexGroup absent for an independent solution", () => {
		assert.equal("mutexGroup" in parseSolutions('[{"slug":"s","summary":"x"}]')[0], false);
	});

	it("tolerates a missing addresses field", () => {
		assert.deepEqual(parseSolutions('[{"slug":"s","summary":"x"}]')[0].addresses, []);
	});
});

describe("parseBallots", () => {
	it("accepts the documented yes/no strings", () => {
		assert.deepEqual(parseBallots('[{"slug":"a","vote":"yes"},{"slug":"b","vote":"no"}]'), [
			{ slug: "a", vote: true },
			{ slug: "b", vote: false },
		]);
	});

	it("accepts booleans and common synonyms", () => {
		const out = parseBallots('[{"slug":"a","vote":true},{"slug":"b","verdict":"UP"},{"slug":"c","verdict":"DOWN"}]');
		assert.deepEqual(out.map((b) => b.vote), [true, true, false]);
	});

	it("treats an unrecognised verdict as an abstention, not a guess", () => {
		assert.deepEqual(parseBallots('[{"slug":"a","vote":"maybe"},{"slug":"b","vote":7}]'), []);
	});

	it("keeps the reason when supplied", () => {
		assert.equal(parseBallots('[{"slug":"a","vote":"yes","reason":"checked"}]')[0].reason, "checked");
	});
});

// ===========================================================================
// aggregation-engine — merge
// ===========================================================================

describe("mergePropositions", () => {
	it("counts each node once even if it restates an item", () => {
		// Otherwise one verbose node manufactures consensus on its own.
		const merged = mergePropositions([
			[
				{ slug: "a", statement: "S", level: 1 },
				{ slug: "a", statement: "S again", level: 1 },
				{ slug: "a", statement: "S more", level: 1 },
			],
		]);
		assert.equal(merged.length, 1);
		assert.equal(merged[0].proposedBy, 1);
	});

	it("accumulates proposedBy across distinct nodes", () => {
		const merged = mergePropositions([
			[{ slug: "a", statement: "S", level: 1 }],
			[{ slug: "a", statement: "S", level: 1 }],
			[{ slug: "b", statement: "T", level: 1 }],
		]);
		assert.equal(merged.find((m) => m.slug === "a").proposedBy, 2);
		assert.equal(merged.find((m) => m.slug === "b").proposedBy, 1);
	});

	it("keeps the deeper decomposition of the same slug", () => {
		const merged = mergePropositions([
			[{ slug: "a", statement: "shallow", level: 1 }],
			[{ slug: "a", statement: "deep", evidence: "f.ts:9", level: 3 }],
		]);
		assert.equal(merged[0].statement, "deep");
		assert.equal(merged[0].level, 3);
		assert.equal(merged[0].evidence, "f.ts:9");
	});

	it("keeps evidence from a shallower node when the deeper one had none", () => {
		const merged = mergePropositions([
			[{ slug: "a", statement: "deep", level: 3 }],
			[{ slug: "a", statement: "shallow", evidence: "f.ts:1", level: 1 }],
		]);
		assert.equal(merged[0].statement, "deep");
		assert.equal(merged[0].evidence, "f.ts:1");
	});

	it("orders by support then depth", () => {
		const merged = mergePropositions([
			[{ slug: "lonely", statement: "x", level: 3 }],
			[{ slug: "popular", statement: "y", level: 1 }],
			[{ slug: "popular", statement: "y", level: 1 }],
		]);
		assert.equal(merged[0].slug, "popular");
	});
});

// ===========================================================================
// aggregation-engine — vote math
// ===========================================================================

describe("minVotesFor", () => {
	it("matches the documented effective-threshold table at 60%", () => {
		// The effective bar is chunky with integer ballots and is reported per item
		// precisely because it drifts from the nominal 60%.
		assert.deepEqual(
			[3, 4, 5, 6, 7, 8, 9, 10].map((n) => minVotesFor(n, 60)),
			[2, 3, 3, 4, 5, 5, 6, 6],
		);
	});

	it("matches the table at 65% and 70%", () => {
		assert.deepEqual(
			[3, 4, 5, 6, 7, 8, 9, 10].map((n) => minVotesFor(n, 65)),
			[2, 3, 4, 4, 5, 6, 6, 7],
		);
		assert.deepEqual(
			[3, 4, 5, 6, 7, 8, 9, 10].map((n) => minVotesFor(n, 70)),
			[3, 3, 4, 5, 5, 6, 7, 7],
		);
	});

	it("is exact where floating point ceil is not", () => {
		// Math.ceil(3 * 0.6) works only because 3 * 0.6 is 1.7999999999999998 and
		// rounds up anyway; integer arithmetic does not depend on that luck.
		for (let pct = 1; pct <= 100; pct++) {
			for (let n = 1; n <= 10; n++) {
				const got = minVotesFor(n, pct);
				assert.ok(got * 100 >= n * pct, `${got}/${n} below ${pct}%`);
				assert.ok((got - 1) * 100 < n * pct, `${got}/${n} not minimal at ${pct}%`);
			}
		}
	});

	it("is 0 for no voters", () => {
		assert.equal(minVotesFor(0, 60), 0);
	});
});

describe("tallyItem", () => {
	it("passes at or above the bar and reports the actual numbers", () => {
		const t = tallyItem("a", 3, 1, 4, 60);
		assert.equal(t.pass, true);
		assert.equal(t.voters, 4);
		assert.equal(t.actualPct, 75);
		assert.equal(t.minVotes, 3);
		assert.equal(t.effectivePct, 75);
	});

	it("fails below the bar", () => {
		assert.equal(tallyItem("a", 2, 2, 4, 60).pass, false);
	});

	it("counts participants who skipped the item as abstentions", () => {
		const t = tallyItem("a", 3, 1, 6, 60);
		assert.equal(t.abstain, 2);
		assert.equal(t.voters, 4);
	});

	it("refuses to pass on fewer voters than the floor", () => {
		// 2/2 is 100% support and means nothing.
		const t = tallyItem("a", 2, 0, 2, 60, 5);
		assert.equal(t.actualPct, 100);
		assert.equal(t.pass, false);
	});

	it("measures the floor against dispatched nodes, not survivors", () => {
		// Deriving it from participants would relax the floor exactly when nodes die.
		assert.equal(tallyItem("a", 2, 0, 2, 60, 4).pass, false);
		// A round that was deliberately small is a different matter.
		assert.equal(tallyItem("a", 2, 0, 2, 60, 2).pass, true);
	});

	it("does not pass with no votes at all", () => {
		assert.equal(tallyItem("a", 0, 0, 5, 60).pass, false);
		assert.equal(tallyItem("a", 0, 0, 5, 60).actualPct, 0);
	});
});

describe("tallyBallots", () => {
	const ballot = (slug, vote) => ({ slug, vote });

	it("counts one vote per node however often it repeats itself", () => {
		const t = tallyBallots(
			[
				[ballot("a", true), ballot("a", true), ballot("a", true)],
				[ballot("a", false)],
				[ballot("a", false)],
				[ballot("a", false)],
			],
			["a"],
			60,
		);
		assert.equal(t.get("a").yes, 1);
		assert.equal(t.get("a").no, 3);
		assert.equal(t.get("a").pass, false);
	});

	it("excludes nodes that produced nothing from the denominator", () => {
		// A crashed node is not a dissenting vote.
		const t = tallyBallots([[ballot("a", true)], [ballot("a", true)], [ballot("a", false)], []], ["a"], 60);
		assert.equal(t.get("a").voters, 3);
		assert.equal(t.get("a").yes, 2);
	});

	it("still blocks a pass when too few nodes survived", () => {
		const t = tallyBallots([[ballot("a", true)], [ballot("a", true)], [], []], ["a"], 60);
		assert.equal(t.get("a").actualPct, 100);
		assert.equal(t.get("a").pass, false);
	});

	it("ignores votes for slugs that are not on the ballot", () => {
		const t = tallyBallots([[ballot("a", true), ballot("ghost", true)]], ["a"], 60);
		assert.equal(t.size, 1);
		assert.equal(t.get("a").yes, 1);
	});

	it("returns a tally for every candidate, including unvoted ones", () => {
		const t = tallyBallots([[ballot("a", true)]], ["a", "b"], 60);
		assert.equal(t.get("b").voters, 0);
		assert.equal(t.get("b").pass, false);
	});

	it("handles a round in which nothing came back", () => {
		const t = tallyBallots([[], [], []], ["a"], 60);
		assert.equal(t.get("a").voters, 0);
		assert.equal(t.get("a").pass, false);
	});
});

describe("tallyMutexGroups", () => {
	const solutions = [
		{ slug: "redis", addresses: [], summary: "r", mutexGroup: "storage" },
		{ slug: "kafka", addresses: [], summary: "k", mutexGroup: "storage" },
		{ slug: "nothing", addresses: [], summary: "n", mutexGroup: "storage" },
		{ slug: "index", addresses: [], summary: "i" },
	];

	const talliesFrom = (counts, participants = 14) =>
		new Map(Object.entries(counts).map(([slug, yes]) => [slug, tallyItem(slug, yes, participants - yes, participants, 60)]));

	it("picks the relative majority even when nothing clears the threshold", () => {
		// 6:5:3 leaves every option under 60%, which is the case an independent
		// threshold cannot resolve.
		const groups = tallyMutexGroups(solutions, talliesFrom({ redis: 6, kafka: 5, nothing: 3 }));
		assert.equal(groups.length, 1);
		assert.equal(groups[0].group, "storage");
		assert.equal(groups[0].tied, false);
		assert.equal(groups[0].leader.slug, "redis");
		assert.deepEqual(groups[0].ranked.map((t) => t.slug), ["redis", "kafka", "nothing"]);
	});

	it("reports a tie rather than breaking it arbitrarily", () => {
		const groups = tallyMutexGroups(solutions, talliesFrom({ redis: 5, kafka: 5, nothing: 3 }));
		assert.equal(groups[0].tied, true);
		assert.equal(groups[0].leader, undefined);
	});

	it("leaves independent solutions out of every group", () => {
		const groups = tallyMutexGroups(solutions, talliesFrom({ redis: 6, kafka: 5, nothing: 3, index: 9 }));
		assert.equal(groups.length, 1);
		assert.equal(groups[0].ranked.some((t) => t.slug === "index"), false);
	});

	it("skips group members with no tally", () => {
		const groups = tallyMutexGroups(solutions, talliesFrom({ redis: 6 }));
		assert.equal(groups[0].ranked.length, 1);
	});
});

describe("independentSolutions", () => {
	it("selects exactly the ungrouped ones", () => {
		const out = independentSolutions([
			{ slug: "a", addresses: [], summary: "", mutexGroup: "g" },
			{ slug: "b", addresses: [], summary: "" },
		]);
		assert.deepEqual(out.map((s) => s.slug), ["b"]);
	});
});

// ===========================================================================
// aggregation-engine — fan-out and selection
// ===========================================================================

describe("decideNodeCount", () => {
	it("runs the floor when decomposition found nothing", () => {
		const d = decideNodeCount(0, 1, 3, 10);
		assert.equal(d.nodes, 3);
		assert.match(d.rationale, /no propositions/);
	});

	it("scales with the number of distinct problems", () => {
		assert.equal(decideNodeCount(1, 1, 3, 10).nodes, 3);
		assert.equal(decideNodeCount(4, 1, 3, 10).nodes, 4);
		assert.equal(decideNodeCount(8, 1, 3, 10).nodes, 6);
	});

	it("adds width for a deeper decomposition", () => {
		assert.ok(decideNodeCount(4, 3, 3, 10).nodes > decideNodeCount(4, 1, 3, 10).nodes);
	});

	it("stays inside the configured bounds and says when it clamped", () => {
		const capped = decideNodeCount(40, 3, 3, 10);
		assert.equal(capped.nodes, 10);
		assert.match(capped.rationale, /capped at 10/);

		const raised = decideNodeCount(1, 1, 6, 10);
		assert.equal(raised.nodes, 6);
		assert.match(raised.rationale, /floor/);
	});

	it("tolerates inverted bounds", () => {
		const d = decideNodeCount(5, 2, 10, 3);
		assert.ok(d.nodes >= 3 && d.nodes <= 10);
	});

	it("never exceeds the ceiling for any plausible input", () => {
		for (let p = 0; p <= 50; p++) {
			for (let l = 1; l <= 3; l++) {
				const n = decideNodeCount(p, l, NODES_FLOOR, NODES_CEILING).nodes;
				assert.ok(n >= NODES_FLOOR && n <= NODES_CEILING, `${p}/${l} gave ${n}`);
			}
		}
	});
});

describe("drawNodes", () => {
	it("repeats the roster round-robin so a small roster still fans out", () => {
		assert.deepEqual(drawNodes(["a", "b"], 5), ["a", "b", "a", "b", "a"]);
	});

	it("truncates when the roster is longer than the draw", () => {
		assert.deepEqual(drawNodes(["a", "b", "c"], 2), ["a", "b"]);
	});

	it("returns nothing for an empty roster or a non-positive count", () => {
		assert.deepEqual(drawNodes([], 3), []);
		assert.deepEqual(drawNodes(["a"], 0), []);
	});
});

// ===========================================================================
// aggregation-engine — formatting
// ===========================================================================

describe("formatVoteLine", () => {
	it("always shows actual support alongside the bar that was applied", () => {
		const line = formatVoteLine("`a` — S", tallyItem("a", 3, 1, 4, 60));
		assert.match(line, /✅/);
		assert.match(line, /3\/4/);
		assert.match(line, /75%/);
		assert.match(line, /needed 3 = 75%/);
	});

	it("marks a failure", () => {
		assert.match(formatVoteLine("x", tallyItem("a", 1, 3, 4, 60)), /❌/);
	});

	it("names abstentions", () => {
		assert.match(formatVoteLine("x", tallyItem("a", 3, 1, 6, 60)), /2 abstained/);
	});

	it("flags a sample too small to mean anything", () => {
		const line = formatVoteLine("x", tallyItem("a", 2, 0, 2, 60, 5));
		assert.match(line, /too few voters/);
		assert.ok(MIN_VOTERS >= 3);
	});
});
