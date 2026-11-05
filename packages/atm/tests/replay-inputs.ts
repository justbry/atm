/**
 * The fixture year turned into what the family service would have received, and a replay of those inputs.
 *
 * Inputs: `catalog.published` and `policy.published` settings events, and raw Stripe events (an `invoice.paid` for each
 * payment and each gift, a `charge.refunded`). The year's bookings are the family service's own engine commands and
 * stay as the fixture has them. Replay: settings by id order, then each input at its own time through
 * `handleStripeEvent`, the bookings through the engine, and the cron's look at what has lapsed before each step.
 */
import type { SubjectState } from "@autumn/balance-engine";
import type { Fixture } from "../fixtures/vibes.js";
import { menuCatalogRows } from "../src/billing/grants.js";
import { handleStripeEvent } from "../src/billing/handle.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import {
	applyRowChanges,
	type BillingRow,
	rowChangesFromMutation,
	stateFromRows,
} from "../src/billing/rows.js";
import {
	addonPriceKey,
	lookupKeyOf,
	menuLineItems,
	tierPriceKey,
} from "../src/billing/stripe-menu.js";
import type {
	BillingPolicy,
	Menu,
	StripeEventInput,
} from "../src/billing/types.js";
import { deterministicUlid } from "../src/ledger/ids.js";
import { lapsedRows, lapseEvent, ledgerEvent } from "../src/ledger/postings.js";
import { balancesOf } from "../src/ledger/replay.js";
import { runOnState, toCatalog } from "../src/ledger/run.js";
import { canonicalize } from "../src/ledger/util.js";
import type { AtmEvent, AtmHold } from "../src/types.js";
import {
	chargeRefunded,
	invoicePaid,
	paymentIntentOf,
	priceIdOf,
} from "./stripe-events.js";

export const MENU_VERSION = 1;
export const POLICY_VERSION = 1;

type Input =
	| { t: number; kind: "settings"; event: AtmEvent }
	| { t: number; kind: "stripe"; event: unknown; now: number }
	| { t: number; kind: "family"; command: Record<string, unknown> };

const isBilling = (command: Record<string, unknown>): boolean => {
	if (command.type === "applyBillingPlan" || command.type === "reset")
		return true;
	// the October refund's credit adjustment is the rules' to make; a reversal that gives a session back is the family's
	return (
		command.type === "updateBalance" && (command.addToBalance as number) < 0
	);
};

export type YearInputs = {
	school: string;
	holder: string;
	settings: AtmEvent[];
	/** Everything in time order. */
	steps: Input[];
	/** The year's credit events the fixture's own pipeline made, for comparison. */
	expectedCredit: AtmEvent[];
};

export const yearInputs = (year: Fixture, menu: Menu): YearInputs => {
	const school = year.school;
	const holder = year.expected.holder;
	const family = holder.slice("family:".length);
	const tz = menu.timeZone;
	const events = [...year.events].sort((a, b) => (a.id < b.id ? -1 : 1));
	const payments = events.filter((e) => e.event_type === "payment.succeeded");
	const first = new Date(payments[0]?.event_time as string);
	const renewal = (m: number) =>
		Date.UTC(
			2026,
			m,
			first.getUTCDate(),
			first.getUTCHours(),
			first.getUTCMinutes(),
			0,
		);

	const settings = [
		ledgerEvent({
			type: "catalog.published",
			school,
			tz,
			eventTime: Date.UTC(2026, 0, 1),
			key: school,
			idem: "settings:catalog:1",
			payload: {
				plans: menu.tiers.map((t) => `${t.id}@v${MENU_VERSION}`),
				menu,
				version: MENU_VERSION,
			},
		}),
		ledgerEvent({
			type: "policy.published",
			school,
			tz,
			eventTime: Date.UTC(2026, 0, 1),
			key: school,
			idem: "settings:policy:1",
			payload: { policy: DEFAULT_POLICY, version: POLICY_VERSION },
		}),
	];

	const tierKey = (tierId: string) => {
		const price = menu.tiers
			.find((t) => t.id === tierId)
			?.prices.find((p) => p.interval === "month");
		return {
			key: lookupKeyOf(
				school,
				tierPriceKey(tierId, "month"),
				price?.amount as number,
				menu.currency,
			),
			amount: price?.amount as number,
		};
	};
	const metadata = { b4u_school: school, family_id: family };
	const steps: Input[] = settings.map((event) => ({
		t: Date.parse(event.event_time),
		kind: "settings",
		event,
	}));

	payments.forEach((payment, m) => {
		const tierId = (payment.labels.plan as string).split("@")[0] as string;
		const { key, amount } = tierKey(tierId);
		const t = Date.parse(payment.event_time);
		steps.push({
			t,
			kind: "stripe",
			// the first payment attaches the plan a second later, as the fixture's family service did
			now: m === 0 ? t + 1000 : t,
			event: invoicePaid({
				eventId: `evt_${(payment.payload as { id: string }).id}`,
				invoiceId: (payment.payload as { id: string }).id,
				at: t,
				subscriptionId: "sub_1",
				reason: m === 0 ? "subscription_create" : "subscription_cycle",
				periodStart: renewal(m),
				periodEnd: renewal(m + 1),
				lines: [{ lookupKey: key, amount, interval: "month" }],
				metadata,
			}),
		});
	});

	const gifts = events.filter(
		(e) => e.event_type === "credit.granted" && e.labels.plan === "gift",
	);
	const giftItem = menu.addons.find((a) => a.gift === "sessions");
	if (!giftItem) throw new Error("the menu has no session gift");
	gifts.forEach((gift, i) => {
		const t = Date.parse(gift.event_time);
		steps.push({
			t,
			kind: "stripe",
			now: t,
			event: invoicePaid({
				eventId: `evt_in_gift_${i + 1}`,
				invoiceId: `in_gift_${i + 1}`,
				at: t,
				subscriptionId: null,
				reason: "manual",
				periodStart: t,
				periodEnd: t,
				lines: [
					{
						lookupKey: lookupKeyOf(
							school,
							addonPriceKey(giftItem.id, giftItem.price.every, giftItem.gift),
							giftItem.price.amount,
							menu.currency,
						),
						amount: giftItem.price.amount,
					},
				],
				metadata,
			}),
		});
	});

	for (const refund of events.filter(
		(e) => e.event_type === "payment.refunded",
	)) {
		const paid = payments.find((p) => p.id === refund.cause);
		const invoiceId = (paid?.payload as { id: string }).id;
		const t = Date.parse(refund.event_time);
		steps.push({
			t: t + 60_000,
			kind: "stripe",
			// the fixture took the session back a minute after the refund
			now: t + 60_000,
			event: chargeRefunded({
				eventId: `evt_${(refund.payload as { id: string }).id}`,
				refundId: (refund.payload as { id: string }).id,
				chargeId: `ch_${invoiceId}`,
				invoiceId,
				amount: refund.payload.amount as number,
				chargeAmount: (paid?.payload as { amount_paid: number }).amount_paid,
				at: t + 60_000,
			}),
		});
	}

	const seen = new Set<string>();
	for (const e of events) {
		const command = (e.payload as { command?: Record<string, unknown> })
			.command;
		if (!command || isBilling(command)) continue;
		const id = command.commandId as string;
		if (seen.has(id)) continue;
		seen.add(id);
		steps.push({
			t: Date.parse(e.event_time),
			kind: "family",
			command: { ...command, occurredAt: Date.parse(e.event_time) },
		});
	}
	// stable: settings, then time, then the order they were listed
	const indexed = steps.map((s, i) => ({ s, i }));
	indexed.sort((a, b) => a.s.t - b.s.t || a.i - b.i);
	return {
		school,
		holder,
		settings,
		steps: indexed.map((x) => x.s),
		expectedCredit: events.filter((e) => e.event_type.startsWith("credit.")),
	};
};

/** The menu and policy in force, read back from the settings events (the latest of each, by id). */
export const settingsOf = (
	settings: readonly AtmEvent[],
): {
	menu: Menu;
	menuVersion: number;
	policy: BillingPolicy;
	policyVersion: number;
} => {
	const latest = (type: string) =>
		[...settings]
			.filter((e) => e.event_type === type)
			.sort((a, b) => (a.id < b.id ? -1 : 1))
			.pop();
	const catalog = latest("catalog.published")?.payload as {
		menu: Menu;
		version: number;
	};
	const policy = latest("policy.published")?.payload as {
		policy: BillingPolicy;
		version: number;
	};
	return {
		menu: catalog.menu,
		menuVersion: catalog.version,
		policy: policy.policy,
		policyVersion: policy.version,
	};
};

export type Replay = {
	/** Decisions the rules made from the Stripe inputs, and the cron's expiries: what the replay must reproduce. */
	decisions: AtmEvent[];
	/** Every credit event: the decisions plus the family's own (bookings), taken as the fixture has them. */
	credit: AtmEvent[];
	rows: BillingRow[];
	revision: number;
	balances: ReturnType<typeof balancesOf>;
};

export const replayYear = ({
	year,
	inputs,
}: {
	year: Fixture;
	inputs: YearInputs;
}): Replay => {
	const { menu, menuVersion, policy, policyVersion } = settingsOf(
		inputs.settings,
	);
	const school = inputs.school;
	const holder = inputs.holder;
	const catalogRows = menuCatalogRows({ menu, school });
	const catalog = toCatalog(catalogRows);
	const identity = {
		orgId: school,
		env: "live",
		customerId: holder,
		entityId: null,
	};
	const priceIds = Object.fromEntries(
		[...menuLineItems(school, menu).keys()].map((k) => [k, priceIdOf(k)]),
	);
	const invoiceIds: Record<string, string> = {};

	let rows: BillingRow[] = [];
	let revision = 0;
	const decisions: AtmEvent[] = [];
	const family: AtmEvent[] = [];
	const holds: Record<string, AtmHold> = {};
	const lapsed = new Set<string>();
	const familyEvents = new Map<string, AtmEvent[]>();
	for (const e of year.events) {
		const command = (e.payload as { command?: { commandId?: string } }).command;
		if (!command?.commandId) continue;
		familyEvents.set(command.commandId, [
			...(familyEvents.get(command.commandId) ?? []),
			e,
		]);
	}

	const state = (): SubjectState | null =>
		stateFromRows({ identity, revision, rows });
	const featureOf = (internal: string) => catalog.features[internal]?.id;

	const lapse = (t: number) => {
		const current = state();
		if (!current) return;
		for (const row of lapsedRows({
			state: current as never,
			featureOf,
			feature: "visit",
			atMs: t,
		})) {
			const k = `${row.id}:${row.expires_at}`;
			if (lapsed.has(k)) continue;
			lapsed.add(k);
			decisions.push(
				lapseEvent({
					row,
					holder,
					key: holder,
					feature: "visit",
					school,
					tz: menu.timeZone,
					revision: current.revision,
				}),
			);
		}
	};

	for (const step of inputs.steps) {
		if (step.kind === "settings") continue;
		lapse(step.t);
		if (step.kind === "stripe") {
			const type = (step.event as { type: string }).type;
			const object = (step.event as { data: { object: { id: string } } }).data
				.object;
			if (type === "invoice.paid")
				invoiceIds[paymentIntentOf(object.id)] = object.id;
			const input: StripeEventInput = {
				event: step.event,
				// the id the family service gave the stored input event: a ULID decided by the event, not the clock
				eventId: deterministicUlid({
					timeMs: step.t,
					revision: 0,
					seed: canonicalize([school, (step.event as { id: string }).id]),
				}),
				menu,
				menuVersion,
				policy,
				policyVersion,
				rows,
				revision,
				catalog: catalogRows,
				now: step.now,
				priceIds,
				invoiceIds,
			};
			const result = handleStripeEvent(input);
			if (result.refused)
				throw new Error(`refused ${type}: ${result.refused.message}`);
			if (result.rowChanges)
				({ rows, revision } = applyRowChanges({
					rows,
					revision,
					changes: result.rowChanges,
				}));
			decisions.push(...result.events);
			continue;
		}
		const run = runOnState({ state: state(), catalog, command: step.command });
		if (!run.mutation)
			throw new Error(`${String(step.command.type)} decided nothing`);
		const changes = rowChangesFromMutation({
			mutation: run.mutation as never,
			rows,
			revision,
		});
		({ rows, revision } = applyRowChanges({ rows, revision, changes }));
		const command = step.command as {
			type: string;
			commandId: string;
			lock?: { id: string };
		};
		family.push(...(familyEvents.get(command.commandId) ?? []));
		if (command.type === "track") {
			const lock = run.mutation.changes.find(
				(c) => c.table === "locks" && c.op === "insert",
			);
			if (lock && lock.op === "insert")
				holds[(lock.row as { id: string }).id] = {
					holder,
					feature: "visit",
					units: 1,
				};
		} else if (command.lock?.id) delete holds[command.lock.id];
	}
	const end = Date.UTC(2026, 11, 31, 23, 59, 0);
	lapse(end);

	const asOf = Date.parse(year.expected.asOf);
	const balances = balancesOf({
		states: { [holder]: state() as never },
		holds,
		catalog,
		asOfMs: asOf,
	});
	const credit = [...decisions, ...family].filter((e) =>
		e.event_type.startsWith("credit."),
	);
	return { decisions, credit, rows, revision, balances };
};
