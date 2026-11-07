/**
 * The browser verifier (src/lib/verify) against tfd's own checks (packages/atm/src): it must accept the sample receipt,
 * reject the tampered copy, and agree with tfd on every case here, including edge cases of the signature's spelling.
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
	checkReceiptAgainstEvents as atmCheckAgainstEvents,
	verifyReceipt as atmVerifyReceipt,
	verifySeals as atmVerifySeals,
} from "../../../packages/atm/src/index.ts";
import type {
	AtmEvent,
	AtmSignedReceipt,
} from "../../../packages/atm/src/types.ts";
import books from "../src/lib/samples/books.json";
import publicKey from "../src/lib/samples/public-key.json";
import sample from "../src/lib/samples/receipt.json";
import tampered from "../src/lib/samples/receipt-tampered.json";
import { checkReceipt } from "../src/lib/verify/check";
import {
	type BooksEvent,
	canonicalize,
	checkReceiptAgainstEvents,
	verifyReceipt,
	verifySealChain,
} from "../src/lib/verify/core";
import { decodeReceiptParam, encodeReceiptParam } from "../src/lib/verify/link";

const keys = publicKey.keys as Record<string, string>;
const events = books.events as unknown as BooksEvent[];
const atmEvents = books.events as unknown as AtmEvent[];

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** tfd's verdict in the browser verifier's vocabulary. */
const atmVerdict = (value: unknown, withKeys = keys): string => {
	const verdict = atmVerifyReceipt(value, withKeys);
	return verdict.ok ? "ok" : verdict.reason;
};

const otherKeys = (() => {
	const { publicKey: other } = generateKeyPairSync("ed25519");
	return {
		[sample.key_id]: other.export({ type: "spki", format: "pem" }).toString(),
	};
})();

const rsaKeys = (() => {
	const { publicKey: rsa } = generateKeyPairSync("rsa", {
		modulusLength: 1024,
	});
	return {
		[sample.key_id]: rsa.export({ type: "spki", format: "pem" }).toString(),
	};
})();

const lastChar = sample.sig.at(-1) as string;
const BASE64URL =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const flippedTail = BASE64URL[(BASE64URL.indexOf(lastChar) ^ 1) % 64] as string;

const cases: [string, unknown, Record<string, string>][] = [
	["the sample", sample, keys],
	["the tampered copy", tampered, keys],
	["the sample, keys re-ordered", JSON.parse(canonicalize(sample)), keys],
	["the sample against another key", sample, otherKeys],
	["the sample against an RSA key", sample, rsaKeys],
	["the sample with no keys", sample, {}],
	[
		"a non-canonical spelling of the signature",
		{ ...sample, sig: sample.sig.slice(0, -1) + flippedTail },
		keys,
	],
	["an extra field", { ...sample, extra: 1 }, keys],
	[
		"an extra receipt field",
		{ ...sample, receipt: { ...sample.receipt, child: "Mara" } },
		keys,
	],
	[
		"a fractional amount",
		{ ...sample, receipt: { ...sample.receipt, amount: 800.5 } },
		keys,
	],
	[
		"a missing cause",
		{ ...sample, receipt: { ...sample.receipt, cause: undefined } },
		keys,
	],
	[
		"an empty cause",
		{ ...sample, receipt: { ...sample.receipt, cause: "" } },
		keys,
	],
	[
		"a bad event id",
		{ ...sample, receipt: { ...sample.receipt, event_id: "not-a-ulid" } },
		keys,
	],
	["a short signature", { ...sample, sig: sample.sig.slice(1) }, keys],
	["null", null, keys],
	["an array", [sample], keys],
	["a string", "receipt", keys],
];

describe("the browser verifier agrees with tfd's verifyReceipt", () => {
	test("accepts the sample receipt", async () => {
		expect(await verifyReceipt(sample, keys)).toBe("ok");
		expect(atmVerdict(sample)).toBe("ok");
	});

	test("rejects the tampered copy", async () => {
		expect(await verifyReceipt(tampered, keys)).toBe("bad_signature");
		expect(atmVerdict(tampered)).toBe("bad_signature");
	});

	for (const [name, value, withKeys] of cases) {
		test(name, async () => {
			expect(await verifyReceipt(value, withKeys)).toBe(
				atmVerdict(value, withKeys) as never,
			);
		});
	}
});

describe("the books and the seal, as tfd checks them", () => {
	test("the sample matches the books; an edited event does not", async () => {
		const signed = sample as unknown as AtmSignedReceipt;
		expect(await checkReceiptAgainstEvents(signed, events)).toBe("ok");
		expect(atmCheckAgainstEvents(signed, atmEvents)).toEqual({ ok: true });

		const edited = clone(events);
		const target = edited.find(
			(event) => event.id === sample.receipt.event_id,
		) as BooksEvent;
		target.text = "edited later";
		expect(await checkReceiptAgainstEvents(signed, edited)).toBe(
			"event_changed",
		);
		expect(
			atmCheckAgainstEvents(signed, edited as unknown as AtmEvent[]),
		).toEqual({
			ok: false,
			reason: "event_changed",
		});

		const without = events.filter(
			(event) => event.id !== sample.receipt.event_id,
		);
		expect(await checkReceiptAgainstEvents(signed, without)).toBe(
			"missing_event",
		);
	});

	test("the October seal verifies, and breaks when an event changes", async () => {
		expect(await verifySealChain(books.seals, events, keys)).toEqual(["ok"]);
		expect(
			atmVerifySeals(books.seals, atmEvents, keys).seals.map(
				(seal) => seal.verdict,
			),
		).toEqual(["ok"]);

		const edited = clone(events);
		(edited[5] as BooksEvent).text = "edited later";
		expect(await verifySealChain(books.seals, edited, keys)).toEqual([
			"events_changed",
		]);
		expect(
			atmVerifySeals(
				books.seals,
				edited as unknown as AtmEvent[],
				keys,
			).seals.map((seal) => seal.verdict),
		).toEqual(["events_changed"]);
	});

	test("the whole check: pass for the sample, fail for the tampered copy", async () => {
		const load = async () => ({
			school: books.school,
			events,
			seals: books.seals,
		});
		const pass = await checkReceipt(sample, keys, load);
		expect(pass.kind).toBe("signed");
		if (pass.kind === "signed") {
			expect(pass.books).toBe("ok");
			expect(pass.seal).toEqual({
				month: "2026-10",
				verdict: "ok",
				covers: true,
			});
		}
		expect((await checkReceipt(tampered, keys, load)).kind).toBe(
			"bad_signature",
		);
	});
});

test("?r= links carry a receipt intact", () => {
	const json = JSON.stringify(sample);
	expect(decodeReceiptParam(encodeReceiptParam(json))).toBe(json);
	expect(decodeReceiptParam("%%%")).toBeNull();
});
