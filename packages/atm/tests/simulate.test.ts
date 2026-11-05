/**
 * `simulate`: the log's commands run again under a candidate catalog or policy, set against the log.
 *
 * The main check is the identity: the same catalog and policy give no difference on every log `replayEvents` accepts (the
 * golden year, and the seeded random histories of `billing-play.ts`). The what-ifs on the golden year are committed under
 * golden/simulate/ (`UPDATE_GOLDEN=1` rewrites them) and each has numbers worked out by hand in the test, so the golden
 * is not the only witness. The year's `applyBillingPlan` commands carry their own grant amounts (decided before they were
 * logged, by the grant rules), so a catalog allowance reaches the resets and the draws, not the first grant of a plan.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateYear } from "../fixtures/vibes.js";
import { DEFAULT_POLICY, resolvePolicy } from "../src/billing/policy.js";
import type { Menu } from "../src/billing/types.js";
import { buildJournal } from "../src/ledger/journal.js";
import { simulate } from "../src/ledger/simulate.js";
import type { AtmCatalogRow, AtmEvent, AtmSimulation } from "../src/types.js";
import { FAMILY, menu, play, SCHOOL } from "./billing-play.js";
import { createStore } from "./billing-store.js";
import { hasHledger, readTree, tmp } from "./helpers.js";

const FIXTURE = join(import.meta.dir, "../fixtures/vibes-year");
const GOLDEN = join(import.meta.dir, "golden/simulate");
const BIN = join(import.meta.dir, "../src/bin.ts");
const year = generateYear({ seed: 1 });
const HOLDER = year.expected.holder;
const MONEY = /^(payment|payout|dispute)\./;
const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);

const byId = (a: AtmEvent, b: AtmEvent) =>
	a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

const deepFreeze = <T>(value: T): T => {
	if (typeof value === "object" && value !== null) {
		for (const inner of Object.values(value)) deepFreeze(inner);
		Object.freeze(value);
	}
	return value;
};

/** The year's catalog with one entitlement's allowance changed. */
const withAllowance = (entitlement: string, allowance: number) => {
	const rows = structuredClone(year.catalog) as AtmCatalogRow[];
	const target = rows.find(
		(r) => r.table === "entitlements" && r.row.id === entitlement,
	);
	if (!target) throw new Error(`no entitlement ${entitlement}`);
	target.row.allowance = allowance;
	return rows;
};

const expiryFirst = resolvePolicy({ deductionOrder: "expiry" });
const deductionOrder = () =>
	simulate({
		events: year.events,
		catalog: year.catalog,
		candidate: { policy: expiryFirst },
	});
// sparkle-2 is the tier the family has until July; sparkle-1 from then to the end of the year
const smallerAllowance = () =>
	simulate({
		events: year.events,
		catalog: year.catalog,
		candidate: { catalog: withAllowance("ent_s2", 1) },
	});
const largerAllowance = () =>
	simulate({
		events: year.events,
		catalog: year.catalog,
		candidate: { catalog: withAllowance("ent_s1", 3) },
	});

const withoutEvents = ({ events: _events, ...rest }: AtmSimulation) => rest;

const golden = (name: string, sim: AtmSimulation) => {
	const text = `${JSON.stringify(withoutEvents(sim), null, 2)}\n`;
	const file = join(GOLDEN, name);
	if (process.env.UPDATE_GOLDEN) writeFileSync(file, text);
	expect(text).toBe(readFileSync(file, "utf8"));
};

const expectNoDifference = (sim: AtmSimulation) => {
	expect(sim.differences).toBe(0);
	expect(sim.balanceChanges).toEqual([]);
	expect(sim.postingChanges).toEqual([]);
	expect(sim.changed).toEqual([]);
	expect(sim.refused).toEqual([]);
	expect(sim.balances.candidate).toEqual(sim.balances.current);
};

const total = (sim: AtmSimulation, month: string, account: string) => {
	const change = sim.postingChanges.find(
		(p) => p.month === month && p.account === account,
	);
	return change ? [change.current, change.candidate] : null;
};

/** Credits on each commodity across every `credits:` account: nothing is made or lost. */
const creditSums = (events: readonly AtmEvent[]) => {
	const sums = new Map<string, number>();
	for (const e of events)
		for (const p of e.postings)
			if (p.account.startsWith("credits:"))
				sums.set(p.commodity, (sums.get(p.commodity) ?? 0) + Number(p.amount));
	return Object.fromEntries(sums);
};

/** The balances as the candidate's own postings add up, the way the fixture's expected balances are checked. */
const balancesFromPostings = (events: readonly AtmEvent[]) => {
	const sum = (account: string) =>
		events
			.flatMap((e) => e.postings)
			.filter((p) => p.account === account)
			.reduce((n, p) => n + Number(p.amount), 0);
	return [
		{
			holder: HOLDER,
			feature: "visit",
			avail: sum(`credits:avail:${HOLDER}:visit`),
			held: sum(`credits:held:${HOLDER}:visit`),
		},
	];
};

/** Checks the main correctness properties of a result; each mutation below must make one of them throw. */
const moneyIsCarriedOver = (sim: AtmSimulation, log: readonly AtmEvent[]) => {
	for (const e of log.filter((x) => MONEY.test(x.event_type)))
		expect(sim.events.find((c) => c.id === e.id)).toEqual(e);
	expect(sim.postingChanges.filter((p) => p.commodity === "USD")).toEqual([]);
	expect(sim.unaffected.events).toBeGreaterThanOrEqual(
		log.filter((x) => MONEY.test(x.event_type)).length,
	);
};
const balancesAreTheCandidates = (sim: AtmSimulation) =>
	expect(sim.balances.candidate).toEqual(balancesFromPostings(sim.events));

describe("simulate: the same catalog and policy change nothing", () => {
	test("the golden year, with nothing, with its own catalog, and with its own events as the candidate", () => {
		for (const candidate of [{}, { catalog: year.catalog }]) {
			const sim = simulate({
				events: year.events,
				catalog: year.catalog,
				candidate,
			});
			expectNoDifference(sim);
			expect([...year.events].sort(byId)).toEqual(sim.events);
			expect(sim.unaffected.events).toBe(25);
		}
	});

	test.each(SEEDS)(
		"seed %d: the random history of a family, with its menu and the default policy",
		(seed) => {
			const store = createStore({ menu, school: SCHOOL, family: FAMILY });
			play({ seed, steps: 40, store });
			const sim = simulate({
				events: store.events,
				menu,
				candidate: { menu, policy: DEFAULT_POLICY },
			});
			expectNoDifference(sim);
			expect(sim.events).toEqual([...store.events].sort(byId));
		},
	);

	test("a menu that changes what the engine does not read (a price, a name) changes nothing", () => {
		const store = createStore({ menu, school: SCHOOL, family: FAMILY });
		play({ seed: 3, steps: 40, store });
		const renamed = structuredClone(menu) as Menu;
		for (const tier of renamed.tiers) {
			tier.blurb = `${tier.blurb} (new)`;
			for (const price of tier.prices) price.amount += 100;
		}
		expectNoDifference(
			simulate({ events: store.events, menu, candidate: { menu: renamed } }),
		);
	});
});

describe("simulate: what-ifs on the golden year", () => {
	test("the draw order: expiry first moves a spend from the monthly row to the gift that would have lapsed", () => {
		const sim = deductionOrder();
		golden("deduction-order.json", sim);
		// The year's commands carry no `deduction_order`, so the engine's own order ran. The gift `gc_2` (1 credit, expires
		// 2026-09-20) lapsed unused in the log: the cron booked its expiry that day.
		const lapse = year.events.find((e) => e.payload.lapsed !== undefined);
		expect(lapse?.event_time).toBe("2026-09-20T18:03:00Z");
		expect(lapse?.payload.lapsed).toEqual([
			{
				table: "customerEntitlements",
				id: "ce_gift_2",
				balance: 1,
				expires_at: Date.parse("2026-09-20T18:03:00Z"),
			},
		]);
		// With the soonest-lapsing row drawn first, the August spend (cmd_038) takes the gift `ce_gift_1`, not the plan's `ce_1`...
		const spend = sim.changed.find((d) => d.commandId === "cmd_038");
		expect(spend?.removed.map((c) => c.id)).toContain("ce_1");
		expect(spend?.added.map((c) => c.id)).toContain("ce_gift_1");
		// ...so nothing is left of the other gift to lapse: its expiry is not booked, and September's `credits:expired` is 0, not 1.
		expect(total(sim, "2026-09", "credits:expired")).toEqual(["1", "0"]);
		expect(sim.events.some((e) => e.payload.lapsed !== undefined)).toBe(false);
		// The year ends on the same balance (0 available, 1 held): the order moves credits between rows, not out of the year.
		expect(sim.balanceChanges).toEqual([]);
		expect(sim.refused).toEqual([]);
		expect(sim.unaffected.events).toBe(24);
		// Only commands that draw can differ: every changed command is a spend, or a reset that rolls a different row over.
		expect(new Set(sim.changed.map((d) => d.command))).toEqual(
			new Set(["track", "reset", "updateBalance"]),
		);
	});

	test("a smaller allowance on the tier the family has: the resets refill 1, and later spends are refused", () => {
		const sim = smallerAllowance();
		golden("smaller-allowance.json", sim);
		// January is untouched: the first grant is in the `applyBillingPlan` command, not read from the catalog.
		expect(sim.postingChanges.filter((p) => p.month === "2026-01")).toEqual([]);
		// Each reset from February to June issues the allowance: 2 became 1 (five resets).
		for (const month of ["02", "03", "04", "05", "06"])
			expect(
				total(sim, `2026-${month}`, "credits:issued:sparkle-2@v1"),
			).toEqual(["-2", "-1"]);
		// May has 1 credit (the May reset) for 2 bookings: the family used its gifts in March and its April credit on the
		// 25th, so the May 20th spend takes the one credit and the 24th (cmd_026) cannot be covered...
		const [first, second] = sim.refused;
		expect(first?.commandId).toBe("cmd_026");
		expect(first?.command).toBe("track");
		expect(first?.reason).toBe("the engine rejected it: insufficient_balance");
		expect(first?.at).toBe("2026-05-24T21:03:00Z");
		// ...and the finalize that would have settled it (cmd_027, the lock's expiry) has no lock to settle.
		expect(second?.commandId).toBe("cmd_027");
		expect(second?.reason).toBe(
			"the engine refused: Lock not found: bk_z49d3q",
		);
		// The refused bookings leave no events: the log's held and forfeited credits of that booking are not made.
		const refusedIds = new Set(sim.refused.flatMap((r) => r.eventIds));
		expect(sim.events.filter((e) => refusedIds.has(e.id))).toEqual([]);
		expect(sim.refused.length).toBe(6);
		// The year's money is what the log has.
		expect(sim.postingChanges.some((p) => p.commodity === "USD")).toBe(false);
	});

	test("a larger allowance on the later tier: six resets issue 3, and the year ends with 2 more available", () => {
		const sim = largerAllowance();
		golden("larger-allowance.json", sim);
		for (const month of ["07", "08", "09", "10", "11", "12"])
			expect(
				total(sim, `2026-${month}`, "credits:issued:sparkle-1@v1"),
			).toEqual(["-1", "-3"]);
		expect(sim.balanceChanges).toEqual([
			{
				holder: HOLDER,
				feature: "visit",
				current: { avail: 0, held: 1 },
				candidate: { avail: 2, held: 1 },
			},
		]);
		// 12 more credits issued by the six resets (6 x (3 - 1)): 2 stay available at the end, and the other 10 lapse or
		// roll over and lapse, which the new `credits:expired` lines add up to.
		const issued = sim.postingChanges
			.filter((p) => p.account === "credits:issued:sparkle-1@v1")
			.reduce((n, p) => n + (Number(p.current) - Number(p.candidate)), 0);
		expect(issued).toBe(12);
		expect(sim.refused).toEqual([]);
	});

	test("the candidate's balances are what its own postings add up to, and its credits sum to nothing", () => {
		for (const sim of [
			deductionOrder(),
			smallerAllowance(),
			largerAllowance(),
		]) {
			balancesAreTheCandidates(sim);
			expect(creditSums(sim.events)).toEqual({ VISIT: 0 });
			// the current side is the log's: replay's balances, and the generator's expected ones
			expect(sim.balances.current).toEqual(year.expected.balances);
		}
	});

	test("the log's events are not the candidate's: a decision that differs makes events the log lacks, and drops the ones it lacks", () => {
		const sim = deductionOrder();
		const ids = new Set(year.events.map((e) => e.id));
		expect(sim.events.some((e) => !ids.has(e.id))).toBe(true);
		const kept = new Set(sim.events.map((e) => e.id));
		expect(year.events.some((e) => !kept.has(e.id))).toBe(true);
	});
});

describe("simulate: the candidate's journal", () => {
	const journalOf = async (events: readonly AtmEvent[]) => {
		const dir = await tmp("simulate-journal");
		const months = [...new Set(events.map((e) => e.date.slice(0, 7)))].sort();
		await mkdir(join(dir, "ledger/b4u"), { recursive: true });
		for (const month of months) {
			const build = buildJournal({ events, month });
			for (const [path, text] of Object.entries(build.files))
				await writeFile(join(dir, path), text);
		}
		return dir;
	};
	const hledger = (cwd: string, args: string[]) =>
		Bun.spawnSync(["hledger", "-f", "main.journal", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});

	test.skipIf(!hasHledger)(
		"hledger accepts it (balanced, accounts and commodities declared) and its credit accounts sum to zero",
		async () => {
			for (const sim of [
				deductionOrder(),
				smallerAllowance(),
				largerAllowance(),
			]) {
				const cwd = await journalOf(sim.events);
				const check = hledger(cwd, [
					"check",
					"balanced",
					"accounts",
					"commodities",
				]);
				expect(check.stderr.toString()).toBe("");
				expect(check.exitCode).toBe(0);
				const credits = hledger(cwd, [
					"bal",
					"credits:",
					"--flat",
					"-O",
					"csv",
				]);
				expect(credits.exitCode).toBe(0);
				const rows = credits.stdout.toString().trim().split("\n");
				expect(rows.at(-1)).toMatch(/^"Total:","0"$/);
			}
		},
	);

	test("without hledger: every candidate event is balanced and the transactions per month are counted from the journal", () => {
		const sim = smallerAllowance();
		for (const e of sim.events) {
			const by = new Map<string, number>();
			for (const p of e.postings)
				by.set(p.commodity, (by.get(p.commodity) ?? 0) + Number(p.amount));
			expect([e.id, [...by.values()].every((v) => v === 0)]).toEqual([
				e.id,
				true,
			]);
		}
		for (const { month, current, candidate } of sim.transactions) {
			expect(current).toBe(
				buildJournal({ events: year.events, month }).transactions,
			);
			expect(candidate).toBe(
				buildJournal({ events: sim.events, month }).transactions,
			);
		}
	});
});

describe("simulate: the checks have teeth", () => {
	test("dropping the carry-over of money events fails the money check", () => {
		const sim = smallerAllowance();
		moneyIsCarriedOver(sim, year.events);
		const dropped = {
			...sim,
			events: sim.events.filter((e) => !MONEY.test(e.event_type)),
		};
		expect(() => moneyIsCarriedOver(dropped, year.events)).toThrow();
		// and a payment carried over with another amount fails it too
		const changed = {
			...sim,
			events: sim.events.map((e) =>
				e.event_type === "payment.succeeded" ? { ...e, text: `${e.text}!` } : e,
			),
		};
		expect(() => moneyIsCarriedOver(changed, year.events)).toThrow();
	});

	test("ignoring a refused command (making its events, as if it had gone through) fails the balance check", () => {
		const sim = smallerAllowance();
		balancesAreTheCandidates(sim);
		const refusedIds = new Set(sim.refused.flatMap((r) => r.eventIds));
		const ignoringRefusals = {
			...sim,
			events: [
				...sim.events,
				...year.events.filter((e) => refusedIds.has(e.id)),
			],
		};
		expect(() => balancesAreTheCandidates(ignoringRefusals)).toThrow();
	});

	test("comparing the wrong side fails: the current balances are the log's and the candidate's are the postings'", () => {
		const sim = largerAllowance();
		const [change] = sim.balanceChanges;
		expect(change?.current).toEqual(
			year.expected.balances[0] && {
				avail: year.expected.balances[0].avail,
				held: year.expected.balances[0].held,
			},
		);
		expect(change?.candidate).toEqual({
			avail: balancesFromPostings(sim.events)[0]?.avail,
			held: balancesFromPostings(sim.events)[0]?.held,
		});
		// swapped, neither holds
		const swapped = {
			...sim,
			balances: {
				current: sim.balances.candidate,
				candidate: sim.balances.current,
			},
		};
		expect(() => balancesAreTheCandidates(swapped)).toThrow();
		expect(swapped.balances.current).not.toEqual(year.expected.balances);
	});
});

describe("simulate: the library", () => {
	test("it changes none of its inputs (they are frozen) and gives the same answer twice", () => {
		const events = deepFreeze(structuredClone(year.events));
		const catalog = deepFreeze(structuredClone(year.catalog));
		const candidate = deepFreeze({
			catalog: withAllowance("ent_s2", 1),
			policy: resolvePolicy({ deductionOrder: "expiry" }),
		});
		const before = JSON.stringify({ events, catalog, candidate });
		const first = simulate({ events, catalog, candidate });
		const second = simulate({ events, catalog, candidate });
		expect(JSON.stringify({ events, catalog, candidate })).toBe(before);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(first.refused.length).toBeGreaterThan(0);
	});

	test("the current side is the log: a log the replay refuses is refused, with its error", () => {
		const events = structuredClone(year.events);
		const hold = events.find((e) => e.event_type === "credit.held") as AtmEvent;
		(hold.payload.command as { value: number }).value = 2;
		expect(() =>
			simulate({ events, catalog: year.catalog, candidate: {} }),
		).toThrow(/event .*: the engine decides differently/);
	});

	test("--month style filter keeps one month of the postings and commands, and refuses a malformed month", () => {
		const sim = simulate({
			events: year.events,
			catalog: year.catalog,
			candidate: { catalog: withAllowance("ent_s2", 1) },
			month: "2026-05",
		});
		expect(sim.postingChanges.length).toBeGreaterThan(0);
		expect(new Set(sim.postingChanges.map((p) => p.month))).toEqual(
			new Set(["2026-05"]),
		);
		expect(sim.refused.map((r) => r.commandId)).toEqual(["cmd_026", "cmd_027"]);
		expect(sim.transactions.map((t) => t.month)).toEqual(["2026-05"]);
		expect(() =>
			simulate({
				events: year.events,
				catalog: year.catalog,
				candidate: {},
				month: "May",
			}),
		).toThrow(/YYYY-MM/);
	});

	test("the current and the candidate each name a catalog or a menu, not both", () => {
		expect(() =>
			simulate({
				events: year.events,
				catalog: year.catalog,
				menu,
				candidate: {},
			}),
		).toThrow(/not both/);
		expect(() =>
			simulate({
				events: year.events,
				catalog: year.catalog,
				candidate: { catalog: year.catalog, menu },
			}),
		).toThrow(/not both/);
	});

	test("what the engine decides for a candidate menu on a random history never throws, and its events are valid and balanced", () => {
		for (const seed of SEEDS.slice(0, 20)) {
			const store = createStore({ menu, school: SCHOOL, family: FAMILY });
			play({ seed, steps: 40, store });
			const halved = structuredClone(menu) as Menu;
			for (const tier of halved.tiers)
				for (const grant of tier.grants)
					grant.amount = Math.max(1, Math.floor(grant.amount / 2));
			const sim = simulate({
				events: store.events,
				menu,
				candidate: {
					menu: halved,
					policy: { ...DEFAULT_POLICY, deductionOrder: "engine" },
				},
			});
			for (const e of sim.events) {
				const by = new Map<string, number>();
				for (const p of e.postings)
					by.set(p.commodity, (by.get(p.commodity) ?? 0) + Number(p.amount));
				expect([seed, e.id, [...by.values()].every((v) => v === 0)]).toEqual([
					seed,
					e.id,
					true,
				]);
			}
			expect(creditSums(sim.events)).toEqual(
				Object.fromEntries(
					Object.keys(creditSums(sim.events)).map((c) => [c, 0]),
				),
			);
		}
	});
});

describe("atm simulate", () => {
	const atm = async (...args: string[]) => {
		const run = Bun.spawn(["bun", BIN, "simulate", ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(run.stdout).text(),
			new Response(run.stderr).text(),
			run.exited,
		]);
		return { stdout, stderr, exitCode };
	};
	const catalogFile = join(FIXTURE, "catalog.json");
	const base = (root: string) => [
		"--root",
		root,
		"--school",
		"sch_vol",
		"--current-catalog",
		catalogFile,
	];
	const scratch = async (files: Record<string, unknown>) => {
		const dir = await tmp("simulate-cli");
		for (const [name, content] of Object.entries(files))
			await writeFile(join(dir, name), JSON.stringify(content));
		return dir;
	};

	test("the same catalog: exit 0 and no differences; a what-if: exit 1; both write nothing", async () => {
		const root = await tmp("simulate-root");
		await cp(FIXTURE, root, { recursive: true });
		const before = await readTree(root);
		const files = await scratch({
			"policy.json": { deductionOrder: "expiry" },
			"smaller.json": withAllowance("ent_s2", 1),
		});

		const same = await atm(...base(root), "--catalog", catalogFile);
		expect(same.exitCode).toBe(0);
		expect(same.stdout).toContain("no differences");
		expect(same.stderr).toBe("");

		const order = await atm(
			...base(root),
			"--policy",
			join(files, "policy.json"),
			"--json",
		);
		expect(order.exitCode).toBe(1);
		expect(order.stderr).toBe("");
		expect(order.stdout.trimEnd().split("\n").length).toBe(1);
		const parsed = JSON.parse(order.stdout);
		expect(parsed.ok).toBe(true);
		expect(parsed.events).toBeUndefined();
		const library = withoutEvents(deductionOrder());
		expect({ ...parsed, ok: undefined, school: undefined }).toEqual({
			...library,
			ok: undefined,
			school: undefined,
		});

		const small = await atm(
			...base(root),
			"--catalog",
			join(files, "smaller.json"),
		);
		expect(small.exitCode).toBe(1);
		expect(small.stdout).toContain("commands the candidate refuses: 6");
		expect(small.stdout).toContain("cmd_026");

		expect(await readTree(root)).toEqual(before);
	});

	test("a menu and a policy as the candidate, the menu the log was written under as the current one", async () => {
		const store = createStore({ menu, school: SCHOOL, family: FAMILY });
		play({ seed: 3, steps: 40, store });
		const root = await tmp("simulate-menu-root");
		const events = join(root, "schools", SCHOOL, "events");
		for (const day of new Set(store.events.map((e) => e.date))) {
			await mkdir(join(events, `date=${day}`), { recursive: true });
			await writeFile(
				join(events, `date=${day}`, "batch-1.jsonl"),
				`${store.events
					.filter((e) => e.date === day)
					.map((e) => JSON.stringify(e))
					.join("\n")}\n`,
			);
		}
		const halved = structuredClone(menu) as Menu;
		for (const tier of halved.tiers)
			for (const grant of tier.grants)
				grant.amount = Math.max(1, Math.floor(grant.amount / 2));
		const renamed = structuredClone(menu) as Menu;
		for (const tier of renamed.tiers) tier.blurb = `${tier.blurb} (new)`;
		const files = await scratch({
			"current.json": menu,
			"halved.json": halved,
			"renamed.json": renamed,
			"policy.json": DEFAULT_POLICY,
		});
		const args = (...rest: string[]) => [
			"--root",
			root,
			"--school",
			SCHOOL,
			"--current-menu",
			join(files, "current.json"),
			...rest,
		];
		const before = await readTree(root);

		const same = await atm(
			...args(
				"--menu",
				join(files, "renamed.json"),
				"--policy",
				join(files, "policy.json"),
			),
		);
		expect(same.exitCode).toBe(0);
		expect(same.stdout).toContain("no differences");

		const different = await atm(...args("--menu", join(files, "halved.json")));
		expect(different.exitCode).toBe(1);
		expect(different.stdout).toContain("posting totals that differ");

		const month = await atm(
			...args(
				"--menu",
				join(files, "halved.json"),
				"--month",
				"2026-02",
				"--json",
			),
		);
		expect(month.exitCode).toBe(1);
		expect(
			new Set(
				JSON.parse(month.stdout).postingChanges.map(
					(p: { month: string }) => p.month,
				),
			),
		).toEqual(new Set(["2026-02"]));
		expect(await readTree(root)).toEqual(before);
	});

	test("input it cannot use is exit 2 with one line on stderr and no stack: a bad menu, a bad policy, a missing file, no candidate, no current catalog", async () => {
		const files = await scratch({
			"menu.json": { currency: "usd" },
			"policy.json": { deductionOrder: "bogus" },
			"rows.json": { not: "rows" },
		});
		const cases: [string[], RegExp][] = [
			[
				[...base(FIXTURE), "--menu", join(files, "menu.json")],
				/not a valid menu/,
			],
			[
				[...base(FIXTURE), "--policy", join(files, "policy.json")],
				/--policy .*policy is invalid/,
			],
			[
				[...base(FIXTURE), "--catalog", join(files, "rows.json")],
				/not a list of catalog rows/,
			],
			[
				[...base(FIXTURE), "--menu", join(files, "missing.json")],
				/cannot be read as JSON/,
			],
			[
				[...base(FIXTURE)],
				/give at least one of --menu, --catalog and --policy/,
			],
			[
				["--root", FIXTURE, "--school", "sch_vol", "--catalog", catalogFile],
				/--current-menu or --current-catalog/,
			],
			[
				[
					...base(FIXTURE),
					"--catalog",
					catalogFile,
					"--menu",
					join(files, "menu.json"),
				],
				/not both/,
			],
			[
				[...base(FIXTURE), "--catalog", catalogFile, "--month", "May"],
				/not YYYY-MM/,
			],
			[
				[
					"--root",
					FIXTURE,
					"--school",
					"sch_none",
					"--current-catalog",
					catalogFile,
					"--catalog",
					catalogFile,
				],
				/no events under/,
			],
			[
				[...base(FIXTURE), "--catalog", catalogFile, "--nope"],
				/unknown option/,
			],
		];
		for (const [args, message] of cases) {
			const run = await atm(...args);
			expect([args.join(" "), run.exitCode]).toEqual([args.join(" "), 2]);
			expect(run.stderr).toMatch(message);
			expect(run.stderr.trimEnd().split("\n").length).toBe(1);
			expect(run.stderr).not.toContain("    at ");
		}
		const json = await atm(
			...base(FIXTURE),
			"--menu",
			join(files, "menu.json"),
			"--json",
		);
		expect(json.exitCode).toBe(2);
		expect(JSON.parse(json.stdout)).toEqual({
			ok: false,
			error: json.stderr.trimEnd(),
		});
	});

	test("a log the replay refuses is exit 2 naming the event", async () => {
		const root = await tmp("simulate-bad-log");
		await cp(FIXTURE, root, { recursive: true });
		const rows = withAllowance("ent_s2", 1);
		const files = await scratch({ "rows.json": rows });
		// replaying the log under another catalog than the one it was written under is a log the replay refuses
		const run = await atm(
			"--root",
			root,
			"--school",
			"sch_vol",
			"--current-catalog",
			join(files, "rows.json"),
			"--catalog",
			catalogFile,
		);
		expect(run.exitCode).toBe(2);
		expect(run.stderr).toMatch(/^atm simulate failed: event \w+: /);
	});
});
