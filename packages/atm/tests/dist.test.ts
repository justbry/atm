import { beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeCheck } from "@autumn/balance-engine";
import {
	createCheckCommand,
	createState,
	createSubjectFor,
} from "../../balance-engine/tests/unit/engineFixtures.js";
import { deterministicUlid } from "../src/index.js";
import { readEvents } from "../src/ledger/files.js";
import { membersOf } from "../src/ledger/summary.js";
import { buildViews } from "../src/ledger/views.js";
import type { AtmCatalogRow } from "../src/types.js";

/**
 * Builds dist into an empty directory and uses it the way a consumer outside this workspace would. With `ATM_DIST`
 * set (the release script does), it tests that already-built directory instead of building one.
 */
let dir: string;
const command = createCheckCommand();
const subject = createSubjectFor({
	state: createState(),
	entityId: command.identity.entityId,
});
const expected = JSON.parse(
	JSON.stringify(computeCheck({ fullSubject: subject, command })),
);

/** What buzz-school's ledger emission imports from the package root and from `atm/worker`; losing one breaks it. */
const ROOT_EXPORTS = [
	"appendToOutbox",
	"catalogPublishedEvent",
	"HANDLER_DDL",
	"ledgerEvent",
	"migrateHandlerSchema",
	"planOutbox",
	"shipOutbox",
];
const WORKER_EXPORTS = [
	"catalogPublishedEvent",
	"incomeStatement",
	"kpiDocument",
	"ledgerRows",
	"runViews",
];

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "atm-consumer-"));
	if (process.env.ATM_DIST) {
		cpSync(process.env.ATM_DIST, join(dir, "dist"), { recursive: true });
	} else {
		const build = Bun.spawnSync([
			"bun",
			join(import.meta.dir, "../build.ts"),
			join(dir, "dist"),
		]);
		if (build.exitCode !== 0) throw new Error(build.stderr.toString());
	}
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
				'import { deterministicUlid } from "./dist/index.js";',
				'const eventId: string = deterministicUlid({ timeMs: 0, revision: 0, seed: "sch_vol|evt_1" });',
				'import { appendToOutbox, balancesOf, canonicalize, decimalToUnits, duckdbDdl, HledgerError, journalMonth, localDate, readEvents, REPORT_NAMES, reportMonth, type AtmBalance, type AtmEventFile, type JournalRun, type ReportRun, type SqlDatabase } from "./dist/index.js";',
				"declare const db: SqlDatabase;",
				'const inserted: number = appendToOutbox(db, events, "live");',
				"const owned: AtmBalance[] = balancesOf({ states: {}, holds: {}, catalog: [], asOfMs: 0 });",
				"const bytes: string = canonicalize({ b: 1, a: 2 });",
				'const day: string = localDate(0, "UTC");',
				'const units: bigint = decimalToUnits("1.00", 2);',
				"const ddl: string = duckdbDdl({});",
				'const read: Promise<{ events: typeof events; files: AtmEventFile[] }> = readEvents("root", "sch_vol");',
				'const journal: Promise<JournalRun> = journalMonth({ root: "root", school: "sch_vol", month: "2026-01" });',
				'const report: Promise<ReportRun> = reportMonth({ root: "root", school: "sch_vol", month: "2026-01", report: "credits", format: "csv" });',
				"const names: readonly string[] = REPORT_NAMES;",
				'const failure: Error = new HledgerError("hledger is not installed");',
				"export { decision, mutation, checked, files, balances, eventId, inserted, owned, bytes, day, units, ddl, read, journal, report, names, failure };",
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
				'import { validateEvent, buildJournal, deterministicUlid } from "./dist/index.js";',
				'const events = readFileSync("events.jsonl", "utf8").trim().split("\\n").map((l) => JSON.parse(l));',
				"const ok = events.every((e) => validateEvent(e).ok);",
				'const j = buildJournal({ events, month: "2026-01" });',
				'const eventId = deterministicUlid({ timeMs: 1792339440000, revision: 3, seed: "sch_vol|evt_1" });',
				"console.log(JSON.stringify({ ok, n: events.length, tx: j.transactions, eventId }));",
			].join("\n"),
		);
		const out = JSON.parse(run(["node", "ledger.mjs"]));
		expect(out.ok).toBe(true);
		expect(out.n).toBeGreaterThan(0);
		// The stored input event id a caller derives from the bundle is the one atm derives itself.
		expect(out.eventId).toBe(
			deterministicUlid({
				timeMs: 1792339440000,
				revision: 3,
				seed: "sch_vol|evt_1",
			}),
		);
	});

	test("the folder readers and ledger helpers run from the bundle alone, under Node", async () => {
		cpSync(
			join(import.meta.dir, "../fixtures/vibes-year"),
			join(dir, "books"),
			{ recursive: true },
		);
		await writeFile(
			join(dir, "sdk.mjs"),
			[
				'import { readFileSync } from "node:fs";',
				'import { readEvents, journalMonth, reportMonth, HledgerError, REPORT_NAMES, canonicalize, localDate, decimalToUnits, duckdbDdl, balancesOf, appendToOutbox } from "./dist/index.js";',
				'const { events, files } = await readEvents("books", "sch_vol");',
				'const journal = await journalMonth({ root: "books", school: "sch_vol", month: "2026-01" });',
				// the PATH is empty, so hledger is missing: the library says so by class, under Node as under Bun
				'const report = await reportMonth({ root: "books", school: "sch_vol", month: "2026-01" }).catch((error) => error);',
				"console.log(JSON.stringify({",
				"  events: events.length, lines: files.reduce((sum, f) => sum + f.lines, 0), built: journal.written.length > 0,",
				"  missing: report instanceof HledgerError, names: REPORT_NAMES,",
				'  canonical: canonicalize({ b: 1, a: 2 }), day: localDate(Date.parse("2026-11-03T03:30:00Z"), "America/Denver"),',
				'  units: decimalToUnits("130.00", 2).toString(), ddl: duckdbDdl(JSON.parse(readFileSync("envelope.json", "utf8"))).includes("TIMESTAMPTZ"),',
				'  balances: balancesOf({ states: {}, holds: { l: { holder: "h", feature: "f", units: 3 } }, catalog: [], asOfMs: 0 }),',
				"  appendToOutbox: typeof appendToOutbox,",
				"}));",
			].join("\n"),
		);
		await writeFile(
			join(dir, "envelope.json"),
			readFileSync(join(import.meta.dir, "../schema/envelope.v1.json")),
		);
		const node = Bun.which("node");
		if (!node) throw new Error("node is not on PATH");
		const ran = Bun.spawnSync([node, "sdk.mjs"], {
			cwd: dir,
			env: { PATH: await mkdtemp(join(tmpdir(), "atm-empty-path-")) },
		});
		if (ran.exitCode !== 0)
			throw new Error(ran.stdout.toString() + ran.stderr.toString());
		const out = JSON.parse(ran.stdout.toString());
		expect(out).toEqual({
			events: 81,
			lines: 81,
			built: true,
			missing: true,
			names: ["income-statement", "balance-sheet", "credits"],
			canonical: '{"a":2,"b":1}',
			day: "2026-11-02",
			units: "13000",
			ddl: true,
			balances: [{ holder: "h", feature: "f", avail: 0, held: 3 }],
			appendToOutbox: "function",
		});
	}, 60_000);

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
	test("the `atm/worker` subpath points at built files that declare no foreign import", () => {
		const subpath = JSON.parse(
			readFileSync(join(import.meta.dir, "../package.json"), "utf8"),
		).exports["./worker"];
		expect(subpath).toEqual({
			types: "./dist/worker.d.ts",
			bun: "./src/worker.ts",
			default: "./dist/worker.js",
		});
		expect(
			existsSync(join(dir, subpath.types.replace("./dist/", "dist/"))),
		).toBe(true);
		expect(
			existsSync(join(dir, subpath.default.replace("./dist/", "dist/"))),
		).toBe(true);
		const declarations = readFileSync(join(dir, "dist/worker.d.ts"), "utf8");
		expect(declarations).toContain("export declare const readEventsFromStore");
		expect(declarations).toContain("export declare const writeViews");
		expect(declarations).toContain("export declare const readViewsFromStore");
		expect(declarations).toContain("export declare class R2BindingStore");
	});

	test("the worker declarations typecheck against the built package alone", async () => {
		await writeFile(
			join(dir, "typed-worker.ts"),
			[
				'import { R2BindingStore, buildViews, memberSummary, membersOf, readEventsFromStore, readViewsFromStore, writeViews, type MemberResult, type MembersResult, type R2BucketBinding, type ViewRead, type MonthObject, type Views, type ViewsReader, type ViewReadError, type ViewsResult, type WriteViewsResult } from "./dist/worker.js";',
				'import type { AtmEvent, Store } from "./dist/index.js";',
				"declare const store: Store;",
				"declare const asOf: Date;",
				'const events: Promise<AtmEvent[]> = readEventsFromStore(store, "sch_vol", { from: "2026-01-01" });',
				"declare const loaded: AtmEvent[];",
				"const members: MembersResult = membersOf(loaded, asOf, { catalog: [] });",
				'const one: MemberResult = memberSummary(loaded, "family:fam_1", asOf);',
				'const built: ViewsResult = buildViews(loaded, { school: "sch_vol", asOf });',
				"declare const views: Views;",
				'const written: Promise<WriteViewsResult> = writeViews(store, "sch_vol", views);',
				"declare const binding: R2BucketBinding;",
				"const bound: Store = new R2BindingStore(binding);",
				'const opened: Promise<ViewsReader | ViewReadError> = readViewsFromStore(bound, "sch_vol");',
				'const month = async (reader: ViewsReader): Promise<ViewRead<MonthObject>> => reader.month("2026-12");',
				"export { events, members, one, built, written, bound, opened, month };",
			].join("\n"),
		);
		await writeFile(
			join(dir, "tsconfig-worker.json"),
			JSON.stringify({
				compilerOptions: {
					strict: true,
					module: "nodenext",
					moduleResolution: "nodenext",
					target: "es2022",
					types: [],
					noEmit: true,
				},
				files: ["typed-worker.ts"],
			}),
		);
		run([
			process.execPath,
			require.resolve("typescript/bin/tsc"),
			"-p",
			"tsconfig-worker.json",
		]);
	}, 60_000);

	test("the worker bundle reads a log through a Store and builds views, under Node, with no node_modules", async () => {
		const root = join(import.meta.dir, "../fixtures/vibes-year");
		cpSync(root, join(dir, "worker-books"), { recursive: true });
		await writeFile(
			join(dir, "worker.mjs"),
			[
				'import { readdirSync, readFileSync, statSync } from "node:fs";',
				'import { join, relative } from "node:path";',
				'import { buildViews, membersOf, readEventsFromStore } from "./dist/worker.js";',
				'const base = "worker-books";',
				"const keys = [];",
				"const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else keys.push(relative(base, p)); } };",
				"walk(base);",
				"const store = {",
				"  list: async ({ prefix = '', delimiter } = {}) => {",
				"    const under = keys.filter((k) => k.startsWith(prefix)).sort();",
				"    if (!delimiter) return { objects: under.map((key) => ({ key })), prefixes: [], next: null };",
				"    const prefixes = new Set(); const objects = [];",
				"    for (const key of under) { const rest = key.slice(prefix.length); const at = rest.indexOf(delimiter); if (at === -1) objects.push({ key }); else prefixes.add(prefix + rest.slice(0, at + 1)); }",
				"    return { objects, prefixes: [...prefixes].sort(), next: null };",
				"  },",
				"  get: async (key) => ({ key, body: new Uint8Array(readFileSync(join(base, key))) }),",
				"};",
				'const events = await readEventsFromStore(store, "sch_vol");',
				'const catalog = JSON.parse(readFileSync(join(base, "catalog.json"), "utf8"));',
				'const asOf = new Date("2026-12-28T17:00:00Z");',
				"const members = membersOf(events, asOf, { catalog });",
				'const built = buildViews(events, { school: "sch_vol", asOf, catalog });',
				"console.log(JSON.stringify({ events: events.length, members, built }));",
			].join("\n"),
		);
		const out = JSON.parse(run(["node", "worker.mjs"]));
		const asOf = new Date("2026-12-28T17:00:00Z");
		const catalog = JSON.parse(
			readFileSync(join(root, "catalog.json"), "utf8"),
		) as AtmCatalogRow[];
		const { events } = await readEvents(root, "sch_vol");
		expect(out.events).toBe(events.length);
		expect(out.members).toEqual(
			JSON.parse(JSON.stringify(membersOf(events, asOf, { catalog }))),
		);
		expect(out.built).toEqual(
			JSON.parse(
				JSON.stringify(
					buildViews(events, { school: "sch_vol", asOf, catalog }),
				),
			),
		);
		expect(out.built.ok).toBe(true);
	}, 60_000);

	test("the exports the ledger emission pins are there, from `.` and `atm/worker`, under Bun and Node", async () => {
		await writeFile(
			join(dir, "exports.mjs"),
			[
				'import * as root from "./dist/index.js";',
				'import * as worker from "./dist/worker.js";',
				"const kinds = (module, names) => Object.fromEntries(names.map((name) => [name, typeof module[name]]));",
				`console.log(JSON.stringify({ root: kinds(root, ${JSON.stringify(ROOT_EXPORTS)}), worker: kinds(worker, ${JSON.stringify(WORKER_EXPORTS)}) }));`,
			].join("\n"),
		);
		const rootExpected = Object.fromEntries(
			ROOT_EXPORTS.map((name) => [
				name,
				name === "HANDLER_DDL" ? "string" : "function",
			]),
		);
		const workerExpected = Object.fromEntries(
			WORKER_EXPORTS.map((name) => [name, "function"]),
		);
		for (const runtime of ["bun", "node"]) {
			const out = JSON.parse(run([runtime, "exports.mjs"]));
			expect(out.root).toEqual(rootExpected);
			expect(out.worker).toEqual(workerExpected);
		}
	});
});
