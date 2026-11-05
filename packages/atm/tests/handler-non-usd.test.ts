/**
 * A non-USD invoice, refund or payout through the real handler. The books are USD only, so no money line is made; what
 * changed is that the delivery says so: 200 `non_usd` (not `applied`), a `money.skipped` event in the outbox for each
 * line left out, the claim's outcome, a line to `deps.warn`, and a count in `reconcile` and `atm report`. The credits of
 * an invoice are granted exactly as for a USD one: a refusal would block them, and Stripe would retry a currency that
 * cannot change.
 */
import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { readEvents } from "../src/ledger/files.js";
import { reconcile } from "../src/ledger/reconcile.js";
import { formatReconcile } from "../src/ledger/reconcile-files.js";
import { reportMonth } from "../src/ledger/report.js";
import { shipOutbox } from "../src/ledger/ship.js";
import { validateEvent } from "../src/ledger/validate.js";
import { FolderStore } from "../src/store/folder-store.js";
import type { AtmEvent } from "../src/types.js";
import {
	FEE,
	GROSS,
	HOUR,
	harness,
	linked,
	paid,
	payout,
	REFUNDED,
	refund,
	SCHOOL,
	SHIPPED_AT,
	T0,
} from "./handler-harness.js";
import { hasHledger, tmp } from "./helpers.js";
import type { RawEvent } from "./stripe-events.js";

const BIN = join(import.meta.dir, "../src/bin.ts");

const inEuros = (event: RawEvent): RawEvent => {
	event.data.object.currency = "eur";
	return event;
};

/** A handler whose `warn` is a list, so a test reads what would have gone to stderr. */
const quiet = (fees?: Record<string, number | null>) => {
	const h = harness(fees);
	const warned: string[] = [];
	h.deps.warn = (line) => warned.push(line);
	return { ...h, warned };
};

const ofType = (events: AtmEvent[], type: string) =>
	events.filter((event) => event.event_type === type);

const claimOutcome = (h: ReturnType<typeof quiet>, eventId: string) =>
	(
		h.db.all<{ outcome: string }>(
			`SELECT outcome FROM atm_event_claims WHERE event_id = ?`,
			[eventId],
		) as { outcome: string }[]
	)[0]?.outcome;

describe("a non-USD invoice", () => {
	test("is answered 200 non_usd, grants the credits as a USD one does, books no payment and leaves a marker", () => {
		const usd = quiet({ in_1: FEE });
		expect(usd.deliver(paid()).body.outcome).toBe("applied");

		const eur = quiet({ in_1: FEE });
		const response = eur.deliver(inEuros(paid()));
		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({
			outcome: "non_usd",
			stripeEventId: "evt_in_1",
			wroteRows: true,
			skipped: [`invoice in_1 ${GROSS} eur`],
		});
		const events = eur.outbox();
		// no money line
		expect(ofType(events, "payment.succeeded")).toEqual([]);
		// the credits are the same events as for the USD invoice (the same ids, the same units)
		const credits = (list: AtmEvent[]) =>
			list
				.filter((event) => event.event_type.startsWith("credit."))
				.map((event) => [event.event_type, event.idem, event.postings]);
		expect(credits(events)).toEqual(credits(usd.outbox()));
		expect(credits(events).length).toBeGreaterThan(0);
		// the marker: no postings, and the count's facts in the payload
		const [marker] = ofType(events, "money.skipped");
		expect(marker?.postings).toEqual([]);
		expect(marker?.idem).toBe("stripe:in_1:non_usd");
		expect(marker?.payload).toEqual({
			id: "in_1",
			kind: "invoice",
			reason: "non_usd",
			currency: "eur",
			amount: GROSS,
		});
		expect(validateEvent(marker as AtmEvent).ok).toBe(true);
		// the claim keeps the outcome, so a count from the handler's own database works too
		expect(eur.claim("evt_in_1")?.state).toBe("done");
		expect(claimOutcome(eur, "evt_in_1")).toBe("non_usd");
		// and it says so out loud, once
		expect(eur.warned).toHaveLength(1);
		expect(eur.warned[0]).toContain("invoice in_1");
		expect(eur.warned[0]).toContain("eur");
		expect(eur.warned[0]).toContain("not in USD");
	});

	test("a USD invoice is still applied, with no marker and nothing said", () => {
		const h = quiet({ in_1: FEE });
		expect(h.deliver(paid()).body.outcome).toBe("applied");
		expect(ofType(h.outbox(), "money.skipped")).toEqual([]);
		expect(h.warned).toEqual([]);
		expect(claimOutcome(h, "evt_in_1")).toBe("applied");
	});

	test("an invoice that paid nothing is not a skipped payment, in any currency", () => {
		const h = quiet();
		const free = inEuros(paid());
		free.data.object.amount_paid = 0;
		expect(h.deliver(free).body.outcome).toBe("applied");
		expect(ofType(h.outbox(), "money.skipped")).toEqual([]);
	});

	test("a redelivery is a duplicate and says nothing again; the same invoice under another event id leaves one marker", () => {
		const h = quiet();
		h.deliver(inEuros(paid()));
		expect(h.deliver(inEuros(paid())).body.outcome).toBe("duplicate");
		const again = inEuros(paid());
		again.id = "evt_in_1_resent";
		// the invoice is already decided: nothing to do, so nothing to skip
		expect(h.deliver(again).body.outcome).toBe("applied");
		expect(ofType(h.outbox(), "money.skipped")).toHaveLength(1);
		expect(h.warned).toHaveLength(1);
	});

	test("its refund is non_usd too: no payment.refunded, a marker of kind refund", () => {
		const h = quiet();
		h.deliver(inEuros(paid()));
		h.deliver(linked("in_1"), T0 + 1000);
		const response = h.deliver(
			inEuros(refund(REFUNDED, { at: T0 + HOUR })),
			T0 + HOUR,
		);
		expect(response.body).toMatchObject({
			outcome: "non_usd",
			skipped: [`refund evt_re_1 ${REFUNDED} eur`],
		});
		const events = h.outbox();
		expect(ofType(events, "payment.refunded")).toEqual([]);
		expect(ofType(events, "money.skipped").map((e) => e.payload.kind)).toEqual([
			"invoice",
			"refund",
		]);
	});
});

describe("a non-USD payout", () => {
	test("is answered 200 non_usd with a marker of kind payout and no payout line", () => {
		const h = quiet();
		const response = h.deliver(
			inEuros(
				payout({ eventId: "evt_po_eur", payoutId: "po_eur", amount: 9000 }),
			),
		);
		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({
			outcome: "non_usd",
			events: 1,
			wroteRows: false,
			skipped: ["payout po_eur 9000 eur"],
		});
		const events = h.outbox();
		expect(events.map((e) => e.event_type)).toEqual(["money.skipped"]);
		expect(events[0]?.payload).toEqual({
			id: "po_eur",
			kind: "payout",
			reason: "non_usd",
			currency: "eur",
			amount: 9000,
		});
		expect(claimOutcome(h, "evt_po_eur")).toBe("non_usd");
		expect(h.warned).toHaveLength(1);
	});

	test("the same payout again under another event id leaves one marker; a USD payout beside it is a normal line", () => {
		const h = quiet();
		const euros = (eventId: string) =>
			inEuros(payout({ eventId, payoutId: "po_eur", amount: 9000 }));
		h.deliver(euros("evt_a"));
		h.deliver(euros("evt_b"));
		expect(h.deliver(payout()).body.outcome).toBe("applied");
		expect(h.outbox().map((e) => e.event_type)).toEqual([
			"money.skipped",
			"payout.paid",
		]);
	});
});

describe("the count in reconcile and atm report", () => {
	const shipped = async (h: ReturnType<typeof quiet>) => {
		const root = await tmp("handler-non-usd");
		const result = await shipOutbox({
			db: h.db,
			store: new FolderStore({ root }),
			school: SCHOOL,
			nowMs: () => SHIPPED_AT,
		});
		expect(result.conflicts).toEqual([]);
		return root;
	};

	/** A euro invoice, a euro payout and a dollar payout, shipped. */
	const mixed = () => {
		const h = quiet();
		h.deliver(inEuros(paid()));
		h.deliver(
			inEuros(
				payout({ eventId: "evt_po_eur", payoutId: "po_eur", amount: 9000 }),
			),
			T0 + 48 * HOUR,
		);
		h.deliver(payout(), T0 + 49 * HOUR);
		return h;
	};

	test("reconcile counts the skipped lines of the period, and prints the count", async () => {
		const root = await shipped(mixed());
		try {
			const { events } = await readEvents(root, SCHOOL);
			const result = reconcile({
				events,
				stripe: { invoices: [] },
				period: { month: "2026-01" },
			});
			expect(result.skipped).toEqual({ non_usd: 2 });
			expect(formatReconcile(result)).toContain(
				"skipped in the log: 2 money line(s) not booked (non_usd)",
			);
			// another month has none
			const february = reconcile({
				events,
				stripe: { invoices: [] },
				period: { month: "2026-02" },
				timeZone: "America/Denver",
			});
			expect(february.skipped).toEqual({});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a log with none has an empty count", async () => {
		const h = quiet({ in_1: FEE });
		h.deliver(paid());
		const root = await shipped(h);
		try {
			const { events } = await readEvents(root, SCHOOL);
			const result = reconcile({
				events,
				stripe: { invoices: [] },
				period: { month: "2026-01" },
			});
			expect(result.skipped).toEqual({});
			expect(formatReconcile(result)).not.toContain("skipped in the log");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test.skipIf(!hasHledger)(
		"atm report counts them on stderr, leaves stdout to hledger, and the journal still balances",
		async () => {
			const root = await shipped(mixed());
			try {
				const run = await reportMonth({
					root,
					school: SCHOOL,
					month: "2026-01",
					report: "income-statement",
				});
				expect(run.skippedNonUsd).toEqual({ inMonth: 2, total: 2 });
				const cli = Bun.spawnSync(
					[
						process.execPath,
						BIN,
						"report",
						"--root",
						root,
						"--school",
						SCHOOL,
						"--month",
						"2026-01",
						"--report",
						"income-statement",
					],
					{ stdout: "pipe", stderr: "pipe" },
				);
				expect(cli.exitCode).toBe(0);
				expect(cli.stderr.toString()).toBe(
					"atm report: 2 non-USD money line(s) skipped in 2026-01 (2 in all events); the reports are USD only and leave them out\n",
				);
				expect(cli.stdout.toString()).toContain("Income Statement");
				const check = Bun.spawnSync(
					[
						"hledger",
						"-f",
						"main.journal",
						"check",
						"balanced",
						"accounts",
						"commodities",
					],
					{
						cwd: join(root, "schools", SCHOOL),
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				expect(check.stderr.toString()).toBe("");
				expect(check.exitCode).toBe(0);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);
});
