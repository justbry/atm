import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeCheck } from "@autumn/balance-engine";
import {
	createCheckCommand,
	createState,
	createSubjectFor,
} from "../../balance-engine/tests/unit/engineFixtures.js";
import {
	digests,
	exportedNames,
	listTarball,
	PACKAGE_FILES,
	pack,
	publishManifest,
	publishReadme,
	stage,
} from "../release.js";
import type { AtmCatalogRow, GrantCommand } from "../src/index.js";
import {
	DEFAULT_POLICY,
	EMPTY_GRANTS_STATE,
	invoiceToCommands,
	menuCatalogRows,
	runOnState,
	validateMenu,
} from "../src/index.js";

/** No network: the tarball is built, packed and installed from disk, as the family service would install it. */
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const root = join(import.meta.dir, "../../..");
const { version } = JSON.parse(
	readFileSync(join(import.meta.dir, "../package.json"), "utf8"),
) as { version: string };
const grantsDir = join(import.meta.dir, "../fixtures/billing/grants");
const fixture = (name: string) =>
	JSON.parse(readFileSync(join(grantsDir, `${name}.json`), "utf8"));

let work: string;
let distDir: string;
let tarball: string;

/** What a consumer script computes with the library: the same three calls, from the same input files. */
const consume = (lib: {
	runEngineCommand: (input: unknown) => unknown;
	validateMenu: (input: unknown) => { ok: boolean };
	invoiceToCommands: (input: never) => { commands: GrantCommand[] };
	runOnState: (input: never) => {
		state: { customerEntitlements: { id: string; balance: number }[] } | null;
	};
	menuCatalogRows: (input: never) => AtmCatalogRow[];
	DEFAULT_POLICY: unknown;
	EMPTY_GRANTS_STATE: unknown;
}) => {
	const command = createCheckCommand();
	const subject = createSubjectFor({
		state: createState(),
		entityId: command.identity.entityId,
	});
	const menu = fixture("menu");
	const invoice = fixture("inv-create-s2");
	const catalog = lib.menuCatalogRows({ menu, school: "sch_vol" } as never);
	const result = lib.invoiceToCommands({
		invoice,
		menu,
		policy: lib.DEFAULT_POLICY,
		state: lib.EMPTY_GRANTS_STATE,
		now: invoice.paidAt,
		menuVersion: 3,
		policyVersion: 1,
	} as never);
	let state: ReturnType<typeof lib.runOnState>["state"] = null;
	for (const c of result.commands)
		state = lib.runOnState({ state, catalog, command: c } as never).state;
	return {
		engine: JSON.parse(
			JSON.stringify(lib.runEngineCommand({ subject, command })),
		),
		menuOk: lib.validateMenu(menu).ok,
		commands: result.commands.map((c) => c.type),
		rows: state?.customerEntitlements.map(
			(r: { id: string; balance: number }) => [r.id, r.balance],
		),
	};
};

beforeAll(async () => {
	work = mkdtempSync(join(tmpdir(), "atm-release-test-"));
	distDir = join(work, "dist");
	const build = Bun.spawnSync([
		"bun",
		join(import.meta.dir, "../build.ts"),
		distDir,
	]);
	if (build.exitCode !== 0) throw new Error(build.stderr.toString());
	const stageDir = join(work, "stage");
	stage({ distDir, stageDir, version, commit: COMMIT });
	tarball = pack({ stageDir, outDir: join(work, "out"), version });
}, 120_000);

describe("the publish package.json", () => {
	test("has exactly the fields B4 Uni's install needs, in this order", () => {
		const manifest = publishManifest("1.2.3");
		expect(Object.keys(manifest)).toEqual([
			"name",
			"version",
			"license",
			"repository",
			"type",
			"main",
			"types",
			"exports",
			"files",
			"sideEffects",
		]);
		expect(manifest).toEqual({
			name: "atm",
			version: "1.2.3",
			license: "Apache-2.0",
			repository: {
				type: "git",
				url: "git+https://github.com/justbry/atm.git",
				directory: "packages/atm",
			},
			type: "module",
			main: "./dist/index.js",
			types: "./dist/index.d.ts",
			exports: {
				".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
			},
			files: ["dist"],
			sideEffects: false,
		});
	});

	test("the workspace package stays private and its version is semver", () => {
		const own = JSON.parse(
			readFileSync(join(import.meta.dir, "../package.json"), "utf8"),
		);
		expect(own.private).toBe(true);
		expect(own.version).toMatch(/^\d+\.\d+\.\d+/);
		expect(own.scripts.release).toBe("bun ./release.ts");
	});

	test("the staged package.json is that manifest at the workspace version", () => {
		const out = Bun.spawnSync(
			["tar", "-xzOf", tarball, "package/package.json"],
			{
				stdout: "pipe",
			},
		);
		expect(JSON.parse(out.stdout.toString())).toEqual(publishManifest(version));
	});
});

describe("the tarball", () => {
	test("holds exactly the six files, and the LICENSE is the repo's", () => {
		expect(listTarball(tarball)).toEqual([...PACKAGE_FILES]);
		const license = Bun.spawnSync(
			["tar", "-xzOf", tarball, "package/LICENSE"],
			{
				stdout: "pipe",
			},
		);
		expect(license.stdout.toString()).toBe(
			readFileSync(join(root, "LICENSE"), "utf8"),
		);
	});

	test("the README names the source commit and upstream", () => {
		const out = Bun.spawnSync(["tar", "-xzOf", tarball, "package/README.md"], {
			stdout: "pipe",
		});
		const text = out.stdout.toString();
		expect(text).toBe(publishReadme({ version, commit: COMMIT }));
		expect(text).toContain(COMMIT);
		expect(text).toContain("sidgaikwad/autumn");
	});

	test("two packs of the same build have the same sha256 and integrity", () => {
		const again = join(work, "stage-again");
		stage({ distDir, stageDir: again, version, commit: COMMIT });
		const second = pack({
			stageDir: again,
			outDir: join(work, "out-again"),
			version,
		});
		expect(digests(second)).toEqual(digests(tarball));
		expect(digests(tarball).integrity).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
		expect(digests(tarball).sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	test("another commit is another tarball", () => {
		const other = join(work, "stage-other");
		stage({ distDir, stageDir: other, version, commit: "f".repeat(40) });
		const packed = pack({
			stageDir: other,
			outDir: join(work, "out-other"),
			version,
		});
		expect(digests(packed).sha256).not.toBe(digests(tarball).sha256);
	});

	test("installed into an empty directory it runs the engine, validateMenu and invoice -> runOnState, under Bun and Node", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atm-install-"));
		await writeFile(
			join(dir, "package.json"),
			JSON.stringify({ name: "consumer", private: true, type: "module" }),
		);
		const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? dir };
		const add = Bun.spawnSync(["bun", "add", tarball], { cwd: dir, env });
		if (add.exitCode !== 0) throw new Error(add.stderr.toString());
		const command = createCheckCommand();
		const subject = createSubjectFor({
			state: createState(),
			entityId: command.identity.entityId,
		});
		await writeFile(join(dir, "subject.json"), JSON.stringify(subject));
		await writeFile(join(dir, "command.json"), JSON.stringify(command));
		await writeFile(join(dir, "menu.json"), JSON.stringify(fixture("menu")));
		await writeFile(
			join(dir, "invoice.json"),
			JSON.stringify(fixture("inv-create-s2")),
		);
		await writeFile(
			join(dir, "consumer.mjs"),
			[
				'import { readFileSync } from "node:fs";',
				'import * as lib from "atm";',
				'const read = (f) => JSON.parse(readFileSync(f, "utf8"));',
				'const subject = read("subject.json"), command = read("command.json"), menu = read("menu.json"), invoice = read("invoice.json");',
				'const catalog = lib.menuCatalogRows({ menu, school: "sch_vol" });',
				"const result = lib.invoiceToCommands({ invoice, menu, policy: lib.DEFAULT_POLICY, state: lib.EMPTY_GRANTS_STATE, now: invoice.paidAt, menuVersion: 3, policyVersion: 1 });",
				"let state = null;",
				"for (const c of result.commands) state = lib.runOnState({ state, catalog, command: c }).state;",
				"console.log(JSON.stringify({",
				"  engine: JSON.parse(JSON.stringify(lib.runEngineCommand({ subject, command }))),",
				"  menuOk: lib.validateMenu(menu).ok,",
				"  commands: result.commands.map((c) => c.type),",
				"  rows: state.customerEntitlements.map((r) => [r.id, r.balance]),",
				"}));",
			].join("\n"),
		);
		const expected = consume({
			runEngineCommand: (i) =>
				computeCheck({
					fullSubject: (i as { subject: never }).subject,
					command: (i as { command: never }).command,
				}),
			validateMenu,
			invoiceToCommands: invoiceToCommands as never,
			runOnState: runOnState as never,
			menuCatalogRows: menuCatalogRows as never,
			DEFAULT_POLICY,
			EMPTY_GRANTS_STATE,
		});
		expect(expected.menuOk).toBe(true);
		expect(expected.commands).toEqual(["applyBillingPlan"]);
		for (const runtime of ["bun", "node"]) {
			const out = Bun.spawnSync([runtime, "consumer.mjs"], { cwd: dir, env });
			if (out.exitCode !== 0)
				throw new Error(`${runtime}: ${out.stderr.toString()}`);
			expect(JSON.parse(out.stdout.toString())).toEqual(expected);
		}
	}, 120_000);
});

describe("the exported names in the release notes", () => {
	test("are read from the built declarations", () => {
		const api = exportedNames({
			index: readFileSync(join(distDir, "index.d.ts"), "utf8"),
			types: readFileSync(join(distDir, "types.d.ts"), "utf8"),
		});
		for (const name of [
			"runEngineCommand",
			"handleStripeEvent",
			"invoiceToCommands",
			"validateMenu",
		])
			expect(api.values).toContain(name);
		expect(api.typeCount).toBeGreaterThan(40);
	});
});
