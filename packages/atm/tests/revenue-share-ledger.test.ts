/**
 * The revenue share in the school's books: the postings of the three share events, the month's statement worked by hand,
 * the journal and hledger on the events the real handler made, `reconcile` (which must not see the share), the replay of
 * a log that holds them, and `atm share`.
 *
 * The log is an invoice of 26000 cents at 3.33 percent (a share of 866) with its refunds, and a second invoice a month
 * later:
 *   Jan 15  in_1 paid 26000             accrued 866
 *   Jan 15  refund to 5000 in all       reversed 167   (866 x 5000 / 26000 = 166.5)
 *   Feb 15  in_2 paid 26000             accrued 866
 *   Feb 16  in_1 refunded to 15000      reversed 333   (499.6 -> 500 in all, less the 167)
 *   Feb 20  the school pays B4 Uni 500  settled 500
 * January: accrued 866, reversed 167, owed 699. February: accrued 866, reversed 333, settled 500, owed 33, and 732 is
 * owed at the end of it (699 + 33).
 */
import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { menuCatalogRows } from "../src/billing/grants.js";
import { buildJournal } from "../src/ledger/journal.js";
import { ledgerEvent } from "../src/ledger/postings.js";
import { reconcile } from "../src/ledger/reconcile.js";
import { replayEvents } from "../src/ledger/replay.js";
import {
	formatShareStatement,
	shareStatement,
} from "../src/ledger/share-statement.js";
import { validateEvent } from "../src/ledger/validate.js";
import type { AtmEvent } from "../src/types.js";
import { hasHledger, tmp } from "./helpers.js";
import {
	HOUR,
	invoiceRefund,
	membershipInvoice,
	menu,
	ofType,
	SCHOOL,
	T0,
	T1,
	withShare,
	world,
} from "./revenue-share-world.js";
import { stripeSideOf } from "./stripe-side.js";

const RATE = 3.33;
const DAY = 24 * HOUR;
const BIN = join(import.meta.dir, "../src/bin.ts");

const settled = ({
	amount,
	at,
	idem,
	reference,
	month,
}: {
	amount: number;
	at: number;
	idem: string;
	reference?: string;
	month?: string;
}): AtmEvent =>
	ledgerEvent({
		type: "share.settled",
		school: SCHOOL,
		tz: "America/Denver",
		eventTime: at,
		key: "b4uni",
		idem,
		amount,
		payload: {
			amount,
			...(month ? { month } : {}),
			...(reference ? { reference } : {}),
		},
	});

/** The handler's events for the log above, and what the school paid. */
const scenario = () => {
	const s = world({ policy: withShare(RATE) });
	s.handle(membershipInvoice(), { fee: 784 });
	s.handle(invoiceRefund({ eventId: "evt_re_a", refundedTotal: 5000 }));
	s.handle(
		membershipInvoice({
			invoiceId: "in_2",
			at: T1,
			reason: "subscription_cycle",
		}),
		{ at: T1, fee: 784 },
	);
	s.handle(
		invoiceRefund({
			eventId: "evt_re_b",
			refundedTotal: 15_000,
			previousTotal: 5000,
			at: T1 + DAY,
		}),
		{ at: T1 + DAY },
	);
	const payment = settled({
		amount: 500,
		at: T1 + 5 * DAY,
		idem: "settle:2026-02:1",
		reference: "wire 1",
		month: "2026-01",
	});
	return { s, events: [...s.events, payment] };
};

describe("the postings of the share's events", () => {
	const input = (
		type: "share.accrued" | "share.reversed" | "share.settled",
		amount: number,
	) =>
		ledgerEvent({
			type,
			school: SCHOOL,
			tz: "America/Denver",
			eventTime: T0,
			key: "k",
			idem: `x:${type}`,
			amount,
			payload: {},
		}).postings;

	test("accrued costs the school and owes B4 Uni; reversed is the opposite; settled pays the liability from the clearing account", () => {
		expect(input("share.accrued", 866)).toEqual([
			{
				account: "expenses:billing:b4uni-share",
				amount: "8.66",
				commodity: "USD",
			},
			{ account: "liabilities:b4uni", amount: "-8.66", commodity: "USD" },
		]);
		expect(input("share.reversed", 167)).toEqual([
			{
				account: "expenses:billing:b4uni-share",
				amount: "-1.67",
				commodity: "USD",
			},
			{ account: "liabilities:b4uni", amount: "1.67", commodity: "USD" },
		]);
		expect(input("share.settled", 500)).toEqual([
			{ account: "liabilities:b4uni", amount: "5.00", commodity: "USD" },
			{
				account: "assets:clearing:b4uni-payments",
				amount: "-5.00",
				commodity: "USD",
			},
		]);
	});

	test("an amount that is not a positive whole number of cents is refused, as for every money event", () => {
		for (const type of [
			"share.accrued",
			"share.reversed",
			"share.settled",
		] as const)
			for (const amount of [0, -1, 1.5])
				expect(() => input(type, amount)).toThrow(/positive whole amount/);
	});

	test("the payloads validate against their schemas, and one that is missing a field does not", () => {
		const { events } = scenario();
		for (const event of events)
			expect([event.event_type, validateEvent(event).errors]).toEqual([
				event.event_type,
				[],
			]);
		const accrued = ofType(events, "share.accrued")[0] as AtmEvent;
		const { share: _share, ...partial } = accrued.payload;
		expect(
			validateEvent({ ...accrued, payload: partial }).errors.length,
		).toBeGreaterThan(0);
		const reversed = ofType(events, "share.reversed")[0] as AtmEvent;
		const { reversed: _reversed, ...short } = reversed.payload;
		expect(
			validateEvent({ ...reversed, payload: short }).errors.length,
		).toBeGreaterThan(0);
		const payment = ofType(events, "share.settled")[0] as AtmEvent;
		expect(
			validateEvent({ ...payment, payload: { month: "2026-01" } }).errors
				.length,
		).toBeGreaterThan(0);
	});
});

describe("the month's statement, worked by hand", () => {
	test("January: accrued 866, reversed 167, owed 699, and 699 owed at the month's end", () => {
		const { events } = scenario();
		const january = shareStatement({
			events,
			school: SCHOOL,
			month: "2026-01",
		});
		expect(january).toEqual({
			school: SCHOOL,
			month: "2026-01",
			rows: [
				{
					paymentId: "in_1",
					kind: "invoice",
					date: "2026-01-15",
					collected: 26_000,
					percent: RATE,
					accrued: 866,
					reversed: 167,
				},
			],
			settlements: [],
			totals: { accrued: 866, reversed: 167, settled: 0, owed: 699 },
			balanceOwed: 699,
		});
	});

	test("February: a refund of January's payment is a row of its own, the payment made is settled, and 732 is owed at the end", () => {
		const { events } = scenario();
		const february = shareStatement({
			events,
			school: SCHOOL,
			month: "2026-02",
		});
		expect(february.rows).toEqual([
			{
				// accrued in January: this month it only reverses
				paymentId: "in_1",
				kind: "invoice",
				date: "2026-01-15",
				collected: 26_000,
				percent: RATE,
				accrued: 0,
				reversed: 333,
			},
			{
				paymentId: "in_2",
				kind: "invoice",
				date: "2026-02-15",
				collected: 26_000,
				percent: RATE,
				accrued: 866,
				reversed: 0,
			},
		]);
		expect(february.settlements).toEqual([
			{ date: "2026-02-20", amount: 500, reference: "wire 1" },
		]);
		expect(february.totals).toEqual({
			accrued: 866,
			reversed: 333,
			settled: 500,
			// 866 - 333 - 500
			owed: 33,
		});
		// 699 from January and 33 from February
		expect(february.balanceOwed).toBe(732);
	});

	test("a month with nothing in it, one before everything, and the same balance carried", () => {
		const { events } = scenario();
		const march = shareStatement({ events, school: SCHOOL, month: "2026-03" });
		expect(march.rows).toEqual([]);
		expect(march.totals).toEqual({
			accrued: 0,
			reversed: 0,
			settled: 0,
			owed: 0,
		});
		expect(march.balanceOwed).toBe(732);
		const before = shareStatement({ events, school: SCHOOL, month: "2025-12" });
		expect(before.balanceOwed).toBe(0);
		expect(before.rows).toEqual([]);
	});

	test("the total of each month's owed, up to a month, is that month's balance; paying the rest leaves 0", () => {
		const { events } = scenario();
		const rest = settled({
			amount: 732,
			at: T1 + 10 * DAY,
			idem: "settle:2026-02:2",
		});
		const all = [...events, rest];
		const [january, february] = ["2026-01", "2026-02"].map((month) =>
			shareStatement({ events: all, school: SCHOOL, month }),
		);
		expect(january?.totals.owed).toBe(699);
		expect(february?.totals.owed).toBe(33 - 732);
		expect(february?.balanceOwed).toBe(0);
		expect((january?.totals.owed ?? 0) + (february?.totals.owed ?? 0)).toBe(0);
	});

	test("the same events twice, in another order, or with another school's events give the same statement", () => {
		const { events } = scenario();
		const once = shareStatement({ events, school: SCHOOL, month: "2026-02" });
		expect(
			shareStatement({
				events: [...events, ...events],
				school: SCHOOL,
				month: "2026-02",
			}),
		).toEqual(once);
		expect(
			shareStatement({
				events: [...events].reverse(),
				school: SCHOOL,
				month: "2026-02",
			}),
		).toEqual(once);
		const other = events.map((event) => ({ ...event, school: "sch_other" }));
		expect(
			shareStatement({
				events: [...events, ...other],
				school: SCHOOL,
				month: "2026-02",
			}),
		).toEqual(once);
		expect(
			shareStatement({ events: other, school: SCHOOL, month: "2026-02" }).rows,
		).toEqual([]);
	});

	test("the month is the event's date in the school's zone: a payment at 20:00 on 31 January in Denver is January's, and February's in UTC", () => {
		const late = settled({
			amount: 100,
			at: Date.parse("2026-02-01T03:00:00Z"),
			idem: "settle:late",
		});
		expect(late.date).toBe("2026-01-31");
		const inDenver = shareStatement({
			events: [late],
			school: SCHOOL,
			month: "2026-01",
		});
		expect(inDenver.totals.settled).toBe(100);
		const inUtc = shareStatement({
			events: [late],
			school: SCHOOL,
			month: "2026-01",
			tz: "UTC",
		});
		expect(inUtc.totals.settled).toBe(0);
		expect(
			shareStatement({
				events: [late],
				school: SCHOOL,
				month: "2026-02",
				tz: "UTC",
			}).settlements,
		).toEqual([{ date: "2026-02-01", amount: 100, reference: null }]);
	});

	test("a month that is not YYYY-MM or a zone that is not one throws", () => {
		expect(() =>
			shareStatement({ events: [], school: SCHOOL, month: "2026-1" }),
		).toThrow(/YYYY-MM/);
		expect(() =>
			shareStatement({
				events: [],
				school: SCHOOL,
				month: "2026-01",
				tz: "Mars/Olympus",
			}),
		).toThrow();
	});

	test("the text: a header, a row per payment and the totals, in dollars", () => {
		const { events } = scenario();
		const text = formatShareStatement(
			shareStatement({ events, school: SCHOOL, month: "2026-01" }),
		);
		expect(text).toBe(
			[
				"payment_id,kind,date,collected,percent,accrued,reversed",
				"in_1,invoice,2026-01-15,260.00,3.33,8.66,1.67",
				"",
				"accrued,8.66",
				"reversed,1.67",
				"settled,0.00",
				"owed for 2026-01,6.99",
				"balance owed at the end of 2026-01,6.99",
				"",
			].join("\n"),
		);
	});
});

describe("the journal and hledger", () => {
	test("the share events are transactions in the month's journal, and the accounts they use are declared", () => {
		const { events } = scenario();
		const january = buildJournal({ events, month: "2026-01" });
		const text = january.files["ledger/b4u/2026-01.journal"] as string;
		expect(text).toContain("share.accrued");
		expect(text).toContain("share.reversed");
		expect(text).not.toContain("share.settled");
		const accounts = january.files["ledger/accounts.journal"] as string;
		for (const account of [
			"expenses:billing:b4uni-share",
			"liabilities:b4uni",
			"assets:clearing:b4uni-payments",
		])
			expect(accounts).toContain(`account ${account}`);
		// payments, refunds and the shares of January: 5 transactions at least (a payment, a share, a refund, a reversal) beside the credits
		const transactions = january.transactions;
		expect(
			buildJournal({
				events: events.filter((e) => !e.event_type.startsWith("share.")),
				month: "2026-01",
			}).transactions,
		).toBe(transactions - 2);
	});

	test.skipIf(!hasHledger)(
		"hledger reads it: balanced, accounts and commodities check, and the liability, the expense and the clearing account hold hand-worked totals",
		async () => {
			const { events } = scenario();
			const root = await tmp("revenue-share");
			try {
				for (const month of ["2026-01", "2026-02"]) {
					const build = buildJournal({ events, month });
					for (const [path, text] of Object.entries(build.files)) {
						await mkdir(dirname(join(root, path)), { recursive: true });
						await writeFile(join(root, path), text);
					}
				}
				const hledger = (args: string[]): string => {
					const run = Bun.spawnSync(
						["hledger", "-f", "main.journal", ...args],
						{ cwd: root, stdout: "pipe", stderr: "pipe" },
					);
					expect(run.stderr.toString()).toBe("");
					expect(run.exitCode).toBe(0);
					return run.stdout.toString();
				};
				hledger(["check", "balanced", "accounts", "commodities"]);
				// owed: 866 + 866 - 167 - 333 - 500 = 732, a credit balance
				expect(hledger(["bal", "liabilities:b4uni", "-N", "--flat"])).toMatch(
					/-7\.32 USD/,
				);
				// the cost: 866 + 866 - 167 - 333 = 1232
				expect(
					hledger(["bal", "expenses:billing:b4uni-share", "-N", "--flat"]),
				).toMatch(/12\.32 USD/);
				expect(
					hledger(["bal", "assets:clearing:b4uni-payments", "-N", "--flat"]),
				).toMatch(/-5\.00 USD/);
				// January alone: 866 - 167 = 699 owed
				expect(
					hledger([
						"bal",
						"liabilities:b4uni",
						"-N",
						"--flat",
						"-p",
						"2026-01",
					]),
				).toMatch(/-6\.99 USD/);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);
});

describe("reconcile does not see the share", () => {
	test("the differences are the same with the share events and without them, and none for this log", () => {
		const { events } = scenario();
		const without = events.filter(
			(event) => !event.event_type.startsWith("share."),
		);
		const stripe = stripeSideOf(without);
		for (const period of [{ month: "2026-01" }, { month: "2026-02" }]) {
			const withShare = reconcile({ events, stripe, period, mode: "live" });
			const baseline = reconcile({
				events: without,
				stripe,
				period,
				mode: "live",
			});
			expect(withShare).toEqual(baseline);
			expect(withShare.differences).toEqual([]);
		}
	});

	test("the share events are not counted as Stripe's money: the log count of each kind is unchanged", () => {
		const { events } = scenario();
		const result = reconcile({
			events,
			stripe: stripeSideOf(events),
			period: { month: "2026-01" },
			mode: "live",
		});
		expect(result.differences).toEqual([]);
		expect(JSON.stringify(result)).not.toContain("share");
	});
});

describe("replay", () => {
	test("a log that holds the share events replays, with the balances it has without them", () => {
		const { events } = scenario();
		const catalog = menuCatalogRows({ menu, school: SCHOOL });
		const replayed = replayEvents({ events, catalog });
		const without = replayEvents({
			events: events.filter((event) => !event.event_type.startsWith("share.")),
			catalog,
		});
		expect(replayed.applied).toBe(without.applied + 5);
		expect(replayed.balances).toEqual(without.balances);
		// and a replay in the other order of arrival is the same
		expect(
			replayEvents({ events: [...events].reverse(), catalog }).snapshot,
		).toEqual(replayed.snapshot);
	});
});

describe("atm share", () => {
	const writeLog = async (root: string, events: readonly AtmEvent[]) => {
		const byDate = new Map<string, AtmEvent[]>();
		for (const event of events)
			byDate.set(event.date, [...(byDate.get(event.date) ?? []), event]);
		for (const [date, day] of byDate) {
			const file = join(
				root,
				"schools",
				SCHOOL,
				"events",
				`date=${date}`,
				"batch-1.jsonl",
			);
			await mkdir(dirname(file), { recursive: true });
			await writeFile(
				file,
				`${day.map((event) => JSON.stringify(event)).join("\n")}\n`,
			);
		}
	};
	const atm = (args: string[]) =>
		Bun.spawnSync([process.execPath, BIN, "share", ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});

	test("prints the month's statement as text, or as one JSON line, and writes nothing", async () => {
		const { events } = scenario();
		const root = await tmp("revenue-share-cli");
		try {
			await writeLog(root, events);
			const text = atm([
				"--root",
				root,
				"--school",
				SCHOOL,
				"--month",
				"2026-02",
			]);
			expect(text.exitCode).toBe(0);
			expect(text.stdout.toString()).toBe(
				formatShareStatement(
					shareStatement({ events, school: SCHOOL, month: "2026-02" }),
				),
			);
			const json = atm([
				"--root",
				root,
				"--school",
				SCHOOL,
				"--month",
				"2026-02",
				"--json",
			]);
			expect(json.exitCode).toBe(0);
			const lines = json.stdout.toString().trimEnd().split("\n");
			expect(lines).toHaveLength(1);
			expect(JSON.parse(lines[0] as string)).toEqual({
				ok: true,
				...shareStatement({ events, school: SCHOOL, month: "2026-02" }),
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a month that is not YYYY-MM, a school with no events and a missing option exit 2 with one line", async () => {
		const { events } = scenario();
		const root = await tmp("revenue-share-cli-bad");
		try {
			await writeLog(root, events);
			const bad = atm([
				"--root",
				root,
				"--school",
				SCHOOL,
				"--month",
				"2026-1",
			]);
			expect(bad.exitCode).toBe(2);
			expect(bad.stderr.toString().trim().split("\n")).toHaveLength(1);
			const none = atm([
				"--root",
				root,
				"--school",
				"sch_none",
				"--month",
				"2026-01",
			]);
			expect(none.exitCode).toBe(2);
			expect(none.stderr.toString()).toContain("no events");
			expect(atm(["--root", root, "--school", SCHOOL]).exitCode).toBe(2);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
