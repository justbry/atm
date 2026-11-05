/**
 * A history for the inputs shipper's tests, made by the real reference handler: two families, one of which
 * (`ERASED`) had rows before inputs were stored, so it has a seed. Four invoices land on 2026-02-15 (UTC) and one on the
 * 16th, so one batch holds both families and one holds only the kept one.
 *
 * Hand-checked orders: A1 (before the upgrade, its input row wiped) takes `applied_order` 1 and AUTOINCREMENT keeps counting,
 * so A2 is 2, B1 is 3, A3 is 4 and B2 is 5. A2, B1 and A3 are committed on the 15th (18:00:20, 19:00:20 and 20:00:20 UTC),
 * B2 on the 16th (00:00:20 UTC): the batch of the 15th starts at order 2, the batch of the 16th at order 5.
 */
import type { Database } from "bun:sqlite";
import { HOUR, harness, SCHOOL, T0, T1, tierKey } from "./handler-harness.js";
import { invoicePaid } from "./stripe-events.js";

export const ERASED = "fam_erased";
export const KEPT = "fam_kept";

export const subjectKeyOf = (family: string, env = "live") =>
	`${SCHOOL}|${env}|family:${family}`;

type World = ReturnType<typeof harness> & { raw: Database };

/** One invoice for a family: its first creates the subscription, a later one is its renewal. */
export const deliverFor = (
	h: ReturnType<typeof harness>,
	family: string,
	invoiceId: string,
	at: number,
	reason: "subscription_create" | "subscription_cycle" = "subscription_create",
) => {
	const response = h.deliver(
		invoicePaid({
			eventId: `evt_${invoiceId}`,
			invoiceId,
			at,
			subscriptionId: `sub_${family}`,
			reason,
			periodStart: at,
			periodEnd: at + 30 * 24 * HOUR,
			lines: [{ lookupKey: tierKey(), amount: 26_000, interval: "month" }],
			metadata: { b4u_school: SCHOOL, family_id: family },
		}),
		at,
	);
	if (response.body.outcome !== "applied")
		throw new Error(`${invoiceId} was ${response.body.outcome}`);
	return response;
};

/** The handler on `raw` (a file or memory), with the four deliveries above made. Each invoice has payment refs of its own. */
export const buildWorld = (raw?: Database): World => {
	const h = harness(
		{ in_a1: 784, in_a2: 784, in_a3: 784, in_b1: 784, in_b2: 784 },
		raw === undefined ? {} : { raw },
	);
	h.deps.paymentRefs = (event) => {
		const id = (event as { data: { object: { id: string } } }).data.object.id;
		return [`pi_${id}`, `ch_${id}`];
	};
	deliverFor(h, ERASED, "in_a1", T0);
	// the first delivery was before the upgrade: nothing of it was stored, so the holder's first stored input seeds
	h.raw.run(`DELETE FROM atm_event_inputs`);
	h.raw.run(`DELETE FROM atm_input_contexts`);
	deliverFor(h, ERASED, "in_a2", T1, "subscription_cycle");
	deliverFor(h, KEPT, "in_b1", T1 + HOUR);
	deliverFor(h, ERASED, "in_a3", T1 + 2 * HOUR, "subscription_cycle");
	deliverFor(h, KEPT, "in_b2", T1 + 6 * HOUR, "subscription_cycle");
	return h;
};
