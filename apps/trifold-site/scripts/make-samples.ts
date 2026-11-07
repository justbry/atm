/**
 * Makes the site's sample receipt, its tampered copy, the sample school's public key and its October books, using atm
 * itself (packages/atm/src), so the browser verifier is checked against the real thing.
 *
 * The signing key is a fresh DEMO key made on every run and never written anywhere: only its public half ships. All
 * names and amounts are invented. Run with `bun run samples`; it overwrites src/lib/samples/*.json.
 */
import { generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	checkReceiptAgainstEvents,
	receiptOf,
	sealOf,
	signReceipt,
	signSeal,
	verifyReceipt,
	verifySeals,
} from "../../../packages/atm/src/index.ts";
import { validateEvent } from "../../../packages/atm/src/ledger/validate.ts";
import type {
	AtmEvent,
	AtmReceipt,
	AtmSigner,
} from "../../../packages/atm/src/types.ts";

const OUT = join(import.meta.dir, "../src/lib/samples");
const SCHOOL = "sch_juniper";
const KEY_ID = "juniper-demo-2026-10";
const TZ = "America/Boise";
const MONTH = "2026-10";
const PAYMENTS = 214;
const TUITION_CENTS = 80_000;
/** Two families pay a larger October invoice, so the month totals $171,400.00. */
const LARGER_CENTS = 90_000;
const SEALED_AT = "2026-11-01T15:00:00Z";
/** The receipt the site shows: the Kessler family's October tutoring, paid 2026-10-03. */
const SAMPLE_INVOICE = "in_1SGq4m2eZvKYlo2C9bXk3Qa7";
const SAMPLE_FAMILY = "family:fam_k3s5";
const TAMPERED_CENTS = 120_000;

/** Stripe's US card pricing, 2.9% + 30¢, for a realistic fee line. */
const STRIPE_PERCENT = 0.029;
const STRIPE_FIXED_CENTS = 30;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A small seeded generator, so the events (not the key) come out the same on every run. */
const seeded = (seed: number) => {
	let state = seed >>> 0;
	return () => {
		state = (state * 1_664_525 + 1_013_904_223) >>> 0;
		return state / 2 ** 32;
	};
};
const random = seeded(2026_10);

const ulid = (ms: number): string => {
	let time = "";
	let rest = ms;
	for (let index = 0; index < 10; index++) {
		time = CROCKFORD[rest % 32] + time;
		rest = Math.floor(rest / 32);
	}
	let tail = "";
	for (let index = 0; index < 16; index++)
		tail += CROCKFORD[Math.floor(random() * 32)];
	return time + tail;
};

const dollars = (cents: number): string => (cents / 100).toFixed(2);

const familyKey = (index: number): string =>
	`family:fam_${(index * 7919 + 4099).toString(36).padStart(4, "0").slice(-4)}`;

const paymentEvent = (
	index: number,
	day: number,
	cents: number,
	invoice: string,
	key: string,
): AtmEvent => {
	const minute = Math.floor(random() * 360);
	const eventMs = Date.UTC(2026, 9, day, 15, minute, 0);
	const fee = Math.round(cents * STRIPE_PERCENT) + STRIPE_FIXED_CENTS;
	const eventTime = new Date(eventMs).toISOString().replace(".000Z", "Z");
	const ingestTime = new Date(
		eventMs + 1_000 + Math.floor(random() * 900),
	).toISOString();
	const date = `${MONTH}-${String(day).padStart(2, "0")}`;
	const customer = `cus_${key.slice("family:fam_".length)}`;
	return {
		v: 1,
		id: ulid(eventMs),
		school: SCHOOL,
		source: "stripe",
		event_type: "payment.succeeded",
		event_time: eventTime,
		ingest_time: ingestTime,
		date,
		tz: TZ,
		key,
		labels: { plan: "tutoring@v1" },
		idem: `stripe:${invoice}`,
		text: `tuition payment ${dollars(cents)} USD for tutoring`,
		postings: [
			{
				account: "assets:stripe",
				amount: dollars(cents - fee),
				commodity: "USD",
			},
			{
				account: "expenses:billing:stripe-fees",
				amount: dollars(fee),
				commodity: "USD",
			},
			{
				account: "income:billing:tuition",
				amount: `-${dollars(cents)}`,
				commodity: "USD",
			},
		],
		payload: {
			amount_paid: cents,
			billing_email: `family${index}@example.test`,
			currency: "usd",
			customer,
			fee,
			id: invoice,
		},
		redacted: {
			amount_paid: cents,
			currency: "usd",
			customer,
			fee,
			id: invoice,
		},
	};
};

const invoiceId = (): string => {
	let text = "in_1SG";
	for (let index = 0; index < 22; index++)
		text += "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[
			Math.floor(random() * 57)
		];
	return text;
};

const events: AtmEvent[] = [];
for (let index = 0; index < PAYMENTS; index++) {
	const isSample = index === 0;
	const day = isSample ? 3 : 1 + Math.floor((index / PAYMENTS) * 31);
	const cents = index === 101 || index === 177 ? LARGER_CENTS : TUITION_CENTS;
	events.push(
		paymentEvent(
			index,
			day,
			cents,
			isSample ? SAMPLE_INVOICE : invoiceId(),
			isSample ? SAMPLE_FAMILY : familyKey(index),
		),
	);
}
events.sort((a, b) => (a.id < b.id ? -1 : 1));

for (const event of events) {
	const validation = validateEvent(event);
	if (!validation.ok)
		throw new Error(`${event.id}: ${JSON.stringify(validation.errors)}`);
}
const total = events.reduce(
	(sum, event) => sum + (event.payload.amount_paid as number),
	0,
);
if (total !== 17_140_000)
	throw new Error(`October should total $171,400.00, got ${dollars(total)}`);

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const signer: AtmSigner = {
	keyId: KEY_ID,
	privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const keys = {
	[KEY_ID]: publicKey.export({ type: "spki", format: "pem" }).toString(),
};

const sampleEvent = events.find(
	(event) => event.payload.id === SAMPLE_INVOICE,
) as AtmEvent;
const signed = signReceipt(receiptOf(sampleEvent) as AtmReceipt, signer);
const tampered = {
	...signed,
	receipt: { ...signed.receipt, amount: TAMPERED_CENTS },
};
const seal = signSeal(
	sealOf({
		school: SCHOOL,
		month: MONTH,
		events,
		sealedAt: SEALED_AT,
		previous: null,
	}),
	signer,
);

// atm's own verdicts, so a bad sample never ships.
const expectations: [string, unknown, unknown][] = [
	["sample verifies", verifyReceipt(signed, keys), { ok: true }],
	[
		"tampered copy fails",
		verifyReceipt(tampered, keys),
		{ ok: false, reason: "bad_signature" },
	],
	[
		"sample matches the books",
		checkReceiptAgainstEvents(signed, events),
		{ ok: true },
	],
	["seal verifies", verifySeals([seal], events, keys).ok, true],
];
for (const [what, got, want] of expectations) {
	if (JSON.stringify(got) !== JSON.stringify(want))
		throw new Error(
			`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
		);
}

const write = (name: string, value: unknown, compact = false) =>
	writeFile(
		join(OUT, name),
		`${JSON.stringify(value, null, compact ? undefined : "\t")}\n`,
	);

await write("receipt.json", signed);
await write("receipt-tampered.json", tampered);
await write("public-key.json", {
	demo: true,
	note: "DEMO KEY for the Trifold website's sample receipts. It belongs to no real school; its private half was discarded when the samples were made.",
	school: SCHOOL,
	keys,
});
// What the homepage's ledger panel shows: the month's totals and its first rows, so the page needn't load the books.
const fees = events.reduce(
	(sum, event) => sum + (event.payload.fee as number),
	0,
);
await write("panel.json", {
	school: SCHOOL,
	month: MONTH,
	payments: events.length,
	total_cents: total,
	fee_cents: fees,
	sealed_at: SEALED_AT,
	rows: [...events]
		.sort((a, b) => (a.event_time < b.event_time ? -1 : 1))
		.slice(0, 7)
		.map((event) => ({
			event_id: event.id,
			date: event.date,
			amount_cents: event.payload.amount_paid,
			fee_cents: event.payload.fee,
			stripe_id: event.payload.id,
			key: event.key,
		})),
});
// The books load only when someone verifies, so they ship compact.
await write(
	"books.json",
	{ school: SCHOOL, month: MONTH, events, seals: [seal] },
	true,
);

console.log(
	`wrote ${OUT}: receipt ${signed.receipt.event_id}, ${events.length} events, seal ${MONTH}, key ${KEY_ID}`,
);
