import type { AtmEnv } from "../types.js";

const DEFAULT_ENV: AtmEnv = "live";

/** The env an input names, `"live"` when it names none. Throws on anything but `"live"` or `"test"` (plain JavaScript can pass it). */
export const resolveEnv = (env: unknown): AtmEnv => {
	if (env === undefined) return DEFAULT_ENV;
	if (env === "live" || env === "test") return env;
	throw new Error(`env must be "live" or "test", got ${JSON.stringify(env)}`);
};
