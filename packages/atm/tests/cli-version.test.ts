import { expect, test } from "bun:test";
import packageJson from "../package.json";
import { program } from "../src/cli.js";

test("atm --version is the package's version", () => {
	expect(program.version()).toBe(packageJson.version);
});
