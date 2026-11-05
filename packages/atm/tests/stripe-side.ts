import type { AtmEvent, ReconcileStripe } from "../src/types.js";

const MS_PER_SECOND = 1000;

const seconds = (event: AtmEvent): number =>
	Date.parse(event.event_time) / MS_PER_SECOND;

const number = (event: AtmEvent, field: string): number => {
	const value = event.payload[field];
	if (typeof value !== "number")
		throw new Error(`${event.id} has no numeric ${field}`);
	return value;
};

/**
 * What Stripe would list for a school whose log is right: each Stripe record built from the event's own payload (the
 * invoice id, the amounts, the fee and the instant it recorded), never from its postings, so the check against the
 * postings is not circular. A dispute's balance transaction carries `disputeFee`, which atm does not book.
 */
export const stripeSideOf = (
	events: readonly AtmEvent[],
	{ disputeFee = 0 }: { disputeFee?: number } = {},
): Required<Omit<ReconcileStripe, "paymentIntents">> => {
	const of = (type: AtmEvent["event_type"]) =>
		events.filter((event) => event.event_type === type);
	const closed = new Map(
		of("dispute.closed").map((event) => [
			event.payload.id,
			event.payload.status as string,
		]),
	);
	const disputed = new Map(
		of("payment.disputed").map((event) => [
			event.payload.id as string,
			number(event, "amount"),
		]),
	);
	return {
		invoices: of("payment.succeeded").map((event) => ({
			id: event.payload.id as string,
			status: "paid",
			amount_paid: number(event, "amount_paid"),
			currency: event.payload.currency as string,
			created: seconds(event) - 60,
			livemode: true,
			status_transitions: { paid_at: seconds(event) },
		})),
		refunds: of("payment.refunded").map((event) => ({
			id: event.payload.id as string,
			amount: number(event, "amount"),
			currency: event.payload.currency as string,
			created: seconds(event),
			status: "succeeded",
		})),
		disputes: of("payment.disputed").map((event) => ({
			id: event.payload.id as string,
			amount: number(event, "amount"),
			currency: "usd",
			created: seconds(event),
			status: closed.get(event.payload.id) ?? "needs_response",
			livemode: true,
		})),
		payouts: of("payout.paid").map((event) => ({
			id: event.payload.id as string,
			amount: number(event, "amount"),
			currency: "usd",
			created: seconds(event),
			status: "paid",
			livemode: true,
		})),
		balanceTransactions: [
			...of("payment.succeeded").map((event) => {
				const gross = number(event, "amount_paid");
				const fee = number(event, "fee");
				return {
					id: `txn_${event.payload.id}`,
					amount: gross,
					fee,
					net: gross - fee,
					currency: "usd",
					created: seconds(event),
					type: "charge",
				};
			}),
			...of("payment.refunded").map((event) => ({
				id: `txn_${event.payload.id}`,
				amount: -number(event, "amount"),
				fee: 0,
				net: -number(event, "amount"),
				currency: "usd",
				created: seconds(event),
				type: "refund",
			})),
			...of("payment.disputed").map((event) => ({
				id: `txn_${event.payload.id}`,
				amount: -number(event, "amount"),
				fee: disputeFee,
				net: -number(event, "amount") - disputeFee,
				currency: "usd",
				created: seconds(event),
				type: "adjustment",
			})),
			...of("dispute.closed")
				.filter((event) => event.payload.status === "won")
				.map((event) => ({
					id: `txn_${event.payload.id}_won`,
					amount: disputed.get(event.payload.id as string) ?? 0,
					fee: 0,
					net: disputed.get(event.payload.id as string) ?? 0,
					currency: "usd",
					created: seconds(event),
					type: "adjustment",
				})),
			...of("payout.paid").map((event) => ({
				id: `txn_${event.payload.id}`,
				amount: -number(event, "amount"),
				fee: 0,
				net: -number(event, "amount"),
				currency: "usd",
				created: seconds(event),
				type: "payout",
			})),
		],
	};
};
