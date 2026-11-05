import { describe, expect, test } from "bun:test";
import { bookingCheckoutParams } from "../src/billing/booking-pay.js";
import type { BookingCheckoutInput } from "../src/billing/types.js";

const input: BookingCheckoutInput = {
	schoolId: "sch_vol",
	familyId: "fam_8k2",
	bookingId: "bk_1",
	name: "Open studio",
	amount: 4500,
	currency: "usd",
	returnUrls: {
		success: "https://school.example/booked",
		cancel: "https://school.example/cancelled",
	},
};

const paramsOf = (over: Partial<BookingCheckoutInput> = {}) => {
	const result = bookingCheckoutParams({ ...input, ...over });
	if (!result.ok) throw new Error(`refused: ${result.reason}`);
	return result.params;
};

describe("bookingCheckoutParams", () => {
	test("a payment-mode session with one inline price line", () => {
		expect(paramsOf()).toEqual({
			mode: "payment",
			client_reference_id: "fam_8k2",
			success_url: "https://school.example/booked",
			cancel_url: "https://school.example/cancelled",
			line_items: [
				{
					quantity: 1,
					price_data: {
						currency: "usd",
						unit_amount: 4500,
						product_data: { name: "Open studio" },
					},
				},
			],
			metadata: {
				b4u_school: "sch_vol",
				family_id: "fam_8k2",
				booking_id: "bk_1",
				b4u_kind: "booking",
			},
			payment_intent_data: {
				metadata: {
					b4u_school: "sch_vol",
					family_id: "fam_8k2",
					booking_id: "bk_1",
					b4u_kind: "booking",
				},
			},
		});
	});

	test("the metadata is on the session and on the payment intent, so the charge and its refund carry it", () => {
		const params = paramsOf({ forProfileId: "prof_2" });
		expect(params.metadata).toEqual({
			b4u_school: "sch_vol",
			family_id: "fam_8k2",
			booking_id: "bk_1",
			b4u_kind: "booking",
			profile_id: "prof_2",
		});
		expect(params.payment_intent_data.metadata).toEqual(params.metadata);
		// two objects: a key the caller adds to one does not appear on the other
		expect(params.payment_intent_data.metadata).not.toBe(params.metadata);
	});

	test("no profile id without a profile", () => {
		expect(Object.hasOwn(paramsOf().metadata, "profile_id")).toBe(false);
		expect(
			Object.hasOwn(paramsOf({ forProfileId: null }).metadata, "profile_id"),
		).toBe(false);
	});

	test("no invoice is made: a booking grants no credits", () => {
		expect(Object.hasOwn(paramsOf(), "invoice_creation")).toBe(false);
	});

	test("the currency is lowercased", () => {
		expect(
			paramsOf({ currency: "USD" }).line_items[0].price_data.currency,
		).toBe("usd");
	});

	test("the largest amount Stripe takes is accepted, one more is not", () => {
		expect(
			paramsOf({ amount: 99_999_999 }).line_items[0].price_data.unit_amount,
		).toBe(99_999_999);
		expect(bookingCheckoutParams({ ...input, amount: 100_000_000 })).toEqual({
			ok: false,
			reason: "bad_amount",
		});
	});

	test.each([
		0,
		-1,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		"4500" as unknown as number,
	])("bad_amount: %p", (amount) => {
		expect(bookingCheckoutParams({ ...input, amount })).toEqual({
			ok: false,
			reason: "bad_amount",
		});
	});

	test.each(["", "us", "usdd", "u5d", "$$$", undefined as unknown as string])(
		"bad_currency: %p",
		(currency) => {
			expect(bookingCheckoutParams({ ...input, currency })).toEqual({
				ok: false,
				reason: "bad_currency",
			});
		},
	);

	test.each(["", "   "])("no_booking_id: %p", (bookingId) => {
		expect(bookingCheckoutParams({ ...input, bookingId })).toEqual({
			ok: false,
			reason: "no_booking_id",
		});
	});
});
