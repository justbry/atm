/**
 * One entry point for a Stripe event. The family service verifies the signature, dedupes on the event id, calls
 * `handleStripeEvent` with the subject's stored rows and writes the result in one transaction; everything between is
 * here and pure:
 *
 *   raw event -> mappingFor + normalize -> a fact -> the grant rules -> engine commands -> the engine
 *     -> row changes (engine rows and the grants row, one revision) and decision events (credit.*)
 *
 * Nothing is written and no clock is read. Replaying an event gives no changes and no events. An event atm cannot
 * decide (unknown shape, a line not on the menu, an engine rejection) comes back `refused`: nothing is to be written,
 * keep the event and retry once the cause is fixed.
 */
import type {
	SubjectState,
	SubjectStateMutation,
} from "@autumn/balance-engine";
import { ULID_PATTERN } from "../ledger/ids.js";
import { mutationToEvents } from "../ledger/postings.js";
import { runOnState, toCatalog } from "../ledger/run.js";
import type {
	AtmEvent,
	AtmIdentity,
	BillingDispute,
	BillingInvoice,
	BillingRefund,
	GrantResult,
	GrantsState,
	Menu,
	StripeEventInput,
	StripeEventRefusal,
	StripeEventResult,
	SubscriptionFact,
} from "../types.js";
import {
	disputeToCommands,
	invoiceHolder,
	invoiceToCommands,
	refundToCommands,
	subscriptionHolder,
	subscriptionToCommands,
} from "./grants.js";
import {
	mappingFor,
	normalize,
	resolveInvoice,
	resolveSubscriptionPlan,
} from "./normalize.js";
import {
	applyRowChanges,
	diffRows,
	GRANTS_TABLE,
	grantsFromRows,
	grantsRow,
	rowChangesFromMutation,
	stateFromRows,
	subjectFromRows,
	subjectKey,
} from "./rows.js";
import { menuLineItems } from "./stripe-menu.js";

export type {
	StripeEventInput,
	StripeEventRefusal,
	StripeEventResult,
} from "../types.js";

const refuse = (
	reason: StripeEventRefusal["reason"],
	message: string,
): StripeEventResult => ({
	rowChanges: null,
	events: [],
	refused: { reason, message },
});

/** A fresh result each time: a caller that pushes onto `events` must not change the next one. */
const nothing = (): StripeEventResult => ({ rowChanges: null, events: [] });

const ULID = new RegExp(ULID_PATTERN);

/** What the grant rules decide for a normalized fact, or why not. */
type Decision =
	| { ok: true; result: GrantResult; reason: string }
	| { ok: false; refusal: StripeEventResult };

const BILLING_LINE_PREFIX = "b4u_";

/** The menu applied to the invoice's lines; refuses one of ours that the menu does not know. */
const resolve = (
	invoice: BillingInvoice,
	input: StripeEventInput,
	holder: { orgId: string } | null,
): { ok: true; invoice: BillingInvoice } | { ok: false; message: string } => {
	// Once the holder is known (an earlier invoice named it) the checkout metadata is not needed again.
	const schoolId = invoice.metadata.b4u_school ?? holder?.orgId;
	if (!schoolId || (!holder && !invoice.metadata.family_id))
		return {
			ok: false,
			message: `invoice ${invoice.id} has no b4u_school/family_id metadata to name the holder`,
		};
	const resolved = resolveInvoice(
		invoice,
		menuLineItems(schoolId, input.menu, input.priceIds),
	);
	// Money came in for something that is ours but not on the menu now: granting nothing would be silent.
	const stray = resolved.lines.filter(
		(l) =>
			l.kind === "unknown" &&
			l.amount > 0 &&
			(l.lookupKey == null || l.lookupKey.startsWith(BILLING_LINE_PREFIX)),
	);
	if (stray.length > 0)
		return {
			ok: false,
			message: `invoice ${invoice.id} has ${stray.length} paid line(s) the menu does not know: ${stray
				.map((l) => l.lookupKey ?? l.priceId ?? "no key")
				.join(", ")}`,
		};
	return { ok: true, invoice: resolved };
};

type Rules = {
	input: StripeEventInput;
	/** Whose credits these are: the subject's holder, else the one the event names. */
	holder: { orgId: string; customerId: string };
	grants: GrantsState;
	subject: ReturnType<typeof subjectFromRows> | null;
};

/** A refund or dispute with the invoice its payment paid, found by the payment intent, else the charge. */
const withInvoiceId = <T extends BillingRefund | BillingDispute>(
	fact: T,
	input: StripeEventInput,
): T => {
	if (fact.invoiceId) return fact;
	const invoiceId =
		(fact.paymentIntentId
			? input.invoiceIds?.[fact.paymentIntentId]
			: undefined) ??
		input.invoiceIds?.[fact.chargeId] ??
		null;
	return { ...fact, invoiceId };
};

/**
 * A refund or dispute that takes credits back (policy on, fully refunded or lost) but names no invoice we have handled:
 * silence would leave the credits, so it is refused and kept for a retry once the invoice is known.
 */
const unlinkedInvoice = (
	fact: BillingRefund | BillingDispute,
	takesCreditsBack: boolean,
	grants: GrantsState,
): StripeEventResult | null => {
	if (!takesCreditsBack) return null;
	if (fact.invoiceId && grants.invoices[fact.invoiceId]) return null;
	return refuse(
		"unmatched_invoice",
		`${fact.id} (charge ${fact.chargeId}, payment intent ${fact.paymentIntentId ?? "none"}) names no invoice this holder has been paid: pass invoiceIds, or retry once the invoice is handled`,
	);
};

const decide = (
	target: string,
	fact: unknown,
	{ input, grants, holder, subject }: Rules,
): Decision | null => {
	const common = {
		menu: input.menu,
		policy: input.policy,
		state: grants,
		subject,
		now: input.now,
		menuVersion: input.menuVersion,
		policyVersion: input.policyVersion,
	};
	switch (target) {
		case "BillingInvoice": {
			// A paid invoice is decided once: its replay is nothing, whatever the menu looks like now.
			if (grants.invoices[(fact as BillingInvoice).id]) return null;
			const resolved = resolve(fact as BillingInvoice, input, holder);
			if (!resolved.ok)
				return {
					ok: false,
					refusal: refuse(
						resolved.message.includes("metadata")
							? "missing_metadata"
							: "unmatched_line",
						resolved.message,
					),
				};
			return {
				ok: true,
				result: invoiceToCommands({ ...common, invoice: resolved.invoice }),
				reason: "invoice",
			};
		}
		case "BillingRefund": {
			const refund = withInvoiceId(fact as BillingRefund, input);
			const unlinked = unlinkedInvoice(
				refund,
				refund.full && input.policy.removeOnFullRefund,
				grants,
			);
			if (unlinked) return { ok: false, refusal: unlinked };
			return {
				ok: true,
				result: refundToCommands({ ...common, refund }),
				reason: "refund",
			};
		}
		case "BillingDispute": {
			const dispute = withInvoiceId(fact as BillingDispute, input);
			const unlinked = unlinkedInvoice(
				dispute,
				dispute.status === "lost" && input.policy.removeOnLostDispute,
				grants,
			);
			if (unlinked) return { ok: false, refusal: unlinked };
			return {
				ok: true,
				result: disputeToCommands({ ...common, dispute }),
				reason: "dispute lost",
			};
		}
		case "SubscriptionFact": {
			const subscription = fact as SubscriptionFact;
			// A cancel that arrives before any invoice of the family: keep it and retry once the subscription is known.
			if (subscription.status === "canceled" && grants.subscriptionId === null)
				return {
					ok: false,
					refusal: refuse(
						"unknown_subscription",
						`subscription ${subscription.id} ended before any invoice of this holder was handled`,
					),
				};
			const menuItems = menuLineItems(holder.orgId, input.menu, input.priceIds);
			// An item of ours (a b4u_ lookup key) that the menu does not know: the plan cannot be told, so say so.
			// A canceled one is not refused: its price may have left the menu since, and its credits must still lapse.
			// Nor is an event about another subscription than the holder's: it changes nothing, so a refusal would only retry.
			const decidesPlan =
				subscription.status !== "canceled" &&
				(grants.subscriptionId === null ||
					grants.subscriptionId === subscription.id);
			const stray = (decidesPlan ? subscription.items : []).filter(
				(item) =>
					!menuItems.has(item.priceId) &&
					!(item.lookupKey && menuItems.has(item.lookupKey)) &&
					item.lookupKey?.startsWith(BILLING_LINE_PREFIX),
			);
			if (stray.length > 0)
				return {
					ok: false,
					refusal: refuse(
						"unmatched_line",
						`subscription ${subscription.id} has ${stray.length} item(s) the menu does not know: ${stray
							.map((item) => item.lookupKey ?? item.priceId)
							.join(", ")}`,
					),
				};
			return {
				ok: true,
				result: subscriptionToCommands({
					...common,
					// A subject known only by the event's metadata (the subscription came before any invoice) has no holder yet.
					state: grants.holder ? grants : { ...grants, holder },
					subscription,
					plan: resolveSubscriptionPlan(subscription.items, menuItems),
				}),
				reason:
					subscription.status === "canceled"
						? "subscription ended"
						: "subscription",
			};
		}
		default:
			return null;
	}
};

// ---- Events from a mutation ----

type Change = SubjectStateMutation["changes"][number];
type Row = Record<string, unknown>;

const planOf = ({
	rowIds,
	menu,
	menuVersion,
	tierId,
}: {
	rowIds: readonly string[];
	menu: Menu;
	menuVersion: string | number;
	tierId: string | null;
}): string => {
	const version = `@v${menuVersion}`;
	const addons = [...menu.addons].sort((a, b) => b.id.length - a.id.length);
	for (const id of rowIds) {
		if (id.startsWith("ce_gift_")) return "gift";
		if (id.startsWith("ce_tier_") && tierId) return `${tierId}${version}`;
		const recurring = addons.find((a) => id.startsWith(`ce_addon_${a.id}_`));
		if (recurring) return `${recurring.id}${version}`;
		const once = addons.find(
			(a) => id.startsWith("ce_once_") && id.includes(`_${a.id}_`),
		);
		if (once) return `${once.id}${version}`;
	}
	return tierId ? `${tierId}${version}` : `plan${version}`;
};

/**
 * The credit events one mutation makes. The engine's event rules take one feature at a time, so a mutation that
 * moves several (a tier with visits and retreats) is cut by feature: each feature's balance rows and rollovers go to
 * its own call, the rest of the changes to the first.
 */
const eventsOf = ({
	mutation,
	before,
	catalog,
	input,
	grants,
	labels,
	reason,
}: {
	mutation: SubjectStateMutation;
	before: SubjectState | null;
	catalog: ReturnType<typeof toCatalog>;
	input: StripeEventInput;
	grants: GrantsState;
	labels: Record<string, string>;
	reason: string;
}): AtmEvent[] => {
	const internalOf = new Map<string, string>();
	const ownerOf = new Map<string, string>();
	for (const r of before?.customerEntitlements ?? [])
		internalOf.set(r.id, r.internal_feature_id);
	for (const r of before?.rollovers ?? []) ownerOf.set(r.id, r.cus_ent_id);
	for (const c of mutation.changes) {
		if (c.op !== "insert") continue;
		const row = c.row as Row;
		if (c.table === "customerEntitlements")
			internalOf.set(row.id as string, row.internal_feature_id as string);
		if (c.table === "rollovers")
			ownerOf.set(row.id as string, row.cus_ent_id as string);
	}
	const rowIdOf = (c: Change): string | null => {
		if (c.table === "customerEntitlements")
			return c.op === "insert" ? ((c.row as Row).id as string) : c.id;
		if (c.table === "rollovers")
			return (
				ownerOf.get(c.op === "insert" ? ((c.row as Row).id as string) : c.id) ??
				null
			);
		return null;
	};
	const featureOf = (c: Change): string | null => {
		const rowId = rowIdOf(c);
		const internal = rowId ? internalOf.get(rowId) : undefined;
		return internal ? (catalog.features[internal]?.id ?? null) : null;
	};
	const planAt = (c: Change): string | null => {
		const id = rowIdOf(c);
		return id
			? planOf({
					rowIds: [id],
					menu: input.menu,
					menuVersion: input.menuVersion,
					tierId: grants.tierId,
				})
			: null;
	};
	// Credits of one feature can come from several plans at once (the tier, a recurring add-on, a pack): each
	// (feature, plan) is booked on its own, so `credits:issued:<plan>` is the plan that issued them.
	const groupOf = (c: Change): { feature: string; plan: string } | null => {
		const feature = featureOf(c);
		const plan = planAt(c);
		return feature !== null && plan !== null ? { feature, plan } : null;
	};
	const groups = [
		...new Map(
			mutation.changes.flatMap((c) => {
				const g = groupOf(c);
				return g ? [[`${g.feature}\u0000${g.plan}`, g] as const] : [];
			}),
		).values(),
	].sort((x, y) =>
		x.feature === y.feature
			? x.plan < y.plan
				? -1
				: x.plan > y.plan
					? 1
					: 0
			: x.feature < y.feature
				? -1
				: 1,
	);
	if (groups.length === 0) return [];
	const plansOfFeature = new Map<string, number>();
	for (const g of groups)
		plansOfFeature.set(g.feature, (plansOfFeature.get(g.feature) ?? 0) + 1);
	const events: AtmEvent[] = [];
	for (const [index, group] of groups.entries()) {
		const slice = mutation.changes.filter((c) => {
			const own = groupOf(c);
			if (own === null) return index === 0;
			return own.feature === group.feature && own.plan === group.plan;
		});
		const idemPrefix =
			(plansOfFeature.get(group.feature) ?? 0) > 1
				? `engine.${group.feature}.${group.plan}`
				: groups.length > 1
					? `engine.${group.feature}`
					: "engine";
		events.push(
			...mutationToEvents({
				mutation: { ...mutation, changes: slice } as SubjectStateMutation,
				context: {
					school: mutation.identity.orgId,
					tz: input.menu.timeZone,
					feature: group.feature,
					plan: group.plan,
					reason,
					cause: input.eventId,
					labels,
					idemPrefix,
					// No `lowCreditThreshold`: a Stripe event only grants, refills and takes back by the rules, never a draw by
					// the family, so it makes no `credit.low` or `credit.depleted`.
					before: before as never,
				},
			}),
		);
	}
	return events;
};

// ---- The entry point ----

const sameJson = (a: unknown, b: unknown) =>
	JSON.stringify(a) === JSON.stringify(b);

/**
 * Handles one Stripe event for one subject. The caller passes the subject's rows and revision as stored and writes
 * `rowChanges` (when not null) and appends `events` in one transaction, after checking the revision.
 */
export const handleStripeEvent = (
	input: StripeEventInput,
): StripeEventResult => {
	// Every decision event names its input as `cause`, and the ledger's envelope takes only a ULID there.
	if (!ULID.test(input.eventId))
		return refuse(
			"bad_event",
			`eventId must be the stored input event's id, a ULID; got ${JSON.stringify(input.eventId)} (dedupe on Stripe's own id before this, do not pass it)`,
		);
	const type = (input.event as { type?: unknown } | null)?.type;
	const apiVersion = (input.event as { api_version?: unknown } | null)
		?.api_version;
	if (typeof type !== "string" || typeof apiVersion !== "string")
		return refuse("bad_event", "the event has no type or api_version");
	const mapping = mappingFor(type, apiVersion);
	if (!mapping.ok)
		return refuse("unknown_mapping", JSON.stringify(mapping.error));
	const normalized = normalize(input.event, mapping.value, {
		eventId: input.eventId,
	});
	if (!normalized.ok)
		return refuse("bad_event", JSON.stringify(normalized.error));

	try {
		return decideAndRun(input, mapping.value.target, normalized.value);
	} catch (error) {
		return refuse(
			"rejected",
			error instanceof Error ? error.message : String(error),
		);
	}
};

const decideAndRun = (
	input: StripeEventInput,
	target: string,
	fact: unknown,
): StripeEventResult => {
	const grants = grantsFromRows(input.rows);
	let holder = grants.identity ?? grants.holder;
	if (!holder && target === "BillingInvoice") {
		const invoice = fact as BillingInvoice;
		if (!invoice.metadata.b4u_school || !invoice.metadata.family_id)
			return refuse(
				"missing_metadata",
				`invoice ${invoice.id} has no b4u_school/family_id metadata to name the holder`,
			);
		holder = invoiceHolder(invoice);
	}
	if (!holder && target === "SubscriptionFact")
		holder = subscriptionHolder(fact as SubscriptionFact);
	if (!holder) return nothing();
	const identity: AtmIdentity = {
		orgId: holder.orgId,
		env: "live",
		customerId: holder.customerId,
		entityId: null,
	};
	const catalog = toCatalog(input.catalog);
	const hasEngineRows = input.rows.some((r) => r.table !== GRANTS_TABLE);
	const subject = hasEngineRows
		? subjectFromRows({
				identity,
				revision: input.revision,
				rows: input.rows,
				catalog: input.catalog,
			})
		: null;

	const decision = decide(target, fact, { input, grants, holder, subject });
	if (decision === null) return nothing();
	if (!decision.ok) return decision.refusal;
	const { result } = decision;

	// Run the commands in order against the stored rows, one revision step each. The engine creates a customer at
	// revision zero; a subject whose only row so far is the grants row (a dollar gift came first) holds a later
	// revision, so its engine rows are made at zero and the write is moved up to the stored revision.
	const engineRevision = hasEngineRows ? input.revision : 0;
	let state = stateFromRows({
		identity,
		revision: engineRevision,
		rows: input.rows,
	});
	const mutations: {
		mutation: SubjectStateMutation;
		before: SubjectState | null;
	}[] = [];
	for (const command of result.commands) {
		const run = runOnState({ state, catalog, command });
		if (!run.mutation) continue;
		const status = (run.mutation.result as { status?: string } | undefined)
			?.status;
		if (status === "rejected")
			return refuse(
				"rejected",
				`the engine rejected ${command.type} ${command.commandId}`,
			);
		mutations.push({ mutation: run.mutation, before: state });
		state = run.state;
	}

	const initial = input.rows.filter((r) => r.table !== GRANTS_TABLE);
	let current = { rows: initial, revision: engineRevision };
	for (const { mutation } of mutations) {
		const changes = rowChangesFromMutation({
			mutation,
			rows: current.rows,
			revision: current.revision,
		});
		current = applyRowChanges({ ...current, changes });
	}
	const grantsChanged = !sameJson(grants, result.state);
	if (mutations.length === 0 && !grantsChanged) return nothing();

	const engine = diffRows(initial, current.rows);
	const nextRevision =
		mutations.length > 0
			? current.revision + (input.revision - engineRevision)
			: input.revision + 1;
	const rowChanges = {
		subjectKey: subjectKey(identity),
		expectedRevision: input.revision,
		nextRevision,
		upserts: [
			...engine.upserts,
			...(grantsChanged ? [grantsRow(result.state)] : []),
		],
		deletes: engine.deletes,
	};

	const events = mutations.flatMap(({ mutation, before }) =>
		eventsOf({
			mutation,
			before,
			catalog,
			input,
			grants: result.state,
			labels: result.labels,
			reason: decision.reason,
		}),
	);
	return { rowChanges, events };
};
