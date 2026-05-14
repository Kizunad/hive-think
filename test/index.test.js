/**
 * Tests for hive-think extension
 * Run: node --test test/index.test.js
 *
 * Pure helper functions inlined from extensions/hive-think.ts
 * to avoid pi runtime dependency. Keep in sync when helpers change.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Inlined helpers from index.ts (kept in sync manually)
// ---------------------------------------------------------------------------

function formatTokens(count) {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage) {
	const parts = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	return parts.join(" ");
}

function getFinalOutput(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
			if (msg.errorMessage) return `[Error: ${msg.errorMessage}]`;
		}
	}
	return "";
}

async function mapWithConcurrencyLimit(items, concurrency, fn) {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results = new Array(items.length);
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

// ---------------------------------------------------------------------------
// Constants (verified against index.ts source)
// ---------------------------------------------------------------------------

const DEFAULT_MODELS = [
	"deepseek-v4-pro", "deepseek-v4-pro", "deepseek-v4-pro", "deepseek-v4-pro",
	"deepseek-v4-flash", "deepseek-v4-flash", "deepseek-v4-flash", "deepseek-v4-flash",
];

const ANSWER_END = "</ANSWER>";

// ---------------------------------------------------------------------------
// Param validation (mirrors TypeBox schema: question=String required, others optional)
// ---------------------------------------------------------------------------

function validateParams(params) {
	const errors = [];
	if (!params || typeof params !== "object") {
		return { valid: false, errors: ["params must be an object"] };
	}
	const p = params;

	if (typeof p.question !== "string" || p.question.length === 0) {
		errors.push("question must be a non-empty string");
	}
	if (p.context !== undefined && p.context !== null && typeof p.context !== "string") {
		errors.push("context must be a string if provided");
	}
	if (p.models !== undefined && p.models !== null) {
		if (!Array.isArray(p.models)) {
			errors.push("models must be an array if provided");
		} else if (p.models.some(function (m) { return typeof m !== "string"; })) {
			errors.push("models must contain only strings");
		}
	}
	if (p.cwd !== undefined && p.cwd !== null && typeof p.cwd !== "string") {
		errors.push("cwd must be a string if provided");
	}

	return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("formatTokens", function () {
	it("raw number for values under 1000", function () {
		assert.equal(formatTokens(0), "0");
		assert.equal(formatTokens(1), "1");
		assert.equal(formatTokens(999), "999");
	});
	it("1.0k–9.9k range", function () {
		assert.equal(formatTokens(1000), "1.0k");
		assert.equal(formatTokens(1500), "1.5k");
		assert.equal(formatTokens(9999), "10.0k");
	});
	it("10k–999k range (rounded)", function () {
		assert.equal(formatTokens(10000), "10k");
		assert.equal(formatTokens(12345), "12k");
		assert.equal(formatTokens(999999), "1000k");
	});
	it("1M+ range", function () {
		assert.equal(formatTokens(1000000), "1.0M");
		assert.equal(formatTokens(1500000), "1.5M");
		assert.equal(formatTokens(10000000), "10.0M");
	});
});

describe("formatUsageStats", function () {
	it("complete stats with all fields populated", function () {
		const r = formatUsageStats({
			input: 50000, output: 2000, cacheRead: 12000, cacheWrite: 3000,
			cost: 0.1234, contextTokens: 64000, turns: 3,
		});
		assert.ok(r.includes("3 turns"));
		assert.ok(r.includes("↑50k"));
		assert.ok(r.includes("↓2.0k"));
		assert.ok(r.includes("R12k"));
		assert.ok(r.includes("W3.0k"));
		assert.ok(r.includes("$0.1234"));
		assert.ok(r.includes("ctx:64k"));
	});

	it("single turn (no plural)", function () {
		const r = formatUsageStats({
			input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1,
		});
		assert.ok(r.includes("1 turn"));
		assert.ok(!r.includes("turns"));
	});

	it("omits zero-value fields", function () {
		const r = formatUsageStats({
			input: 0, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0,
		});
		assert.ok(!r.includes("↑"));
		assert.ok(r.includes("↓100"));
	});

	it("omits ctx when contextTokens is 0 or missing", function () {
		assert.ok(!formatUsageStats({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 }).includes("ctx:"));
		assert.ok(!formatUsageStats({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }).includes("ctx:"));
	});
});

describe("getFinalOutput", function () {
	it("last assistant text wins", function () {
		const msgs = [
			{ role: "user", content: [{ type: "text", text: "hello" }] },
			{ role: "assistant", content: [{ type: "text", text: "1st" }] },
			{ role: "assistant", content: [{ type: "text", text: "final" }] },
		];
		assert.equal(getFinalOutput(msgs), "final");
	});

	it("skips non-assistant roles", function () {
		const msgs = [
			{ role: "user", content: [{ type: "text", text: "q" }] },
			{ role: "toolResult", content: [{ type: "text", text: "tool" }] },
			{ role: "assistant", content: [{ type: "text", text: "answer" }] },
		];
		assert.equal(getFinalOutput(msgs), "answer");
	});

	it("empty array", function () {
		assert.equal(getFinalOutput([]), "");
	});

	it("errorMessage fallback", function () {
		const msgs = [{ role: "assistant", content: [], errorMessage: "timeout" }];
		assert.equal(getFinalOutput(msgs), "[Error: timeout]");
	});

	it("no assistant → empty", function () {
		const msgs = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
		assert.equal(getFinalOutput(msgs), "");
	});

	it("error in last assistant overrides prior text", function () {
		const msgs = [
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "assistant", content: [], errorMessage: "rate limited" },
		];
		assert.equal(getFinalOutput(msgs), "[Error: rate limited]");
	});
});

describe("mapWithConcurrencyLimit", function () {
	it("preserves order", async function () {
		const r = await mapWithConcurrencyLimit([10, 20, 30], 2, async function (n, i) { return n * (i + 1); });
		assert.deepEqual(r, [10, 40, 90]);
	});

	it("empty input → empty output", async function () {
		const r = await mapWithConcurrencyLimit([], 2, async function (n) { return n; });
		assert.deepEqual(r, []);
	});

	it("respects concurrency limit", async function () {
		const active = new Set();
		let maxSeen = 0;
		await mapWithConcurrencyLimit([1, 2, 3, 4, 5], 2, async function (n) {
			active.add(n);
			maxSeen = Math.max(maxSeen, active.size);
			await new Promise(function (r2) { setTimeout(r2, 20); });
			active.delete(n);
			return n * 2;
		});
		assert.equal(maxSeen, 2);
	});

	it("clamps concurrency to item count", async function () {
		let maxSeen = 0;
		const active = new Set();
		await mapWithConcurrencyLimit([1, 2], 100, async function (n) {
			active.add(n);
			maxSeen = Math.max(maxSeen, active.size);
			await new Promise(function (r2) { setTimeout(r2, 10); });
			active.delete(n);
			return n;
		});
		assert.ok(maxSeen <= 2);
	});
});

describe("DEFAULT_MODELS", function () {
	it("exactly 8 models", function () {
		assert.equal(DEFAULT_MODELS.length, 8);
	});

	it("4 deepseek-v4-pro + 4 deepseek-v4-flash", function () {
		const pro = DEFAULT_MODELS.filter(function (m) { return m === "deepseek-v4-pro"; });
		const flash = DEFAULT_MODELS.filter(function (m) { return m === "deepseek-v4-flash"; });
		assert.equal(pro.length, 4);
		assert.equal(flash.length, 4);
	});

	it("no gpt/gemini/gemma", function () {
		for (const m of DEFAULT_MODELS) {
			assert.ok(!m.includes("gpt"), m + " contains gpt");
			assert.ok(!m.includes("gemini"), m + " contains gemini");
			assert.ok(!m.includes("gemma"), m + " contains gemma");
		}
	});
});

describe("ANSWER_END", function () {
	it("is exact closing XML tag", function () {
		assert.equal(ANSWER_END, "</ANSWER>");
	});
});

describe("Param validation", function () {
	it("accepts question only", function () {
		assert.ok(validateParams({ question: "What is 1+1?" }).valid);
	});

	it("accepts full params", function () {
		assert.ok(validateParams({
			question: "Should we use X or Y?",
			context: "some context",
			models: ["deepseek-v4-pro", "deepseek-v4-flash"],
			cwd: "/tmp",
		}).valid);
	});

	it("rejects missing question", function () {
		assert.equal(validateParams({}).valid, false);
	});

	it("rejects null question", function () {
		assert.equal(validateParams({ question: null }).valid, false);
	});

	it("rejects non-string question", function () {
		assert.equal(validateParams({ question: 42 }).valid, false);
	});

	it("rejects non-array models", function () {
		assert.equal(validateParams({ question: "test", models: "bad" }).valid, false);
	});

	it("rejects models array with numbers", function () {
		assert.equal(validateParams({ question: "test", models: [1, 2] }).valid, false);
	});

	it("accepts single-element models array", function () {
		assert.ok(validateParams({ question: "test", models: ["deepseek-v4-pro"] }).valid);
	});

	it("rejects non-string context", function () {
		assert.equal(validateParams({ question: "test", context: 123 }).valid, false);
	});

	it("rejects non-string cwd", function () {
		assert.equal(validateParams({ question: "test", cwd: 123 }).valid, false);
	});
});
