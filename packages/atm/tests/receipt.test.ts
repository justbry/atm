/**
 * Signed receipts (`src/ledger/receipt.ts`): the family's copy of a paid or refunded payment, regenerated from the event.
 * Keys are made at test time; no key or digest is written into this file.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readEvents } from "../src/ledger/files.js";
import {
	checkReceiptAgainstEvents,
	receiptOf,
	signReceipt,
	verifyReceipt,
} from "../src/ledger/receipt.js";
import { payloadSchemas } from "../src/ledger/schemas.js";
import { generateSigningKey } from "../src/ledger/sign.js";
import { canonicalize } from "../src/ledger/util.js";
import type { AtmEvent, AtmEventType, AtmSigner } from "../src/types.js";

const FIXTURE = join(import.meta.dir, "../fixtures/vibes-year");
const SCHOOL = "sch_vol";
const KEY_ID = "test-key-1";

let events: AtmEvent[] = [];
let signer: AtmSigner;
let keys: Record<string, string>;

const paymentOf = (type: AtmEventType): AtmEvent => {
	const event = events.find((e) => e.event_type === type);
	if (!event) throw new Error(`the fixture has no ${type}`);
	return event;
};

/** A copy of the event with the payload changed, as an edit to the books would leave it. */
const edited = (
	event: AtmEvent,
	payload: Record<string, unknown>,
): AtmEvent => ({ ...event, payload: { ...event.payload, ...payload } });

beforeAll(async () => {
	({ events } = await readEvents(FIXTURE, SCHOOL));
	const pair = generateSigningKey();
	signer = { keyId: KEY_ID, privateKeyPem: pair.privateKeyPem };
	keys = { [KEY_ID]: pair.publicKeyPem };
});

describe("receiptOf", () => {
	test("a membership payment: amount_paid, the invoice, no name or email", () => {
		const event = paymentOf("payment.succeeded");
		const receipt = receiptOf(event);
		expect(receipt).toMatchObject({
			v: 1,
			school: SCHOOL,
			key: event.key,
			event_id: event.id,
			event_type: "payment.succeeded",
			event_time: event.event_time,
			date: event.date,
			amount: event.payload.amount_paid as number,
			currency: "usd",
			stripe_id: event.payload.id as string,
			cause: null,
		});
		const text = canonicalize(receipt);
		expect(text).not.toContain("billing_email");
		expect(text).not.toContain(event.payload.billing_email as string);
		expect(text).not.toContain(event.payload.billing_name as string);
	});

	test("a refund: its amount, its id and the payment that caused it", () => {
		const event = paymentOf("payment.refunded");
		expect(receiptOf(event)).toMatchObject({
			event_type: "payment.refunded",
			amount: event.payload.amount as number,
			stripe_id: event.payload.id as string,
			cause: event.cause ?? null,
		});
	});

	test("the Stripe objects the payload names go in refs; none means no refs", () => {
		const event = edited(paymentOf("payment.refunded"), {
			charge: "ch_1",
			invoice: "in_1",
		});
		expect(receiptOf(event)?.refs).toEqual({ charge: "ch_1", invoice: "in_1" });
		expect(receiptOf(paymentOf("payment.succeeded"))?.refs).toBeUndefined();
	});

	test("the same event gives byte-identical receipts and signatures", () => {
		const event = paymentOf("payment.succeeded");
		const first = signReceipt(receiptOf(event) as never, signer);
		const second = signReceipt(
			receiptOf(JSON.parse(JSON.stringify(event)) as AtmEvent) as never,
			signer,
		);
		expect(canonicalize(second)).toBe(canonicalize(first));
	});

	test("event_hash is sha256 of the event's canonical form, pinned on a fixed event", () => {
		const event = {
			v: 1,
			id: "01KF6B43S000000A6T73VEVRVS",
			school: "sch_pin",
			source: "stripe",
			event_type: "payment.succeeded",
			event_time: "2026-01-17T16:03:00Z",
			ingest_time: "2026-01-17T16:03:01Z",
			date: "2026-01-17",
			tz: "America/Denver",
			key: "family:fam_pin",
			labels: {},
			idem: "stripe:in_pin",
			text: "membership payment",
			postings: [],
			payload: {
				id: "in_pin",
				amount_paid: 1000,
				fee: 0,
				currency: "usd",
				customer: "cus_pin",
			},
		} as unknown as AtmEvent;
		const pinned =
			'{"date":"2026-01-17","event_time":"2026-01-17T16:03:00Z","event_type":"payment.succeeded","id":"01KF6B43S000000A6T73VEVRVS","idem":"stripe:in_pin","ingest_time":"2026-01-17T16:03:01Z","key":"family:fam_pin","labels":{},"payload":{"amount_paid":1000,"currency":"usd","customer":"cus_pin","fee":0,"id":"in_pin"},"postings":[],"school":"sch_pin","source":"stripe","text":"membership payment","tz":"America/Denver","v":1}';
		expect(canonicalize(event)).toBe(pinned);
		expect(receiptOf(event)?.event_hash).toBe(
			createHash("sha256").update(pinned).digest("hex"),
		);
	});

	test("every other event type gets no receipt", () => {
		const receipted = new Set(["payment.succeeded", "payment.refunded"]);
		const base = paymentOf("payment.succeeded");
		for (const type of Object.keys(payloadSchemas)) {
			if (receipted.has(type)) continue;
			expect(
				receiptOf({ ...base, event_type: type as AtmEventType }),
			).toBeNull();
		}
	});

	test("a missing or wrong required field throws, naming it", () => {
		const event = paymentOf("payment.succeeded");
		expect(() => receiptOf(edited(event, { amount_paid: undefined }))).toThrow(
			"payload.amount_paid",
		);
		expect(() => receiptOf(edited(event, { amount_paid: 1.5 }))).toThrow(
			"payload.amount_paid",
		);
		expect(() => receiptOf(edited(event, { currency: 5 }))).toThrow(
			"payload.currency",
		);
		expect(() => receiptOf(edited(event, { id: "" }))).toThrow("payload.id");
	});
});

describe("verifyReceipt", () => {
	test("a receipt signed by a known key is valid", () => {
		const signed = signReceipt(
			receiptOf(paymentOf("payment.succeeded")) as never,
			signer,
		);
		expect(verifyReceipt(signed, keys)).toEqual({ ok: true });
	});

	test("changing any signed field breaks the signature", () => {
		const signed = signReceipt(
			receiptOf(paymentOf("payment.succeeded")) as never,
			signer,
		);
		const changes: Record<string, unknown>[] = [
			{ amount: signed.receipt.amount + 1 },
			{ event_time: "2026-01-18T16:03:00Z" },
			{ stripe_id: "in_other" },
			{ event_hash: "0".repeat(64) },
		];
		for (const change of changes)
			expect(
				verifyReceipt(
					{ ...signed, receipt: { ...signed.receipt, ...change } },
					keys,
				),
			).toEqual({ ok: false, reason: "bad_signature" });
	});

	test("an unknown key id, or another key, is refused", () => {
		const signed = signReceipt(
			receiptOf(paymentOf("payment.succeeded")) as never,
			signer,
		);
		expect(verifyReceipt({ ...signed, key_id: "nope" }, keys)).toEqual({
			ok: false,
			reason: "unknown_key",
		});
		const other = generateSigningKey();
		expect(verifyReceipt(signed, { [KEY_ID]: other.publicKeyPem })).toEqual({
			ok: false,
			reason: "bad_signature",
		});
		expect(verifyReceipt(signed, { [KEY_ID]: "not a key" })).toEqual({
			ok: false,
			reason: "bad_signature",
		});
	});

	test("anything that is not a signed receipt is malformed, never a throw", () => {
		const signed = signReceipt(
			receiptOf(paymentOf("payment.succeeded")) as never,
			signer,
		);
		const bad: unknown[] = [
			null,
			"text",
			[],
			{},
			{ ...signed, extra: 1 },
			{ ...signed, receipt: { ...signed.receipt, extra: 1 } },
			{ ...signed, receipt: { ...signed.receipt, amount: "1" } },
			{ ...signed, receipt: { ...signed.receipt, event_type: "credit.low" } },
			{ ...signed, receipt: { ...signed.receipt, refs: { other: "x" } } },
			{ receipt: signed.receipt, key_id: KEY_ID },
		];
		for (const value of bad)
			expect(verifyReceipt(value, keys)).toEqual({
				ok: false,
				reason: "malformed",
			});
	});

	test("signing with a key that is not Ed25519 throws", async () => {
		const { generateKeyPairSync } = await import("node:crypto");
		const { privateKey } = generateKeyPairSync("ec", {
			namedCurve: "P-256",
			privateKeyEncoding: { type: "pkcs8", format: "pem" },
			publicKeyEncoding: { type: "spki", format: "pem" },
		});
		expect(() =>
			signReceipt(receiptOf(paymentOf("payment.succeeded")) as never, {
				keyId: KEY_ID,
				privateKeyPem: privateKey,
			}),
		).toThrow("not ed25519");
	});
});

describe("checkReceiptAgainstEvents", () => {
	test("unchanged books give the same receipt", () => {
		for (const event of events) {
			const receipt = receiptOf(event);
			if (receipt === null) continue;
			expect(
				checkReceiptAgainstEvents(signReceipt(receipt, signer), events),
			).toEqual({ ok: true });
		}
	});

	test("an edit, a deletion or a changed type is caught", () => {
		const event = paymentOf("payment.succeeded");
		const signed = signReceipt(receiptOf(event) as never, signer);
		const others = events.filter((e) => e.id !== event.id);
		expect(
			checkReceiptAgainstEvents(signed, [
				...others,
				edited(event, { amount_paid: 1 }),
			]),
		).toEqual({ ok: false, reason: "event_changed" });
		expect(
			checkReceiptAgainstEvents(signed, [...others, edited(event, { fee: 0 })]),
		).toEqual({ ok: false, reason: "event_changed" });
		expect(
			checkReceiptAgainstEvents(signed, [
				...others,
				edited(event, { amount_paid: undefined }),
			]),
		).toEqual({ ok: false, reason: "event_changed" });
		expect(checkReceiptAgainstEvents(signed, others)).toEqual({
			ok: false,
			reason: "missing_event",
		});
		expect(
			checkReceiptAgainstEvents(signed, [
				...others,
				{ ...event, event_type: "payout.paid" },
			]),
		).toEqual({ ok: false, reason: "not_receipted" });
	});
});
