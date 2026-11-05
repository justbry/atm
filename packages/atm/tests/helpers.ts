import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const tmp = (name: string) => mkdtemp(join(tmpdir(), `atm-${name}-`));

/** Every file under `dir` as { relative path: text }. */
export const readTree = async (
	dir: string,
	rel = "",
): Promise<Record<string, string>> => {
	const out: Record<string, string> = {};
	for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
		const path = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) Object.assign(out, await readTree(dir, path));
		else out[path] = await readFile(join(dir, path), "utf8");
	}
	return out;
};

/** Whether `command --version` runs. Bun's `spawnSync` throws ENOENT for a binary that is not installed, so a missing tool is caught here and reads as false (a skip), not as an error that fails the suite. */
const runsWithVersion = (command: string): boolean => {
	try {
		return (
			Bun.spawnSync([command, "--version"], { stdout: "pipe", stderr: "pipe" })
				.exitCode === 0
		);
	} catch {
		return false;
	}
};

export const hasHledger = runsWithVersion("hledger");
export const hasDuckdb = runsWithVersion("duckdb");

/** The `weed` binary for the SeaweedFS contract run: env ATM_WEED when it runs, else `weed` on PATH, else null. */
export const weedBinary = (() => {
	const candidates = [process.env.ATM_WEED, "weed"].filter(
		(candidate): candidate is string => Boolean(candidate),
	);
	for (const candidate of candidates) {
		try {
			const result = Bun.spawnSync([candidate, "version"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			if (result.exitCode === 0) return candidate;
		} catch {
			// not an executable: try the next candidate
		}
	}
	return null;
})();
export const hasSeaweedfs = weedBinary !== null;
