/**
 * `bun run test`: every test group in its own bun process. happy-dom's window, document and location are globals of
 * the process, so one process for every file lets a file's leftover state (a hash, an open drawer, a written setting)
 * fail another file's test. A group is a directory under test/ that holds tests, or a test file at test/'s top level;
 * groups are found, not listed, so a new one cannot be left out. Exits 1 when any group fails.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const packageRoot = join(import.meta.dir, "..");
const testRoot = join(packageRoot, "test");
const holdsTests = (directory: string): boolean =>
	readdirSync(directory).some((name) => {
		const path = join(directory, name);
		return statSync(path).isDirectory()
			? holdsTests(path)
			: name.endsWith(".test.ts");
	});
const groups = readdirSync(testRoot)
	.sort()
	.filter((name) => {
		const path = join(testRoot, name);
		return statSync(path).isDirectory()
			? holdsTests(path)
			: name.endsWith(".test.ts");
	})
	.map((name) => `test/${name}`);

const failed: string[] = [];
for (const group of groups) {
	const result = spawnSync("bun", ["test", group], {
		cwd: packageRoot,
		encoding: "utf8",
	});
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	const summary = output
		.split("\n")
		.filter((line) => /^ \d+ (pass|fail|skip)$/.test(line))
		.map((line) => line.trim())
		.join(", ");
	process.stdout.write(`${group}: ${summary || "no summary"}\n`);
	if (result.status !== 0) {
		failed.push(group);
		process.stdout.write(output);
	}
}
process.stdout.write(
	failed.length
		? `test groups failing: ${failed.join(", ")}\n`
		: `all ${groups.length} test groups green\n`,
);
process.exit(failed.length ? 1 : 0);
