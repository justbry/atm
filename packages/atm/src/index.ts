import type { WorkerFullSubject } from "@autumn/balance-engine";
import * as adopt from "./billing/adopt.js";
import * as grants from "./billing/grants.js";
import * as handle from "./billing/handle.js";
import * as menu from "./billing/menu.js";
import * as normalizer from "./billing/normalize.js";
import * as policy from "./billing/policy.js";
import * as raise from "./billing/raise.js";
import * as rows from "./billing/rows.js";
import * as status from "./billing/status.js";
import * as stripeMenu from "./billing/stripe-menu.js";
import { engineCommandTypes, runEngineCommand as run } from "./engine.js";
import { HANDLER_DDL as handlerDdl } from "./handler/schema.js";
import * as signature from "./handler/stripe-signature.js";
import * as webhook from "./handler/stripe-webhook.js";
import { deterministicUlid as deterministicUlidImpl } from "./ledger/ids.js";
import { buildJournal as buildJournalImpl } from "./ledger/journal.js";
import {
	recordEngineCommand as recordEngineCommandImpl,
	recordLapse as recordLapseImpl,
} from "./ledger/outbox.js";
import {
	lapseAlertEvents as lapseAlertEventsImpl,
	lapsedRows as lapsedRowsImpl,
	lapseEvent as lapseEventImpl,
	ledgerEvent as ledgerEventImpl,
	mutationToEvents as mutationToEventsImpl,
} from "./ledger/postings.js";
import {
	ReplayError as ReplayErrorImpl,
	ReplayGapError as ReplayGapErrorImpl,
	replayEvents as replayEventsImpl,
} from "./ledger/replay.js";

import { runOnState as runOnStateImpl, toCatalog } from "./ledger/run.js";
import {
	planOutbox as planOutboxImpl,
	shipOutbox as shipOutboxImpl,
} from "./ledger/ship.js";
import { outboxStatus as outboxStatusImpl } from "./ledger/status.js";
import { validateEvent as validateEventImpl } from "./ledger/validate.js";
import * as folderStore from "./store/folder-store.js";
import * as r2Store from "./store/r2-store.js";
import * as store from "./store/store.js";
import type {
	AtmCatalogRow,
	AtmCommand,
	AtmCommandType,
	AtmEnv,
	AtmEvent,
	AtmEventContext,
	AtmIdentity,
	AtmJournalBuild,
	AtmLapsedRow,
	AtmLedgerEventInput,
	AtmMutation,
	AtmReplayResult,
	AtmResultFor,
	AtmSnapshot,
	AtmStoreError,
	AtmSubject,
	AtmSubjectState,
	AtmValidation,
	BillingDispute,
	BillingFact,
	BillingInvoice,
	BillingPolicy,
	BillingRefund,
	BillingRow,
	CallerRowsImport,
	CallerRowsInput,
	CheckoutInput,
	CheckoutParams,
	CheckoutParamsWithPrices,
	CheckoutResult,
	FolderStoreOptions,
	GrantCommand,
	GrantRemovalInput,
	GrantResult,
	GrantsState,
	InvoiceGrantInput,
	InvoiceLine,
	LineItem,
	Mapping,
	Menu,
	MenuTier,
	MenuToStripeInput,
	MenuValidation,
	NormalizeContext,
	NormalizeError,
	NormalizeResult,
	OneTimeCheckoutInput,
	OneTimeCheckoutParams,
	OneTimeCheckoutParamsWithPrices,
	OneTimeCheckoutResult,
	OutboxBatch,
	OutboxRow,
	OutboxStatus,
	OutboxStatusInput,
	PortalConfigIds,
	ProrationLine,
	ProrationPair,
	R2StoreOptions,
	RaiseUnitsInput,
	RecordEngineCommandInput,
	RecordedEvents,
	RecordLapseInput,
	ReplayErrorConstructor,
	ReplayGapErrorConstructor,
	RowChanges,
	RowTable,
	ShipOutboxInput,
	ShipOutboxResult,
	SignatureVerdict,
	StaleRevisionConstructor,
	Store,
	StripeEventInput,
	StripeEventResult,
	StripeOp,
	SubjectRows,
	SubscriptionEndInput,
	SubscriptionFact,
	SubscriptionItem,
	SubscriptionStatus,
	VerifySignatureInput,
	WebhookDeps,
	WebhookRequest,
	WebhookResponse,
} from "./types.js";

export type * from "./types.js";

export const commandTypes: readonly AtmCommandType[] = engineCommandTypes;

/** Runs one engine command against a subject. Pure: nothing is read or written outside the arguments. */
export const runEngineCommand = <T extends AtmCommandType>({
	subject,
	command,
}: {
	subject: AtmSubject;
	command: AtmCommand & { type: T };
}): AtmResultFor<T> =>
	run({
		fullSubject: subject as unknown as WorkerFullSubject,
		command,
	}) as AtmResultFor<T>;

/** The ledger events an engine mutation makes, with postings derived from its row changes (one rule per event type). Pure. */
export const mutationToEvents = ({
	mutation,
	context,
}: {
	mutation: AtmMutation;
	context: AtmEventContext;
}): AtmEvent[] =>
	mutationToEventsImpl({
		mutation: mutation as unknown as Parameters<
			typeof mutationToEventsImpl
		>[0]["mutation"],
		context,
	});

/** An event that is not an engine mutation: a payment, payout, plan change or other bookkeeping line. Pure. */
export const ledgerEvent = (input: AtmLedgerEventInput): AtmEvent =>
	ledgerEventImpl(input);

/** Rows of `feature` past their expiry at `atMs` that still hold a balance (the cron books them as `credit.expired`). */
export const lapsedRows = ({
	state,
	featureOf,
	feature,
	atMs,
}: {
	state: AtmSubjectState;
	featureOf: (internalFeatureId: string) => string | undefined;
	feature: string;
	atMs: number;
}): AtmLapsedRow[] =>
	lapsedRowsImpl({
		state: state as unknown as Parameters<typeof lapsedRowsImpl>[0]["state"],
		featureOf,
		feature,
		atMs,
	});

/** The `credit.expired` event for one lapsed row, at the instant it lapsed. */
export const lapseEvent = (input: {
	row: AtmLapsedRow;
	holder: string;
	key: string;
	feature: string;
	school: string;
	tz: string;
	revision: number;
	labels?: Record<string, string>;
	ingestTime?: string | number;
}): AtmEvent => lapseEventImpl(input);

/**
 * The `credit.depleted` events (payload `cause: "expired"`) for a feature whose credits ran out by the clock: its total
 * over every plan goes from above 0 to 0 or below at an instant rows lapsed. One event per instant, none when other
 * credits remain, no `credit.low`. Opt-in by calling it; `lapseEvent` is unchanged.
 *
 * `drawnAfter(instantMs)` is required: the units of the feature the holder drew after that instant and up to `atMs`,
 * from the cron's ledger or journal (draws only). The state holds balances as of now, so a late run is judged with those
 * draws added back; `() => 0` is right only when `state` is the state `lapsedRows` read, as of the lapse. `revision` is
 * the one you give the `credit.expired` events of the instant (the highest, if they differ): the alert shares their time
 * and is booked at `revision + 1`, so every ordering by id (replay, journal, month files) puts it after them.
 */
export const lapseAlertEvents = ({
	state,
	...input
}: {
	state: AtmSubjectState;
	featureOf: (internalFeatureId: string) => string | undefined;
	feature: string;
	atMs: number;
	drawnAfter: (instantMs: number) => number;
	key: string;
	school: string;
	tz: string;
	revision: number;
	labels?: Record<string, string>;
	ingestTime?: string | number;
}): AtmEvent[] =>
	lapseAlertEventsImpl({
		state: state as unknown as Parameters<typeof lapsedRowsImpl>[0]["state"],
		...input,
	});

/**
 * The id of a stored input event, derived from a time, a revision and a seed: a ULID whose 48-bit time is `timeMs`
 * (the event's own instant), then 24 bits of `revision` (events in one millisecond sort in the order they were decided),
 * then 56 bits of a hash of `seed` (say, the school and the Stripe event id). The same inputs always give the same id,
 * so a redelivered event gets the id it had. Throws when `timeMs` is not an integer in ULID range.
 */
export const deterministicUlid = (input: {
	timeMs: number;
	revision: number;
	seed: string;
}): string => deterministicUlidImpl(input);

/** An event against the envelope schema, its payload schema, and the rules a schema cannot say (postings sum to zero, ...). */
export const validateEvent = (event: unknown): AtmValidation =>
	validateEventImpl(event);

/** Events back through the engine in replay order (each subject's commands by revision), each with its own time as `now`; throws an Error named `ReplayError` (with `eventId`) where the engine disagrees with the log. */
export const replayEvents = (input: {
	events: readonly AtmEvent[];
	catalog: readonly AtmCatalogRow[];
	snapshot?: AtmSnapshot;
	lastEventId?: string;
	asOf?: string;
}): AtmReplayResult => replayEventsImpl(input);

/** Thrown by `replayEvents` where the engine disagrees with the log; `eventId` names the event. */
export const ReplayError: ReplayErrorConstructor = ReplayErrorImpl;
export type ReplayError = InstanceType<ReplayErrorConstructor>;

/** Thrown at a log written by atm 0.3.0 that has revisions with no event (see `UPGRADING.md`, "Replaying a log"); `prefix` is the replay up to the gap. */
export const ReplayGapError: ReplayGapErrorConstructor = ReplayGapErrorImpl;
export type ReplayGapError = InstanceType<ReplayGapErrorConstructor>;

/** A school's hledger files for one month, built from its events. Paths are under the school's prefix; no clock is read. */
export const buildJournal = (input: {
	events: readonly AtmEvent[];
	month: string;
}): AtmJournalBuild => buildJournalImpl(input);

// ---- Billing: pure rules for the school's menu, Stripe facts, credit grants and storage rows ----

export const DEFAULT_POLICY: BillingPolicy = policy.DEFAULT_POLICY;

/**
 * The `org` to put on every command that draws: `track`, `check`, `finalize`, `updateBalance`, `deleteBalance` and
 * `recalculateBalance`. The engine takes its draw order from it (`policy.deductionOrder`). A caller that sends its
 * own org config gets the engine's own order instead.
 */
export const commandOrg = (billingPolicy: BillingPolicy) =>
	policy.commandOrg(billingPolicy);

/** A school's policy overrides over the defaults; throws, naming each problem, on an unknown key or wrong value. */
export const resolvePolicy = (overrides: unknown): BillingPolicy =>
	policy.resolvePolicy(overrides);

/**
 * Runs one command (any engine command, or the `applyBillingPlan` that `invoiceToCommands` makes) against a subject
 * state, with the catalog from `menuCatalogRows`: the mutation it decides and the state after it. `state` is null for
 * a subject with no rows yet. The command carries its own time; nothing reads the clock.
 */
export const runOnState = (input: {
	state: AtmSubjectState | null;
	catalog: readonly AtmCatalogRow[];
	command: GrantCommand | (AtmCommand & Record<string, unknown>);
}): { mutation: AtmMutation | null; state: AtmSubjectState | null } => {
	const r = runOnStateImpl({
		state: input.state as unknown as Parameters<
			typeof runOnStateImpl
		>[0]["state"],
		catalog: toCatalog(input.catalog),
		command: input.command as Parameters<typeof runOnStateImpl>[0]["command"],
	});
	return r as unknown as {
		mutation: AtmMutation | null;
		state: AtmSubjectState | null;
	};
};

export const EMPTY_GRANTS_STATE: GrantsState = grants.EMPTY_GRANTS_STATE;

/** The engine catalog rows (features, products, entitlements) for a menu. */
export const menuCatalogRows = (input: {
	menu: Menu;
	school: string;
	createdAt?: number;
	/** The Stripe mode of the subjects the catalog serves; default `"live"`. */
	env?: AtmEnv;
}): AtmCatalogRow[] => grants.menuCatalogRows(input);

/** The engine commands a paid invoice makes (grants, resets, upgrades), and the next state. A replayed invoice gives none. */
export const invoiceToCommands = (input: InvoiceGrantInput): GrantResult =>
	grants.invoiceToCommands(input);

/**
 * Stripe's proration pair for a raise of the quantity: the credit line holds the OLD quantity, the charge line the NEW
 * total. With several pairs the positive line that starts last is the raise. `isTierPrice` picks the lines of the tier's
 * price. Null when there is no such charge line. Pure; `invoiceToCommands` reads a raise through it.
 */
export const prorationPair = <Line extends ProrationLine>(
	lines: readonly Line[],
	isTierPrice: (line: Line) => boolean,
): ProrationPair | null => raise.prorationPair(lines, isTierPrice);

/**
 * The units a raise grants: (new - old) x `perUnit` x the share of the cycle left at `at`, rounded up, following
 * `policy.upgradeGrant` (`prorated`, `full`, `none`); a decrease or the same count gives 0. `oldQuantity` is the count
 * the credits reflect, not Stripe's credit line. Pure; `invoiceToCommands` grants a raise through it.
 */
export const raiseUnits = (input: RaiseUnitsInput): number =>
	raise.raiseUnits(input);

/** A full refund takes back that invoice's unused credits (per policy); a partial refund changes nothing. */
export const refundToCommands = (
	input: GrantRemovalInput & { refund: BillingRefund },
): GrantResult => grants.refundToCommands(input);

/** A lost dispute is a full refund; an open or won one changes nothing. */
export const disputeToCommands = (
	input: GrantRemovalInput & { dispute: BillingDispute },
): GrantResult => grants.disputeToCommands(input);

/**
 * One entry point for a raw Stripe event: normalize, apply the grant rules, run the engine, and return the single
 * write for the subject's rows (engine rows and the grants row, one revision) and the decision events (`cause` = the
 * event id; labelled with the menu, policy and mapping versions). The caller verifies and dedupes the event, passes the
 * subject's stored rows and revision, and writes the result in one transaction. A replayed event gives no changes; an
 * event atm cannot decide comes back `refused` with nothing to write.
 */
export const handleStripeEvent = (input: StripeEventInput): StripeEventResult =>
	handle.handleStripeEvent(input);

/**
 * A canceled subscription: the tier and add-on rows stop refilling and the last cycle's unused credits lapse at their
 * own expiry (cycle end plus rollover months), not at once. Any other fact, or a second end, gives none.
 */
export const subscriptionEndedToCommands = (
	input: SubscriptionEndInput,
): GrantResult => grants.subscriptionEndedToCommands(input);

/**
 * Any `customer.subscription.*` fact: records the membership (status, tier and interval the menu names for its price,
 * renewal or end date) in `state.membership` and, for a canceled subscription, lets the credits lapse as
 * `subscriptionEndedToCommands` does. Grants nothing; an older fact than the one on record changes nothing.
 */
export const subscriptionToCommands = (
	input: SubscriptionEndInput,
): GrantResult => grants.subscriptionToCommands(input);

export const MAX_TIERS: number = menu.MAX_TIERS;
export const MAX_ADDONS: number = menu.MAX_ADDONS;
export const MAX_FEATURES: number = menu.MAX_FEATURES;
/** Most counts a tier can list in `quantities`, and the largest count. */
export const MAX_QUANTITIES: number = menu.MAX_QUANTITIES;
export const MAX_QUANTITY: number = menu.MAX_QUANTITY;

/** The counts a tier is sold in: its `quantities`, or [1] when it lists none. */
export const quantitiesOf = (tier: MenuTier): readonly number[] =>
	menu.quantitiesOf(tier);

/** Checks an unknown value against the menu schema and the cross-field rules; the menu comes back with trimmed text. */
export const validateMenu = (input: unknown): MenuValidation =>
	menu.validateMenu(input);

/** What stops a valid menu from being published: dotted paths. */
export const publishProblems = (m: Menu): string[] => menu.publishProblems(m);

/** The menu without the tiers the school has not made public. */
export const publicMenu = (m: Menu): Menu => menu.publicMenu(m);

/** An IANA zone the runtime knows. */
export const validTimeZone = (tz: string): boolean => menu.validTimeZone(tz);

/** The Stripe steps that make Stripe match `menu`, given that it matches `previous`. Publishing the same menu again gives `[]`. */
export const menuToStripe = (input: MenuToStripeInput): StripeOp[] =>
	stripeMenu.menuToStripe(input);

/** The Checkout Session for a tier and interval plus add-ons, or why not. */
export const checkoutParams = (input: CheckoutInput): CheckoutResult =>
	stripeMenu.checkoutParams(input);

/**
 * The payment-mode Checkout Session for add-ons priced `once` with no membership (a gift certificate, a pack), with
 * `invoice_creation` on so Stripe makes the paid invoice atm grants from, or why not. See `OneTimeCheckoutParams`.
 */
export const oneTimeCheckoutParams = (
	input: OneTimeCheckoutInput,
): OneTimeCheckoutResult => stripeMenu.oneTimeCheckoutParams(input);

/** `params` (a membership's or a one-time checkout's) with each line's lookup key swapped for its Stripe price id; null when a price is not published yet. */
export function withPriceIds(
	params: CheckoutParams,
	priceIds: Readonly<Record<string, string>>,
): CheckoutParamsWithPrices | null;
export function withPriceIds(
	params: OneTimeCheckoutParams,
	priceIds: Readonly<Record<string, string>>,
): OneTimeCheckoutParamsWithPrices | null;
export function withPriceIds(
	params: CheckoutParams | OneTimeCheckoutParams,
	priceIds: Readonly<Record<string, string>>,
): CheckoutParamsWithPrices | OneTimeCheckoutParamsWithPrices | null {
	return params.mode === "payment"
		? stripeMenu.withPriceIds(params, priceIds)
		: stripeMenu.withPriceIds(params, priceIds);
}

/** Flattens nested params to Stripe's form encoding (`line_items[0][price]`). */
export const toStripeForm = (
	params: Record<string, unknown>,
): Record<string, string> => stripeMenu.toStripeForm(params);

/**
 * The form fields for `POST /v1/billing_portal/configurations` that let a family change the quantity of a tier sold in
 * `quantities`: a raise billed at once (`always_invoice`, so its paid invoice grants the extra units), a decrease at the
 * renewal. Null when no public tier has several quantities (or none has its product and a price published): the school's default
 * portal applies. Pass the id of the configuration it makes as `configuration` on every portal session.
 */
export const portalConfigOf = (
	menu: Menu,
	ids: PortalConfigIds,
): Record<string, string> | null => stripeMenu.portalConfigOf(menu, ids);

/** The lookup key that names a Stripe price for life. */
export const lookupKeyOf = (
	schoolId: string,
	priceKey: string,
	amount: number,
	currency: string,
): string => stripeMenu.lookupKeyOf(schoolId, priceKey, amount, currency);

/** A subscription's state as the membership shows it. */
export const subscriptionStatus = (
	fact: SubscriptionFact,
): SubscriptionStatus => status.subscriptionStatus(fact);

/** Normalizes one raw Stripe event with a mapping; refuses an event whose type or API version is not the mapping's. */
export const normalize = (
	event: unknown,
	mapping: Mapping,
	ctx: NormalizeContext,
): NormalizeResult<BillingFact> => normalizer.normalize(event, mapping, ctx);

/**
 * A sentence for a `NormalizeError`. An event from another Stripe API version says which version the endpoint is on and
 * the fix: recreate the endpoint with the version atm reads (`handleStripeEvent` refuses it with this as the message).
 */
export const describeNormalizeError = (error: NormalizeError): string =>
	normalizer.describeNormalizeError(error);

/** The mapping for an event type and Stripe API version; an unknown pair is refused. */
export const mappingFor = (
	eventType: string,
	apiVersion: string,
): NormalizeResult<Mapping> => normalizer.mappingFor(eventType, apiVersion);

/** The envelope labels for a mapping. */
export const mappingLabels = (
	mapping: Mapping,
): { mapping: string; stripe_api_version: string } =>
	normalizer.mappingLabels(mapping);

/** Invoice lines matched against the menu by lookup key, else price id. */
export const resolveLines = (
	lines: readonly InvoiceLine[],
	itemByKey: ReadonlyMap<string, LineItem>,
): InvoiceLine[] => normalizer.resolveLines(lines, itemByKey);

/** An invoice with its lines resolved against the menu. */
export const resolveInvoice = (
	invoice: BillingInvoice,
	itemByKey: ReadonlyMap<string, LineItem>,
): BillingInvoice => normalizer.resolveInvoice(invoice, itemByKey);

/** The tier, interval and quantity the menu names for a subscription's items, or null when none is a tier. */
export const resolveSubscriptionPlan = (
	items: readonly SubscriptionItem[],
	itemByKey: ReadonlyMap<string, LineItem>,
) => normalizer.resolveSubscriptionPlan(items, itemByKey);

/** A deep copy of the raw event without the mapping's personal-data paths. */
export const redactPersonal = (payload: unknown, mapping: Mapping): unknown =>
	normalizer.redactPersonal(payload, mapping);

/** Every mapping file this package ships. */
export const MAPPINGS: readonly Mapping[] = normalizer.MAPPINGS;

/** The engine's state tables, in the order rows are listed. The grants row (`atm_grants`) follows them. */
export const ROW_TABLES: readonly RowTable[] = rows.ROW_TABLES;

/** The table (`atm_grants`) and row id of the one row that holds a subject's billing-rules state. */
export const GRANTS_TABLE: "atm_grants" = rows.GRANTS_TABLE;
export const GRANTS_ROW_ID: string = rows.GRANTS_ROW_ID;

/** The `GrantsState` stored with a subject's rows; no grants row is `EMPTY_GRANTS_STATE`. */
export const grantsFromRows = (rows_: readonly BillingRow[]): GrantsState =>
	rows.grantsFromRows(rows_);

/** The grants row for a `GrantsState`: write it with the engine rows, under the same revision. */
export const grantsRow = (state: GrantsState): BillingRow =>
	rows.grantsRow(state);

/** Thrown when the stored revision is not the one a mutation was computed against: re-read, recompute, retry. */
export const StaleRevision: StaleRevisionConstructor = rows.StaleRevision;
export type StaleRevision = InstanceType<StaleRevisionConstructor>;

/** Stable string for a subject: `<orgId>|<env>|<customerId>` plus `|<entityId>` for an entity. */
export const subjectKey = (identity: AtmIdentity): string =>
	rows.subjectKey(identity);

/** Throws StaleRevision unless `actual === expected`. */
export const assertRevision = (input: {
	expected: number;
	actual: number;
	subjectKey?: string;
}): void => rows.assertRevision(input);

/** A subject's state split into rows (canonical order, JSON-safe). */
export const rowsFromState = (state: AtmSubjectState): BillingRow[] =>
	rows.rowsFromState(
		state as unknown as Parameters<typeof rows.rowsFromState>[0],
	);

/** Rows back to a state; no rows is null. */
export const stateFromRows = (input: SubjectRows): AtmSubjectState | null =>
	rows.stateFromRows(input) as unknown as AtmSubjectState | null;

/**
 * A caller that grants on its own (B4 Uni's family service: `school_memberships` and `school_credit_lots`) moves onto
 * `handleStripeEvent` by writing what this returns for each member once: the engine rows (the lots as refilling credit
 * rows and rollovers) and the `atm_grants` row (`state`, which remembers every invoice the lots name, so replaying one
 * grants nothing again), under one revision. It is not `stateFromRows`, which turns atm's own rows into an engine state.
 * Throws, naming each problem, when the rows name a tier, add-on or feature the menu lacks or cannot be placed on atm's
 * rows; it does not guess. See UPGRADING.md ("Moving an existing caller onto handleStripeEvent").
 */
export const grantsStateFromCallerRows = (
	input: CallerRowsInput,
): CallerRowsImport => adopt.grantsStateFromCallerRows(input);

/** The engine's subject for a command: the rows joined with the catalog. Throws when there are no rows. */
export const subjectFromRows = (
	input: SubjectRows & { catalog: readonly AtmCatalogRow[] },
): AtmSubject => rows.subjectFromRows(input);

/** The writes a mutation makes to the stored rows, computed against the current rows and revision (else StaleRevision). */
export const rowChangesFromMutation = (input: {
	mutation: AtmMutation;
	rows: readonly BillingRow[];
	revision: number;
}): RowChanges => rows.rowChangesFromMutation(input);

/** Applies row changes to a row list in memory; refuses a stale revision. */
export const applyRowChanges = (input: {
	rows: readonly BillingRow[];
	revision: number;
	changes: RowChanges;
}): { rows: BillingRow[]; revision: number } => rows.applyRowChanges(input);

// ---- The object store the ledger writes through ----

type ErrorClass<Args extends unknown[]> = new (...args: Args) => AtmStoreError;

export type StoreError = AtmStoreError;

export const StoreError: ErrorClass<[message: string, key?: string | null]> =
	store.StoreError;
export const AlreadyExists: ErrorClass<[key: string]> = store.AlreadyExists;
export const Stale: ErrorClass<[key: string]> = store.Stale;
export const NotFound: ErrorClass<[key: string]> = store.NotFound;
export const Transient: ErrorClass<
	[key: string | null, message: string, cause?: unknown]
> = store.Transient;
export const ShaMismatch: ErrorClass<
	[key: string, expected: string, actual: string]
> = store.ShaMismatch;
export const Conflict: ErrorClass<
	[key: string, expected: string, actual: string]
> = store.Conflict;
export const Unsupported: ErrorClass<[operation: string]> = store.Unsupported;

export const sha256Hex = (bytes: Uint8Array): string => store.sha256Hex(bytes);
export const utf8 = (text: string): Uint8Array => store.utf8(text);

/** The object's sha256: the stored `x-amz-meta-sha256`, else the hash of its body. Throws NotFound. */
export const identify = (s: Store, key: string): Promise<string> =>
	store.identify(s, key);

/** Put-once step (the ADR's 412 rules): "created", or "existing" when an equal object is already there; different bytes throw Conflict. */
export const putOnce = (
	s: Store,
	key: string,
	body: Uint8Array,
): Promise<"created" | "existing"> => store.putOnce(s, key, body);

/** Upsert step: replace while the ETag matches; "existing" when the object already holds these bytes; another change throws Stale. */
export const replaceIfMatch = (
	s: Store,
	key: string,
	body: Uint8Array,
	etag: string,
): Promise<"replaced" | "existing"> => store.replaceIfMatch(s, key, body, etag);

/** Objects as files under a folder: the Store for tests and local runs. ETag is the sha256 of the bytes. */
export const FolderStore: new (options: FolderStoreOptions) => Store =
	folderStore.FolderStore;

/** An R2 or other S3-compatible bucket on `aws4fetch`; conditional puts, sha256 identity, bounded retries. */
export const R2Store: new (options: R2StoreOptions) => Store = r2Store.R2Store;

// ---- The reference webhook handler (Bun or Node; not a Worker) ----

/** The tables the handler keeps in the caller's SQLite: rows, event claims, the payment index and the ledger outbox. */
export const HANDLER_DDL: string = handlerDdl;

/** Checks a `Stripe-Signature` header against the raw body: HMAC-SHA256 over `t.payload`, constant time, 300 s tolerance. */
export const verifyStripeSignature = (
	input: VerifySignatureInput,
): SignatureVerdict => signature.verifyStripeSignature(input);

/** A `Stripe-Signature` header for a payload, for tests and local replays. */
export const signStripePayload = (input: {
	payload: string;
	secret: string;
	timestampSeconds: number;
}): string => signature.signStripePayload(input);

/**
 * One Stripe webhook: verify the signature, claim the event id (a stale claim is taken over), then in one SQLite
 * transaction apply the rows, append the events to the outbox and mark the claim done. See `src/handler/stripe-webhook.ts`.
 */
export const handleStripeWebhook = (
	deps: WebhookDeps,
	request: WebhookRequest,
): WebhookResponse => webhook.handleStripeWebhook(deps, request);

// ---- The shipper: the outbox to the log ----

/**
 * The plan of a shipment: the unshipped rows of one school as one batch per event date, each object's key and bytes a
 * pure function of its rows (the bodies as they are, in id order; the key holds the first id and a prefix of the text's
 * sha256), so a retry or a second shipper plans the same object. Throws on a bad date, an id with a `/`, or a body that is not one line of JSON with the row's own `id`, `idem` and `date`.
 */
export const planOutbox = (input: {
	school: string;
	rows: readonly OutboxRow[];
}): OutboxBatch[] => planOutboxImpl(input);

/**
 * The shipper, for any `Store`: puts the school's unshipped `ledger_outbox` rows as `schools/<school>/events/date=<day>/
 * batch-*.jsonl` (create-only; an equal object already there counts as shipped, different bytes is reported in
 * `conflicts` and the rows stay unshipped; so is a day that already has a `day.jsonl`, which the reader would not read
 * a batch beside), then marks the rows shipped. Run it after the handler, as often as you like: a rerun, a crash between
 * put and mark, and a second shipper all end the same, unless new rows for that day arrived in between (then a second,
 * overlapping batch is put and the reader drops the repeated events by `idem`). It does not combine batches into
 * `day.jsonl`, write a manifest or know R2: those are not built. See the README.
 */
export const shipOutbox = (input: ShipOutboxInput): Promise<ShipOutboxResult> =>
	shipOutboxImpl(input);

/**
 * What a health check reads about a school's outbox: the counts, the newest shipment, and the oldest unshipped row's
 * date and age. Alert when `unshipped` is above 0 and `oldestUnshippedAgeMs` is past a few shipping intervals (or when
 * `shipOutbox` reports a conflict: those rows never move on their own). Reads only; see the README, "Running it".
 */
export const outboxStatus = (input: OutboxStatusInput): OutboxStatus =>
	outboxStatusImpl(input);

// ---- The family service's own commands: into the same outbox ----

/**
 * Appends the events of one engine command the family service ran (a hold, a finalize, a spend, a refund) to
 * `ledger_outbox`, as the handler books its own: the whole mutation on every event, a `plan.changed` when it moves no
 * credits, `idem` by command id (the same mutation recorded again inserts nothing; a command id already used by another command throws). Call it inside the transaction that writes the subject's rows,
 * after the revision check: it opens none. Nothing is written for a null or rejected result. `logsEveryCommand` writes
 * `payload.complete`; leave it off unless the caller records every command (see the README).
 */
export const recordEngineCommand = (
	input: RecordEngineCommandInput,
): RecordedEvents => recordEngineCommandImpl(input);

/**
 * Appends the `credit.expired` events of the rows that lapsed by `atMs` (and, with `drawnAfter`, the `credit.depleted`
 * ones) to `ledger_outbox`. Idempotent by holder, row and expiry. Same transaction rule as `recordEngineCommand`.
 */
export const recordLapse = (input: RecordLapseInput): RecordedEvents =>
	recordLapseImpl(input);
