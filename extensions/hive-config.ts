/**
 * Hive Think — model configuration
 *
 * There are deliberately no built-in model defaults. A hive node is spawned as
 * `pi --model <id>`, and the provider-qualified ids a real hive needs
 * (`provider/model`) only resolve inside one particular pi installation — so any
 * shipped list is one person's setup and breaks on everyone else's machine. The
 * model roster is a JSON file the user owns; an unconfigured hive reports how to
 * set itself up instead of guessing.
 *
 * Zero pi dependencies: `parseConfig` is directly testable with `node --test`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const THINKING_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * Bounds on the dynamic fan-out. Below 3 there is no consensus to speak of;
 * above 10 the five-stage pipeline costs more than the decision it informs.
 */
export const NODES_FLOOR = 3;
export const NODES_CEILING = 10;

/**
 * Default vote threshold, as an integer percentage.
 *
 * Kept integral on purpose: vote math is `yes * 100 >= total * pct`, so it never
 * touches a float. `Math.ceil(n * 0.6)` is not safe here — `3 * 0.6` is
 * 1.7999999999999998 — and an off-by-one in the minimum vote count silently
 * moves the real threshold a whole notch.
 *
 * 60 rather than 65 because integer vote counts make the *effective* threshold
 * jump around with N, and 65 overshoots the intended 60-70% band badly:
 *
 *   N     3     4     5     6     7     8     9    10
 *   @60  67%   75%   60%   67%   71%  62%   67%   60%
 *   @65  67%   75%   80%   67%   71%  75%   67%   70%
 *
 * N=4 (3/4 = 75%) is inherent to small integer ballots and cannot be tuned away,
 * which is why every vote is reported with its actual count and percentage.
 */
export const DEFAULT_THRESHOLD_PCT = 60;

export const DEFAULT_THINKING: ThinkingLevel = "xhigh";

export const PROJECT_CONFIG_BASENAME = ".hive-think.json";
export const USER_CONFIG_BASENAME = "hive-think.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HiveConfig {
	/**
	 * Flat model roster. No strong/fast tiers: consensus does the arbitrating, so
	 * no node holds a privileged role and no entry has to be a specific tier.
	 * Fewer entries than nodes is fine — the pipeline draws nodes round-robin, so
	 * a 2-model roster still fans out to 10 nodes.
	 */
	models: string[];
	minNodes: number;
	maxNodes: number;
	/** Integer percentage, 1-100. See DEFAULT_THRESHOLD_PCT. */
	thresholdPct: number;
	thinking: ThinkingLevel;
	/** Absolute path it was loaded from, echoed back in tool output. */
	source: string;
}

export type ConfigResult = { ok: true; config: HiveConfig } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Where a config may live, most specific first. Project-local wins so a repo can
 * pin a roster for everyone working in it.
 */
export function configSearchPaths(
	cwd: string,
	env: Record<string, string | undefined> = process.env,
	homedir: string = os.homedir(),
): string[] {
	const xdg = env.XDG_CONFIG_HOME?.trim();
	const configHome = xdg && xdg.length > 0 ? xdg : path.join(homedir, ".config");
	return [path.join(cwd, PROJECT_CONFIG_BASENAME), path.join(configHome, "pi", USER_CONFIG_BASENAME)];
}

// ---------------------------------------------------------------------------
// Parsing & validation
// ---------------------------------------------------------------------------

function fail(source: string, detail: string): ConfigResult {
	return { ok: false, error: `hive-think config at ${source} is invalid: ${detail}` };
}

/**
 * Parse and validate raw config text. Every rejection names the offending field
 * so the message is actionable without opening the source.
 */
export function parseConfig(raw: string, source: string): ConfigResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return fail(source, `not valid JSON (${err instanceof Error ? err.message : String(err)})`);
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return fail(source, "top level must be a JSON object");
	}
	const obj = parsed as Record<string, unknown>;

	// --- models (required) ---
	if (!("models" in obj)) return fail(source, `missing required "models" array`);
	if (!Array.isArray(obj.models)) return fail(source, `"models" must be an array of model id strings`);
	const models: string[] = [];
	for (const [i, entry] of obj.models.entries()) {
		if (typeof entry !== "string") {
			return fail(source, `"models[${i}]" must be a string, got ${entry === null ? "null" : typeof entry}`);
		}
		const trimmed = entry.trim();
		// Reject rather than skip: a blank entry is a typo, and silently dropping it
		// would change the roster size without saying so.
		if (!trimmed) return fail(source, `"models[${i}]" is empty`);
		models.push(trimmed);
	}
	if (models.length === 0) return fail(source, `"models" is empty — list at least one model id`);

	// --- nodes (optional) ---
	let minNodes = NODES_FLOOR;
	let maxNodes = NODES_CEILING;
	if (obj.nodes !== undefined) {
		if (!obj.nodes || typeof obj.nodes !== "object" || Array.isArray(obj.nodes)) {
			return fail(source, `"nodes" must be an object like { "min": 3, "max": 10 }`);
		}
		const nodes = obj.nodes as Record<string, unknown>;
		for (const key of ["min", "max"] as const) {
			const value = nodes[key];
			if (value === undefined) continue;
			if (typeof value !== "number" || !Number.isInteger(value)) {
				return fail(source, `"nodes.${key}" must be an integer`);
			}
			if (value < NODES_FLOOR || value > NODES_CEILING) {
				return fail(source, `"nodes.${key}" must be between ${NODES_FLOOR} and ${NODES_CEILING}, got ${value}`);
			}
			if (key === "min") minNodes = value;
			else maxNodes = value;
		}
		if (minNodes > maxNodes) {
			return fail(source, `"nodes.min" (${minNodes}) exceeds "nodes.max" (${maxNodes})`);
		}
	}

	// --- threshold (optional) ---
	let thresholdPct = DEFAULT_THRESHOLD_PCT;
	if (obj.threshold !== undefined) {
		const value = obj.threshold;
		if (typeof value !== "number" || !Number.isFinite(value)) {
			return fail(source, `"threshold" must be a number`);
		}
		// A fraction, not a percentage — "60" is a common mistake worth naming.
		if (value <= 0 || value > 1) {
			return fail(source, `"threshold" must be a fraction in (0, 1] — write 0.6 for 60%, got ${value}`);
		}
		// Sub-percent precision is meaningless against at most 10 ballots.
		thresholdPct = Math.round(value * 100);
	}

	// --- thinking (optional) ---
	let thinking: ThinkingLevel = DEFAULT_THINKING;
	if (obj.thinking !== undefined) {
		if (typeof obj.thinking !== "string" || !(THINKING_LEVELS as readonly string[]).includes(obj.thinking)) {
			return fail(source, `"thinking" must be one of ${THINKING_LEVELS.join(", ")}`);
		}
		thinking = obj.thinking as ThinkingLevel;
	}

	return { ok: true, config: { models, minNodes, maxNodes, thresholdPct, thinking, source } };
}

// ---------------------------------------------------------------------------
// Unconfigured state
// ---------------------------------------------------------------------------

/**
 * Returned in-session when no config exists. Written for whoever has to act on
 * it: the calling agent should relay it and stop, not retry.
 */
export function unconfiguredError(searchPaths: string[]): string {
	return [
		"hive_think has no model roster configured, so it cannot run.",
		"",
		"This is expected on a fresh install: hive-think ships no default models, because",
		"provider-qualified model ids only resolve inside your own pi installation.",
		"",
		"Create one of these files:",
		...searchPaths.map((p) => `  ${p}`),
		"",
		"Minimal contents — list the pi model ids you want the hive to draw nodes from:",
		"",
		"  {",
		'    "models": ["provider/model-a", "provider/model-b", "provider/model-c"]',
		"  }",
		"",
		"Optional keys:",
		`  "nodes":     { "min": ${NODES_FLOOR}, "max": ${NODES_CEILING} }   how far the pipeline may fan out`,
		`  "threshold": ${DEFAULT_THRESHOLD_PCT / 100}                    vote fraction required to pass a stage`,
		`  "thinking":  "${DEFAULT_THINKING}"               reasoning depth per node`,
		"",
		"Run `pi models` to see which ids your installation resolves.",
		"",
		"Do not retry hive_think until a config exists — proceed with your own analysis instead.",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Filesystem load
// ---------------------------------------------------------------------------

/**
 * Load the first config found. A present-but-broken file is an error rather than
 * a reason to fall through to the next path — silently ignoring a config the user
 * clearly meant to use is worse than saying it is broken.
 */
export function loadConfig(cwd: string): ConfigResult {
	const searchPaths = configSearchPaths(cwd);
	for (const candidate of searchPaths) {
		let raw: string;
		try {
			raw = fs.readFileSync(candidate, "utf-8");
		} catch {
			continue; // missing or unreadable — try the next location
		}
		return parseConfig(raw, candidate);
	}
	return { ok: false, error: unconfiguredError(searchPaths) };
}
