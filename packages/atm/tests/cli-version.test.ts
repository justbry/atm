import { expect, test } from "bun:test";
import packageJson from "../package.json";
import { program } from "../src/cli.js";
import { invokedCommandName } from "../src/command-name.js";

const BIN = `${import.meta.dir}/../src/bin.ts`;

test("--version is the package's version", () => {
	expect(program.version()).toBe(packageJson.version);
});

test("the command is named for how it was invoked: atm only when run as atm, tfd otherwise", () => {
	expect(invokedCommandName("atm")).toBe("atm");
	expect(invokedCommandName("atm.js")).toBe("atm");
	expect(invokedCommandName("/repo/node_modules/.bin/atm")).toBe("atm");
	expect(invokedCommandName("/usr/local/bin/tfd")).toBe("tfd");
	expect(invokedCommandName("tfd")).toBe("tfd");
	expect(invokedCommandName("/repo/packages/atm/src/bin.ts")).toBe("tfd");
	expect(invokedCommandName("cli")).toBe("tfd");
	expect(invokedCommandName("/path/to/atm-tools/bin.ts")).toBe("tfd");
	expect(invokedCommandName(undefined)).toBe("tfd");
	expect(invokedCommandName("")).toBe("tfd");
});

test("--help names tfd and says atm is the same command", () => {
	const run = Bun.spawnSync(["bun", BIN, "--help"]);
	const help = run.stdout.toString().replace(/\s+/g, " ");
	expect(run.exitCode).toBe(0);
	expect(help).toContain("Usage: tfd ");
	expect(help).toContain("`atm` is the same command");
	expect(program.name()).toBe("tfd");
});
