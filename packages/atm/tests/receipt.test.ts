/**
 * Signed receipts (`src/ledger/receipt.ts`): a receipt is a pure function of its event, signed with Ed25519, so the books
 * make the family's copy again byte for byte. The golden pins canonical v1: the event's bytes and hash, the receipt's
 * bytes and the signature. Set UPDATE_GOLDEN=1 to rewrite it, which a change to `canonicalize` must never need.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import envelope from "../schema/envelope.v1.json";
import { readEvents } from "../src/ledger/files.js";
import {
	checkReceiptAgainstEvents,
	receiptOf,
	signReceipt,
	verifyReceipt,
} from "../src/ledger/receipt.js";
import { canonicalize, sha256Hex } from "../src/ledger/util.js";
import { validateEvent } from "../src/ledger/validate.js";
import type { AtmEvent, AtmReceipt, AtmSignedReceipt } from "../src/types.js";
import {
	otherSigner,
	TEST_KEY_ID,
	testKeyFingerprint,
	testKeys,
	testSigner,
} from "./signing-keys.js";

const GOLDEN_DIR = join(import.meta.dir, "golden/receipt");
const FIXTURE = join(import.meta.dir, "../fixtures/vibes-year");
const SCHOOL = "sch_vol";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

let events: AtmEvent[] = [];
let payment: AtmEvent;
let refund: AtmEvent;
let golden: AtmEvent;

beforeAll(async () => {
	({ events } = await readEvents(FIXTURE, SCHOOL));
	payment = events.find(
		(event) => event.event_type === "payment.succeeded",
	) as AtmEvent;
	refund = events.find(
		(event) => event.event_type === "payment.refunded",
	) as AtmEvent;
	golden = JSON.parse(
		await readFile(join(GOLDEN_DIR, "event.json"), "utf8"),
	) as AtmEvent;
});

const signed = (event: AtmEvent): AtmSignedReceipt =>
	signReceipt(receiptOf(event) as AtmReceipt, testSigner);

describe("a receipt is a pure function of its event", () => {
	test("the same event gives the same receipt bytes and, with the same key, the same signature, also in another process", () => {
		const first = signed(payment);
		expect(canonicalize(signed(clone(payment)))).toBe(canonicalize(first));
		const script = `
			import { receiptOf, signReceipt } from ${JSON.stringify(join(import.meta.dir, "../src/ledger/receipt.js"))};
			import { canonicalize } from ${JSON.stringify(join(import.meta.dir, "../src/ledger/util.js"))};
			import { testSigner } from ${JSON.stringify(join(import.meta.dir, "signing-keys.js"))};
			const event = JSON.parse(await Bun.stdin.text());
			process.stdout.write(canonicalize(signReceipt(receiptOf(event), testSigner)));
		`;
		const run = Bun.spawnSync([process.execPath, "-e", script], {
			stdin: new TextEncoder().encode(JSON.stringify(payment)),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(run.stderr.toString()).toBe("");
		expect(run.stdout.toString()).toBe(canonicalize(first));
	});

	test("golden: a fixed event gives the pinned event bytes and hash, receipt bytes and signature (canonical v1)", async () => {
		expect(validateEvent(golden)).toEqual({ ok: true, errors: [] });
		const receipt = receiptOf(golden);
		expect(receipt?.event_hash).toBe(sha256Hex(canonicalize(golden)));
		const files: Record<string, string> = {
			"event.canonical.jsonl": `${canonicalize(golden)}\n`,
			"receipt.canonical.jsonl": `${canonicalize(receipt)}\n`,
			"signed.canonical.jsonl": `${canonicalize(signed(golden))}\n`,
			"key.json": `${JSON.stringify({ key_id: TEST_KEY_ID, spki_sha256: testKeyFingerprint() }, null, "\t")}\n`,
		};
		if (process.env.UPDATE_GOLDEN) {
			await mkdir(GOLDEN_DIR, { recursive: true });
			for (const [name, text] of Object.entries(files))
				await writeFile(join(GOLDEN_DIR, name), text);
		}
		for (const [name, text] of Object.entries(files))
			expect(text).toBe(await readFile(join(GOLDEN_DIR, name), "utf8"));
		const pinned = JSON.parse(
			await readFile(join(GOLDEN_DIR, "signed.canonical.jsonl"), "utf8"),
		);
		expect(verifyReceipt(pinned, testKeys)).toEqual({ ok: true });
	});
});

describe("receiptOf", () => {
	test("a payment's amount is amount_paid and its Stripe id the invoice id", () => {
		const receipt = receiptOf(payment);
		expect(receipt).toMatchObject({
			v: 1,
			school: SCHOOL,
			key: payment.key,
			event_id: payment.id,
			event_type: "payment.succeeded",
			event_time: payment.event_time,
			date: payment.date,
			amount: payment.payload.amount_paid as number,
			currency: "usd",
			stripe_id: payment.payload.id as string,
			cause: null,
		});
		expect(receipt?.stripe_id).toStartWith("in_");
	});

	test("a refund's amount is amount and its Stripe id the payload's id; cause passes through", () => {
		expect(receiptOf(refund)).toMatchObject({
			event_type: "payment.refunded",
			amount: refund.payload.amount as number,
			stripe_id: refund.payload.id as string,
			cause: refund.cause as string,
		});
		expect(refund.cause).toBeString();
	});

	test("no name or email reaches the receipt", () => {
		expect(payment.payload.billing_email).toBeString();
		expect(payment.payload.billing_name).toBeString();
		const text = canonicalize(receiptOf(payment));
		expect(text).not.toContain("billing_");
		expect(text).not.toContain(payment.payload.billing_email as string);
		expect(text).not.toContain(payment.payload.billing_name as string);
	});

	test("a missing or wrongly typed required payload field throws, naming it", () => {
		const cases: [AtmEvent, string, unknown][] = [
			[payment, "amount_paid", undefined],
			[payment, "amount_paid", "26000"],
			[payment, "amount_paid", 260.5],
			[payment, "currency", undefined],
			[payment, "id", 7],
			[refund, "amount", undefined],
			[refund, "currency", ""],
			[refund, "id", null],
		];
		for (const [event, field, value] of cases) {
			const broken = clone(event);
			if (value === undefined) delete broken.payload[field];
			else broken.payload[field] = value;
			expect(() => receiptOf(broken)).toThrow(`payload.${field}`);
		}
	});

	test("every other event type gives null", () => {
		const types = (envelope.properties.event_type as { enum: string[] }).enum;
		const receipted = types.filter((type) => {
			const event = { ...clone(payment), event_type: type } as AtmEvent;
			event.payload.amount = 100;
			return receiptOf(event) !== null;
		});
		expect(receipted).toEqual(["payment.succeeded", "payment.refunded"]);
	});
});

describe("verifyReceipt", () => {
	test("a signed receipt verifies", () => {
		expect(verifyReceipt(signed(payment), testKeys)).toEqual({ ok: true });
		expect(verifyReceipt(signed(refund), testKeys)).toEqual({ ok: true });
	});

	test("changing amount, event_time, stripe_id or event_hash breaks the signature", () => {
		const changes: ((receipt: AtmReceipt) => void)[] = [
			(receipt) => {
				receipt.amount += 1;
			},
			(receipt) => {
				receipt.event_time = "2026-01-17T16:04:00Z";
			},
			(receipt) => {
				receipt.stripe_id = "in_other";
			},
			(receipt) => {
				receipt.event_hash = sha256Hex("another event");
			},
		];
		for (const change of changes) {
			const tampered = clone(signed(payment));
			change(tampered.receipt);
			expect(verifyReceipt(tampered, testKeys)).toEqual({
				ok: false,
				reason: "bad_signature",
			});
		}
	});

	test("a signature by another key, or a changed signature, is bad_signature", () => {
		const byOther = {
			...signReceipt(receiptOf(payment) as AtmReceipt, otherSigner),
			key_id: TEST_KEY_ID,
		};
		expect(verifyReceipt(byOther, testKeys)).toMatchObject({
			reason: "bad_signature",
		});
		const good = signed(payment);
		const flipped = `${good.sig.startsWith("A") ? "B" : "A"}${good.sig.slice(1)}`;
		expect(verifyReceipt({ ...good, sig: flipped }, testKeys)).toMatchObject({
			reason: "bad_signature",
		});
	});

	test("an unknown key id is unknown_key; a non-Ed25519 key cannot sign", () => {
		const receipt = signed(payment);
		expect(verifyReceipt({ ...receipt, key_id: "nobody" }, testKeys)).toEqual({
			ok: false,
			reason: "unknown_key",
		});
		expect(
			verifyReceipt({ ...receipt, key_id: "constructor" }, testKeys),
		).toMatchObject({ reason: "unknown_key" });
		const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
		expect(
			verifyReceipt(receipt, {
				[TEST_KEY_ID]: String(
					rsa.publicKey.export({ format: "pem", type: "spki" }),
				),
			}),
		).toMatchObject({ reason: "unknown_key" });
		expect(() =>
			signReceipt(receiptOf(payment) as AtmReceipt, {
				keyId: "rsa-1",
				privateKeyPem: String(
					rsa.privateKey.export({ format: "pem", type: "pkcs8" }),
				),
			}),
		).toThrow("rsa");
	});

	test("untrusted input is malformed, never an exception", () => {
		const good = signed(payment);
		const { cause: _cause, ...withoutCause } = good.receipt;
		const inputs: unknown[] = [
			null,
			undefined,
			"garbage",
			42,
			[],
			{},
			{ receipt: good.receipt, key_id: TEST_KEY_ID },
			{ ...good, receipt: withoutCause },
			{ ...good, extra: true },
			{ ...good, receipt: { ...good.receipt, name: "Test Member" } },
			{ ...good, receipt: { ...good.receipt, amount: "26000" } },
			{ ...good, receipt: { ...good.receipt, v: 2 } },
			{ ...good, sig: `${good.sig}==` },
			{ ...good, key_id: 1 },
		];
		for (const input of inputs)
			expect(verifyReceipt(input, testKeys)).toEqual({
				ok: false,
				reason: "malformed",
			});
	});
});

describe("checkReceiptAgainstEvents", () => {
	test("an unchanged event is ok", () => {
		expect(checkReceiptAgainstEvents(signed(payment), events)).toEqual({
			ok: true,
		});
	});

	test("an edited amount or any other payload field is event_changed", () => {
		const receipt = signed(payment);
		const edits: ((event: AtmEvent) => void)[] = [
			(event) => {
				event.payload.amount_paid = (event.payload.amount_paid as number) + 1;
			},
			(event) => {
				event.payload.fee = 0;
			},
			(event) => {
				event.text = "edited";
			},
			(event) => {
				delete event.payload.amount_paid;
			},
		];
		for (const edit of edits) {
			const edited = events.map((event) => {
				if (event.id !== payment.id) return event;
				const copy = clone(event);
				edit(copy);
				return copy;
			});
			expect(checkReceiptAgainstEvents(receipt, edited)).toEqual({
				ok: false,
				reason: "event_changed",
			});
		}
	});

	test("a deleted event is missing_event", () => {
		expect(
			checkReceiptAgainstEvents(
				signed(payment),
				events.filter((event) => event.id !== payment.id),
			),
		).toEqual({ ok: false, reason: "missing_event" });
	});

	test("an event whose type was changed to one without receipts is not_receipted", () => {
		const changed = events.map((event) =>
			event.id === payment.id
				? ({ ...event, event_type: "payment.disputed" } as AtmEvent)
				: event,
		);
		expect(checkReceiptAgainstEvents(signed(payment), changed)).toEqual({
			ok: false,
			reason: "not_receipted",
		});
	});
});
