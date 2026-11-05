/**
 * No personal data in the handler's database. Every recorded Stripe fixture goes through the real handler into a SQLite
 * FILE (write-ahead log on), and the bytes of the file and of its log are searched for every personal string the fixtures
 * hold, computed here from the fixtures, and for any `://`. A control proves the search finds a string that is there.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { bunSqlite } from "../src/handler/bun-sqlite.js";
import { HANDLER_DDL } from "../src/handler/schema.js";
import {
	RECORDED_SCHOOL,
	recordedMenu,
	recordedPriceIds,
} from "./e2e-recorded.js";
import {
	FAMILY,
	HOUR,
	harness,
	linked,
	SCHOOL,
	T0,
	tierKey,
} from "./handler-harness.js";
import { tmp } from "./helpers.js";
import {
	databaseBytes,
	foundIn,
	personalStringsOf,
	walMode,
} from "./stored-inputs-bytes.js";
import { chargeRefunded, invoicePaid, type RawEvent } from "./stripe-events.js";

const recordedDir = join(
	import.meta.dir,
	"../fixtures/billing/stripe/recorded",
);
const readJson = (path: string): RawEvent =>
	JSON.parse(readFileSync(path, "utf8"));
const jsonFilesIn = (dir: string): string[] =>
	readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => join(dir, name));

/** The scenario directories of whole delivered events, in the order Stripe created them. */
const scenarios = readdirSync(join(recordedDir, "delivered"), {
	withFileTypes: true,
})
	.filter((entry) => entry.isDirectory())
	.map((entry) => join(recordedDir, "delivered", entry.name))
	.sort();
/** The single-event files: the top-level recordings and the discounted invoices (another school's, `sch_probe`). */
const singles = [
	...jsonFilesIn(recordedDir),
	...jsonFilesIn(join(recordedDir, "discount")),
];

const directories: string[] = [];
afterAll(async () => {
	for (const dir of directories)
		await rm(dir, { recursive: true, force: true });
});

/** A handler on a SQLite file in write-ahead log mode. */
const fileHandler = async (
	options: Parameters<typeof harness>[1] = {},
	fees?: Parameters<typeof harness>[0],
) => {
	const dir = await tmp("inputs-privacy");
	directories.push(dir);
	const path = join(dir, "handler.sqlite");
	const raw = walMode(new Database(path));
	const h = harness(fees, { ...options, raw });
	return { ...h, path, raw };
};

/** Delivers events in order and retries the 409s, as Stripe does; no outcome is assumed, only that nothing throws. */
const deliverAll = (
	deliver: (event: RawEvent, at?: number) => unknown,
	events: RawEvent[],
) => {
	let pending = events;
	for (let pass = 0; pass < 4 && pending.length > 0; pass += 1) {
		const retry: RawEvent[] = [];
		for (const event of pending) {
			const response = deliver(event, event.created * 1000) as {
				status: number;
			};
			if (response.status === 409) retry.push(event);
		}
		pending = retry;
	}
};

describe("the handler's database file", () => {
	test("holds none of the personal strings of the recorded fixtures, and no `://`, in the file or in its log", async () => {
		const personal = new Set<string>();
		const rawBodies: string[] = [];
		const note = (event: RawEvent) => {
			personalStringsOf(event, personal);
			rawBodies.push(JSON.stringify(event));
		};

		// the delivered scenarios, on the recorded school and menu
		const delivered = await fileHandler({
			school: RECORDED_SCHOOL,
			menu: recordedMenu,
			env: "test",
			priceIds: recordedPriceIds(),
		});
		for (const dir of scenarios) {
			const events = jsonFilesIn(dir).map(readJson);
			for (const event of events) note(event);
			deliverAll(delivered.deliver, events);
		}
		// the single events, on the school they name (most are refused for a price the menu lacks: refusals are stored too)
		const probe = await fileHandler({ school: "sch_probe", env: "test" });
		const singleEvents = singles.map(readJson);
		for (const event of singleEvents) note(event);
		deliverAll(probe.deliver, singleEvents);

		const stored = (raw: Database) =>
			(
				raw.query(`SELECT COUNT(*) AS n FROM atm_event_inputs`).get() as {
					n: number;
				}
			).n;
		// the sweep means something only if inputs were stored: applied (the scenarios) and refused (the single events)
		expect(stored(delivered.raw)).toBeGreaterThan(30);
		expect(
			(
				probe.raw
					.query(
						`SELECT COUNT(*) AS n FROM atm_event_inputs WHERE outcome = 'refused'`,
					)
					.get() as { n: number }
			).n,
		).toBeGreaterThan(0);

		// the strings were computed from the fixtures, and are in the raw payloads
		expect(personal.size).toBeGreaterThan(10);
		const everything = rawBodies.join("\n");
		for (const text of personal) expect(everything).toContain(text);

		for (const h of [delivered, probe]) {
			const unfolded = databaseBytes(h.path);
			// the write-ahead log is in the sweep: it holds the writes until a checkpoint
			expect(existsSync(`${h.path}-wal`)).toBe(true);
			expect(statSync(`${h.path}-wal`).size).toBeGreaterThan(0);
			expect(unfolded.includes("atm_event_inputs")).toBe(true);
			expect(foundIn(unfolded, personal)).toEqual([]);
			expect(unfolded.includes("://")).toBe(false);
			h.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			const folded = databaseBytes(h.path);
			expect(foundIn(folded, personal)).toEqual([]);
			expect(folded.includes("://")).toBe(false);
		}
	});

	test("the control: the search finds the strings when a raw payload is kept", async () => {
		const h = await fileHandler({ school: RECORDED_SCHOOL, env: "test" });
		const events = jsonFilesIn(scenarios[0] ?? "").map(readJson);
		const personal = new Set<string>();
		for (const event of events) personalStringsOf(event, personal);
		expect(personal.size).toBeGreaterThan(0);
		h.raw.exec(`CREATE TABLE raw_copy (body TEXT)`);
		for (const event of events)
			h.raw.run(`INSERT INTO raw_copy (body) VALUES (?)`, [
				JSON.stringify(event),
			] as never);
		const bytes = databaseBytes(h.path);
		expect(foundIn(bytes, personal).length).toBe(personal.size);
		expect(bytes.includes("://")).toBe(true);
	});

	test("a delivery built with a name, an email, an address, a card, links and an extra metadata key keeps none of them", async () => {
		// strings made at test time, so there is no literal here to paste into another test
		const marker = randomBytes(6).toString("hex");
		const mine = {
			name: `Guardian ${marker}`,
			email: `guardian.${marker}@mail.example.test`,
			street: `${marker} Orchard Lane`,
			link: `https://pay.example.test/${marker}/receipt`,
			pdf: `https://pay.example.test/${marker}/invoice.pdf`,
			child: `Child ${marker}`,
			last4: marker.slice(0, 4),
			fingerprint: `fp_${marker}`,
			note: `Note about ${marker}`,
		};
		const h = await fileHandler({}, { in_p: 784 });
		const invoice = invoicePaid({
			eventId: "evt_in_p",
			invoiceId: "in_p",
			at: T0,
			subscriptionId: "sub_p",
			reason: "subscription_create",
			periodStart: T0,
			periodEnd: T0 + 30 * 24 * HOUR,
			lines: [{ lookupKey: tierKey(), amount: 26_000, interval: "month" }],
			metadata: {
				b4u_school: SCHOOL,
				family_id: FAMILY,
				child_name: mine.child,
				note: mine.note,
			},
		});
		Object.assign(invoice.data.object, {
			customer_name: mine.name,
			customer_email: mine.email,
			customer_address: { line1: mine.street, country: "US" },
			hosted_invoice_url: mine.link,
			invoice_pdf: mine.pdf,
		});
		const refund = chargeRefunded({
			eventId: "evt_re_p",
			chargeId: "ch_in_p",
			invoiceId: "in_p",
			amount: 5000,
			chargeAmount: 26_000,
			at: T0 + HOUR,
		});
		Object.assign(refund.data.object, {
			receipt_url: mine.link,
			receipt_email: mine.email,
			billing_details: { name: mine.name, email: mine.email },
			payment_method_details: {
				card: { last4: mine.last4, fingerprint: mine.fingerprint },
			},
		});
		expect(h.deliver(invoice).body.outcome).toBe("applied");
		expect(h.deliver(linked("in_p"), T0 + 1000).body.outcome).toBe("applied");
		expect(h.deliver(refund, T0 + HOUR).body.outcome).toBe("applied");
		const inputs = h.raw
			.query(`SELECT type FROM atm_event_inputs ORDER BY applied_order`)
			.all() as { type: string }[];
		expect(inputs.map((row) => row.type)).toEqual([
			"invoice.paid",
			"invoice_payment.paid",
			"charge.refunded",
		]);
		const needles = Object.values(mine);
		const raw = JSON.stringify([invoice, refund]);
		for (const needle of needles) expect(raw).toContain(needle);
		for (const checkpointed of [false, true]) {
			if (checkpointed) h.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			const bytes = databaseBytes(h.path);
			expect(foundIn(bytes, needles)).toEqual([]);
			expect(bytes.includes("://")).toBe(false);
		}
	});

	test("a database file made by bunSqlite on a path is the handler's own (the sweep reads what the handler wrote)", async () => {
		const dir = await tmp("inputs-privacy-wal");
		directories.push(dir);
		const path = join(dir, "x.sqlite");
		const raw = walMode(new Database(path));
		bunSqlite(raw).exec(HANDLER_DDL);
		const bytes = databaseBytes(path);
		expect(bytes.includes("atm_event_inputs")).toBe(true);
	});
});
