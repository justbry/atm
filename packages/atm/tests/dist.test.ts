import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeCheck } from "@autumn/balance-engine";
import {
	createCheckCommand,
	createState,
	createSubjectFor,
} from "../../balance-engine/tests/unit/engineFixtures.js";

/** Builds dist into an empty directory and uses it the way a consumer outside this workspace would. */
let dir: string;
const command = createCheckCommand();
const subject = createSubjectFor({
	state: createState(),
	entityId: command.identity.entityId,
});
const expected = JSON.parse(
	JSON.stringify(computeCheck({ fullSubject: subject, command })),
);

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "atm-consumer-"));
	const build = Bun.spawnSync([
		"bun",
		join(import.meta.dir, "../build.ts"),
		join(dir, "dist"),
	]);
	if (build.exitCode !== 0) throw new Error(build.stderr.toString());
	await writeFile(join(dir, "subject.json"), JSON.stringify(subject));
	await writeFile(join(dir, "command.json"), JSON.stringify(command));
	await writeFile(
		join(dir, "consumer.mjs"),
		[
			'import { readFileSync } from "node:fs";',
			'import { runEngineCommand } from "./dist/index.js";',
			'const read = (f) => JSON.parse(readFileSync(f, "utf8"));',
			'console.log(JSON.stringify(runEngineCommand({ subject: read("subject.json"), command: read("command.json") })));',
		].join("\n"),
	);
}, 120_000);

const run = (cmd: string[]) => {
	const out = Bun.spawnSync(cmd, {
		cwd: dir,
		env: { PATH: process.env.PATH ?? "" },
	});
	if (out.exitCode !== 0)
		throw new Error(out.stdout.toString() + out.stderr.toString());
	return out.stdout.toString();
};

describe("built library", () => {
	test("typechecks against its own declarations alone", async () => {
		await writeFile(
			join(dir, "typed.ts"),
			[
				'import { runEngineCommand, type AtmCheckResult, type AtmCommand, type AtmMutation, type AtmSubject } from "./dist/index.js";',
				"declare const subject: AtmSubject;",
				'declare const check: AtmCommand & { type: "check" };',
				'declare const finalize: AtmCommand & { type: "finalize" };',
				"const decision: AtmCheckResult = runEngineCommand({ subject, command: check });",
				"const mutation: AtmMutation = runEngineCommand({ subject, command: finalize });",
				'import { buildJournal, replayEvents, validateEvent, type AtmEvent, type AtmValidation } from "./dist/index.js";',
				"declare const events: AtmEvent[];",
				"const checked: AtmValidation = validateEvent(events[0]);",
				'const files = buildJournal({ events, month: "2026-01" }).files;',
				"const balances = replayEvents({ events, catalog: [] }).balances;",
				"export { decision, mutation, checked, files, balances };",
			].join("\n"),
		);
		await writeFile(
			join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					strict: true,
					module: "nodenext",
					moduleResolution: "nodenext",
					target: "es2022",
					types: [],
					noEmit: true,
				},
				files: ["typed.ts"],
			}),
		);
		run([
			process.execPath,
			require.resolve("typescript/bin/tsc"),
			"-p",
			"tsconfig.json",
		]);
	}, 60_000);

	test("runs under Bun with no node_modules", () => {
		expect(JSON.parse(run(["bun", "consumer.mjs"]))).toEqual(expected);
	});

	test("the ledger functions run from the bundle alone, under Node", async () => {
		const events = readFileSync(
			join(
				import.meta.dir,
				"../fixtures/vibes-year/schools/sch_vol/events",
				"date=2026-01-17",
				readdirSync(
					join(
						import.meta.dir,
						"../fixtures/vibes-year/schools/sch_vol/events/date=2026-01-17",
					),
				)[0] as string,
			),
			"utf8",
		);
		await writeFile(join(dir, "events.jsonl"), events);
		await writeFile(
			join(dir, "ledger.mjs"),
			[
				'import { readFileSync } from "node:fs";',
				'import { validateEvent, buildJournal } from "./dist/index.js";',
				'const events = readFileSync("events.jsonl", "utf8").trim().split("\\n").map((l) => JSON.parse(l));',
				"const ok = events.every((e) => validateEvent(e).ok);",
				'const j = buildJournal({ events, month: "2026-01" });',
				"console.log(JSON.stringify({ ok, n: events.length, tx: j.transactions }));",
			].join("\n"),
		);
		const out = JSON.parse(run(["node", "ledger.mjs"]));
		expect(out.ok).toBe(true);
		expect(out.n).toBeGreaterThan(0);
	});

	test("runs under Node", () => {
		expect(JSON.parse(run(["node", "consumer.mjs"]))).toEqual(expected);
	});

	test("the CLI bundle runs alone", () => {
		expect(
			JSON.parse(
				run([
					"bun",
					"dist/atm.js",
					"run",
					"--subject",
					"subject.json",
					"--command",
					"command.json",
				]),
			),
		).toEqual(expected);
	});

	test("the billing functions run from the bundle alone, under Bun and Node", async () => {
		const fx = (p: string) =>
			readFileSync(join(import.meta.dir, "../fixtures/billing", p), "utf8");
		await writeFile(join(dir, "menu.json"), fx("menu/vibes-menu.json"));
		await writeFile(join(dir, "grants-menu.json"), fx("grants/menu.json"));
		await writeFile(join(dir, "invoice.json"), fx("grants/inv-create-s2.json"));
		await writeFile(
			join(dir, "stripe-event.json"),
			fx("stripe/invoice.paid.json"),
		);
		await writeFile(
			join(dir, "billing.mjs"),
			[
				'import { readFileSync } from "node:fs";',
				'import { validateMenu, menuToStripe, resolvePolicy, normalize, mappingFor, invoiceToCommands, runOnState, menuCatalogRows, EMPTY_GRANTS_STATE, DEFAULT_POLICY, MAPPINGS } from "./dist/index.js";',
				'const read = (f) => JSON.parse(readFileSync(f, "utf8"));',
				'const checked = validateMenu(read("menu.json"));',
				"const ops = checked.ok ? menuToStripe({ schoolId: 'sch_vol', menu: checked.menu, previous: null, policy: resolvePolicy(null) }) : [];",
				'const event = read("stripe-event.json");',
				"const mapping = mappingFor(event.type, event.api_version);",
				"const fact = mapping.ok ? normalize(event, mapping.value, { eventId: 'evt_in_1' }) : mapping;",
				'const menu = read("grants-menu.json");',
				'const invoice = read("invoice.json");',
				"const granted = invoiceToCommands({ invoice, menu, policy: DEFAULT_POLICY, state: EMPTY_GRANTS_STATE, now: invoice.paidAt, menuVersion: 3, policyVersion: 1 });",
				"const catalog = menuCatalogRows({ menu, school: 'sch_vol' });",
				"const ran = runOnState({ state: null, catalog, command: granted.commands[0] });",
				"console.log(JSON.stringify({ menuOk: checked.ok, ops: ops.length, mappings: MAPPINGS.length, factOk: fact.ok, factKind: fact.ok ? fact.value.source.mapping : null, commands: granted.commands.map((c) => c.type), changes: ran.mutation ? ran.mutation.changes.length : 0, rows: ran.state ? ran.state.customerEntitlements.length : 0 }));",
			].join("\n"),
		);
		const bun = JSON.parse(run(["bun", "billing.mjs"]));
		const node = JSON.parse(run(["node", "billing.mjs"]));
		expect(node).toEqual(bun);
		expect(bun.menuOk).toBe(true);
		expect(bun.ops).toBeGreaterThan(0);
		expect(bun.mappings).toBeGreaterThan(0);
		expect(bun.factOk).toBe(true);
		expect(bun.factKind).toBe("stripe/invoice.paid@v1");
		expect(bun.commands).toEqual(["applyBillingPlan"]);
		expect(bun.changes).toBeGreaterThan(0);
		expect(bun.rows).toBeGreaterThan(0);
	});
});
