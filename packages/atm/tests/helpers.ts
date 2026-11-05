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

export const hasHledger =
	Bun.spawnSync(["hledger", "--version"], { stdout: "pipe", stderr: "pipe" })
		.exitCode === 0;
export const hasDuckdb =
	Bun.spawnSync(["duckdb", "--version"], { stdout: "pipe", stderr: "pipe" })
		.exitCode === 0;
