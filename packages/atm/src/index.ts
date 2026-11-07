import type { WorkerFullSubject } from "@autumn/balance-engine";
import * as adopt from "./billing/adopt.js";
import * as bookable from "./billing/bookable.js";
import * as bookingPay from "./billing/booking-pay.js";
import * as codes from "./billing/codes.js";
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
import * as storedInputs from "./handler/inputs.js";
import {
	HANDLER_DDL as handlerDdl,
	migrateHandlerSchema as migrateHandlerSchemaImpl,
} from "./handler/schema.js";
import * as signature from "./handler/stripe-signature.js";
import * as webhook from "./handler/stripe-webhook.js";
import { catalogPublishedEvent as catalogPublishedEventImpl } from "./ledger/catalog.js";
import * as checkpoints from "./ledger/checkpoints.js";
import { duckdbDdl as duckdbDdlImpl } from "./ledger/duckdb.js";
import {
	journalMonth as journalMonthImpl,
	readEvents as readEventsImpl,
} from "./ledger/files.js";
import { deterministicUlid as deterministicUlidImpl } from "./ledger/ids.js";
import { buildJournal as buildJournalImpl } from "./ledger/journal.js";
import {
	appendToOutbox as appendToOutboxImpl,
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
	checkReceiptAgainstEvents as checkReceiptAgainstEventsImpl,
	receiptOf as receiptOfImpl,
	signReceipt as signReceiptImpl,
	verifyReceipt as verifyReceiptImpl,
} from "./ledger/receipt.js";
import { reconcile as reconcileImpl } from "./ledger/reconcile.js";
import {
	balancesOf as balancesOfImpl,
	ReplayError as ReplayErrorImpl,
	ReplayGapError as ReplayGapErrorImpl,
	replayEvents as replayEventsImpl,
} from "./ledger/replay.js";
import {
	HledgerError as HledgerErrorImpl,
	REPORT_NAMES as REPORT_NAMES_IMPL,
	reportMonth as reportMonthImpl,
} from "./ledger/report.js";
import { runOnState as runOnStateImpl, toCatalog } from "./ledger/run.js";
import {
	sealOf as sealOfImpl,
	signSeal as signSealImpl,
	verifySeals as verifySealsImpl,
} from "./ledger/seal.js";
import {
	formatShareStatement as formatShareStatementImpl,
	shareStatement as shareStatementImpl,
} from "./ledger/share-statement.js";
import {
	planOutbox as planOutboxImpl,
	shipOutbox as shipOutboxImpl,
} from "./ledger/ship.js";
import * as shipInputsModule from "./ledger/ship-inputs.js";
import { simulate as simulateImpl } from "./ledger/simulate.js";
import {
	InputsSimulateError as InputsSimulateErrorImpl,
	replayInputs as replayInputsImpl,
	simulateFromInputs as simulateFromInputsImpl,
} from "./ledger/simulate-inputs.js";
import { outboxStatus as outboxStatusImpl } from "./ledger/status.js";
import {
	canonicalize as canonicalizeImpl,
	decimalToUnits as decimalToUnitsImpl,
	localDate as localDateImpl,
} from "./ledger/util.js";
import { validateEvent as validateEventImpl } from "./ledger/validate.js";
import * as bundles from "./scenario/bundle.js";
import * as folderStore from "./store/folder-store.js";
import * as r2Store from "./store/r2-store.js";
import * as store from "./store/store.js";
import type {
	AtmBalance,
	AtmCatalogRow,
	AtmCommand,
	AtmCommandType,
	AtmEnv,
	AtmEvent,
	AtmEventContext,
	AtmEventFile,
	AtmHold,
	AtmIdentity,
	AtmJournalBuild,
	AtmLapsedRow,
	AtmLedgerEventInput,
	AtmMutation,
	AtmPublicKeys,
	AtmReceipt,
	AtmReplayResult,
	AtmResultFor,
	AtmSeal,
	AtmSignedReceipt,
	AtmSignedSeal,
	AtmSigner,
	AtmSimulateInput,
	AtmSimulation,
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
	BillingValidation,
	BookingCheckoutInput,
	BookingCheckoutResult,
	BookingQuote,
	BookingResult,
	CallerRowsImport,
	CallerRowsInput,
	CatalogPublishedInput,
	ChannelReport,
	CheckoutInput,
	CheckoutParams,
	CheckoutParamsWithPrices,
	CheckoutResult,
	Checkpoint,
	CheckpointKpiRow,
	CheckpointStep,
	CreateSessionGiftCodeInput,
	CreateSessionGiftCodeResult,
	DollarGiftInput,
	DollarGiftResult,
	ExpiredHold,
	FileTree,
	FolderStoreOptions,
	GrantCommand,
	GrantRemovalInput,
	GrantResult,
	GrantsState,
	HandlerMigrationResult,
	HledgerErrorConstructor,
	HoldBookingInput,
	InputsBatch,
	InputsRead,
	InputsShipStatus,
	InputsSimulateErrorConstructor,
	InputsSimulateInput,
	InputsSimulation,
	InputsSource,
	InputsStatus,
	InvoiceGrantInput,
	InvoiceLine,
	JournalRun,
	LedgerVerdict,
	LineItem,
	Mapping,
	Menu,
	MenuTier,
	MenuToStripeInput,
	MenuValidation,
	MutationCheckpointInput,
	NormalizeContext,
	NormalizedStripeEvent,
	NormalizeError,
	NormalizeResult,
	OneTimeCheckoutInput,
	OneTimeCheckoutParams,
	OneTimeCheckoutParamsWithPrices,
	OneTimeCheckoutResult,
	OutboxBatch,
	OutboxCheckpointRow,
	OutboxRow,
	OutboxStatus,
	OutboxStatusInput,
	PortalConfigIds,
	ProrationLine,
	ProrationPair,
	QuoteInput,
	R2StoreOptions,
	RaiseUnitsInput,
	ReceiptVerdict,
	ReconcileInput,
	ReconcileResult,
	ReconcileVerdictInput,
	RecordEngineCommandInput,
	RecordedEvents,
	RecordInputArgs,
	RecordLapseInput,
	RedeemSessionGiftCodeInput,
	RedeemSessionGiftCodeResult,
	ReplayErrorConstructor,
	ReplayGapErrorConstructor,
	ReplayInputsOptions,
	ReplayInputsResult,
	ReportChoice,
	ReportFormat,
	ReportName,
	ReportRun,
	RowChanges,
	RowTable,
	ScenarioBundle,
	SealOfInput,
	SealReport,
	SettleBookingInput,
	SettleInputErasuresResult,
	ShareStatement,
	ShipInputsInput,
	ShipInputsResult,
	ShipOutboxInput,
	ShipOutboxResult,
	SignatureVerdict,
	SqlDatabase,
	StaleRevisionConstructor,
	Store,
	StoredInput,
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

/**
 * The `catalog.published` event for a menu (what a family service writes when a school publishes it): type
 * `catalog.published`, key the school id, idem `settings:catalog:<version>`, no postings. Throws on a menu with no tier
 * or add-on to publish. Also in `atm/worker`. Pure.
 */
export const catalogPublishedEvent = (input: CatalogPublishedInput): AtmEvent =>
	catalogPublishedEventImpl(input);

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
 * `drawnAfter(t)` is required: the units of the feature the holder drew strictly after `t` and up to `atMs`, from the
 * cron's ledger or journal (draws only). It is called once per lapse instant, with `instant - 1`, so it counts the draws
 * at the lapse instant itself too (they could not have used the row that lapsed). The state holds balances as of now,
 * so a late run is judged with those draws added back; `() => 0` is right only when `state` is the state `lapsedRows`
 * read, as of the lapse. `revision` is the one you give the `credit.expired` events of the instant (the highest, if they
 * differ): the alert shares their time and is booked at `revision + 1`, so every ordering by id (replay, journal, month
 * files) puts it after them.
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

/**
 * A what-if: the log's commands run again under a candidate catalog (or menu) and policy, set against the log. Returns
 * the balances, posting totals and decisions that differ, the commands the candidate refuses, and the candidate's events
 * (build its journal from them). Credits only: it cannot change what Stripe charged, and the grant rules (`policy.upgradeGrant`,
 * amounts decided from invoices) are not in the log's commands. Writes nothing; changes no input.
 */
export const simulate = (input: AtmSimulateInput): AtmSimulation =>
	simulateImpl(input);

/**
 * A what-if on the grant rules, from the Stripe inputs the handler stored: they are decided again through the same rules with
 * the menu and policy each was handled under (the baseline, which must equal the log) and then with a candidate, and set against
 * the log: per delivery, per holder balance, and posting totals by month. `inputs` is the result of any `InputsSource.read`
 * (`sqliteInputsSource`). What is not stored (history before the inputs were, an erased holder, a holder whose rows moved by a
 * write nothing records, a refund after a credit hold) is carried over unchanged and counted in `notReplayable`. Credits only: it
 * cannot change what Stripe charged. Writes nothing. Throws `InputsSimulateError` for input it cannot use, among them a baseline
 * that does not reproduce the log (unless `allowBaselineDrift`).
 */
export const simulateFromInputs = (
	input: InputsSimulateInput,
): InputsSimulation => simulateFromInputsImpl(input);

/** The replay `simulateFromInputs` is made of, for a caller that wants the decisions themselves: the inputs in applied order, the log's other commands between them. */
export const replayInputs = (
	options: ReplayInputsOptions,
): ReplayInputsResult => replayInputsImpl(options);

/** Thrown by `simulateFromInputs` for input it cannot use. */
export const InputsSimulateError: InputsSimulateErrorConstructor =
	InputsSimulateErrorImpl;
export type InputsSimulateError = InstanceType<InputsSimulateErrorConstructor>;

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

/**
 * A school's events against Stripe's records for one period (a month or a range of days, in the school's zone): paid
 * invoices, refunds, disputes, payouts, fees and the net of the money postings. Returns every difference (`missing_in_log`,
 * `missing_in_stripe`, `amount_differs`, `duplicate_in_log`, ...); a nightly job alerts on a non-empty `differences`.
 * Pure: it makes no Stripe call. Throws on a bad period or time zone. See the README ("Reconciling with Stripe").
 */
export const reconcile = (input: ReconcileInput): ReconcileResult =>
	reconcileImpl(input);

/**
 * What a school owes B4 Uni for one month, from its events alone: a row per payment that accrued a revenue share
 * (`share.accrued`) or had part of it reversed by a refund (`share.reversed`) in the month, the totals (accrued, reversed,
 * settled by `share.settled`, and what the month adds to what is owed) and the balance `liabilities:b4uni` holds at the
 * month's end. A month is chosen by each event's date in the school's time zone (`tz` re-dates them in another zone), and a
 * second event with an `idem` already seen is dropped, so a log read twice gives the same statement. Pure: it reads no
 * clock and no store. B4 Uni invoices from it outside atm; record the payment with a `share.settled` event. See
 * `docs/financial-reports.md`, "Revenue share".
 */
export const shareStatement = (input: {
	events: readonly AtmEvent[];
	school: string;
	month: string;
	tz?: string;
}): ShareStatement => shareStatementImpl(input);

/** A `shareStatement` as CSV-style text: a header and a row per payment, then the totals as `name,amount` lines. Amounts are dollars. */
export const formatShareStatement = (statement: ShareStatement): string =>
	formatShareStatementImpl(statement);

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

/**
 * `params` (a membership's or a one-time checkout's) with each line's lookup key swapped for its Stripe price id; null when a
 * price is not published yet. A membership checkout made with a `code` carries `discounts` by the code's text: pass
 * `promotionCodeIds` (Stripe's `promo_...` id by code text, compared without case) to swap it for the id; null when it is missing.
 */
export function withPriceIds(
	params: CheckoutParams,
	priceIds: Readonly<Record<string, string>>,
	promotionCodeIds?: Readonly<Record<string, string>>,
): CheckoutParamsWithPrices | null;
export function withPriceIds(
	params: OneTimeCheckoutParams,
	priceIds: Readonly<Record<string, string>>,
): OneTimeCheckoutParamsWithPrices | null;
export function withPriceIds(
	params: CheckoutParams | OneTimeCheckoutParams,
	priceIds: Readonly<Record<string, string>>,
	promotionCodeIds?: Readonly<Record<string, string>>,
): CheckoutParamsWithPrices | OneTimeCheckoutParamsWithPrices | null {
	return params.mode === "payment"
		? stripeMenu.withPriceIds(params, priceIds)
		: stripeMenu.withPriceIds(params, priceIds, promotionCodeIds);
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

/** The tables the handler keeps in the caller's SQLite: rows, event claims, the payment index, the ledger outbox and the stored inputs (`atm_event_inputs` and its three helper tables; additive, nothing is rebuilt). */
export const HANDLER_DDL: string = handlerDdl;

/**
 * Brings a handler database made before `env` was a key to the shape of `HANDLER_DDL`: rebuilds `atm_event_claims`,
 * `atm_invoice_index`, `atm_payment_index` and `ledger_outbox` with `env` in their keys, in one transaction, copying every
 * row (existing rows read as `"live"`, except that an invoice or payment index row of a test subject reads as `"test"`).
 * Does nothing on a current database, so call it at every start, with `HANDLER_DDL`. Take a copy first. See `UPGRADING.md`.
 */
export const migrateHandlerSchema = (db: SqlDatabase): HandlerMigrationResult =>
	migrateHandlerSchemaImpl(db);

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

// ---- Stored inputs: what the handler keeps to decide an event again ----

/**
 * The ULID a Stripe event's decision events name as their `cause`: `deterministicUlid` of the school, Stripe's event id and
 * its `created` (whole seconds). The reference handler passes it to `handleStripeEvent` as `eventId`; a caller that stores
 * inputs itself (`recordInput`) should too, so that the value is derivable.
 */
export const inputCauseId = (input: {
	school: string;
	eventId: string;
	stripeCreated: number;
}): string => storedInputs.inputCauseId(input);

/**
 * The mapping and normalization step of `handleStripeEvent` alone: the fact the rules will decide on (or why there is none),
 * which `recordInput` stores in its trimmed form. `eventId` becomes the fact's `source.eventId`. Pure.
 */
export const normalizeStripeEvent = (
	event: unknown,
	eventId: string,
): NormalizedStripeEvent => handle.normalizeStripeEvent(event, eventId);

/**
 * Stores one handled Stripe input in `atm_event_inputs` (see `HANDLER_DDL`): the trimmed fact, the SHA-256 of the raw body, the
 * fee, payment refs and booking refs the fact does not hold, and the menu and policy in force. The reference handler calls it
 * itself. The family service's endpoint calls it for what the handler never decides, a booking's `checkout.session.*` and the
 * refund of a booking's charge, after its rows and `appendToOutbox`, in its own write-serialized transaction. Runs in the
 * caller's transaction (opens none) and throws on a storage error, so that the transaction rolls back. Returns `"existing"`
 * and writes nothing when the event is already stored as applied. See `UPGRADING.md`, "Storing the inputs of a booking".
 */
export const recordInput = (
	db: SqlDatabase,
	args: RecordInputArgs,
): "stored" | "existing" => storedInputs.recordInput(db, args);

/** What a database holds of stored inputs; never throws on a database made before them (`{ available: false, reason: "no_table" }`). */
export const inputsStatus = (
	db: SqlDatabase,
	filter?: { env?: AtmEnv; school?: string },
): InputsStatus => storedInputs.inputsStatus(db, filter);

/** The stored inputs of one school and env as a replay reads them: applied and erased inputs in applied order, refusals, seeds and contexts. */
export const readInputs = (
	db: SqlDatabase,
	filter: { env: AtmEnv; school: string },
): InputsRead => storedInputs.readInputs(db, filter);

/** The handler's SQLite behind the `InputsSource` interface. */
export const sqliteInputsSource = (db: SqlDatabase): InputsSource =>
	storedInputs.sqliteInputsSource(db);

/**
 * The erasure hook: call it in the transaction that books `subject.erased` for a holder. Turns every stored input of the
 * holder into a tombstone (fact, subject key, refs, fee and raw hash cleared, `erased_at` set), deletes its seed and queues the
 * shipped objects that held its facts for a rewrite. Other holders' inputs and the ledger's money events stay. Idempotent.
 */
export const eraseStoredInputs = (
	db: SqlDatabase,
	args: { env: AtmEnv; school: string; subjectKey: string; nowMs: number },
): { inputs: number; seeds: number; queued: number } =>
	storedInputs.eraseStoredInputs(db, args);

// ---- Shipping the stored inputs ----

/**
 * The names of the shipped input objects, all under `schools/<school>/inputs/<env>/` (never inside `events/`): a batch
 * `date=<UTC day of the commit>/batch-<first applied order, 12 digits>-<16 hex>.jsonl`, a context `contexts/ctx-<hash>.json`, a
 * seed `seeds/seed-<16 hex of the holder's hash>.json`.
 */
export const inputObjectKey: {
	batch(args: {
		school: string;
		env: AtmEnv;
		date: string;
		firstOrder: number;
		sha256: string;
	}): string;
	context(args: { school: string; env: AtmEnv; contextHash: string }): string;
	seed(args: { school: string; env: AtmEnv; subjectKey: string }): string;
	prefix(args: { school: string; env: AtmEnv }): string;
} = shipInputsModule.inputObjectKey;

/**
 * The plan of a shipment of stored inputs: the rows as one batch per UTC commit day, each object's key and bytes a pure function
 * of its rows (canonical JSON lines in applied order; an erased row is a tombstone; the key holds the first order and a prefix of the
 * text's sha256). Throws on a refused row, a row of another school or env, or an event id that is not plain characters.
 */
export const planInputs = (args: {
	school: string;
	env: AtmEnv;
	rows: readonly StoredInput[];
}): InputsBatch[] => shipInputsModule.planInputs(args);

/**
 * The inputs shipper, for any `Store`: settles the erasure queue first (a shipped batch that held an erased holder's facts is
 * rewritten under a new key with the tombstone and the old object deleted; a shipped seed is deleted), puts the unshipped
 * contexts, seeds and input batches create-only (equal bytes already there is success, different bytes is a conflict, nothing
 * written), and marks the rows. Only committed rows ship, a refusal never does, an erased row ships as a tombstone. Safe to
 * rerun; a crash between put and mark is repaired by running it again. Run it before `shipOutbox`. It has not been run
 * against R2; see the README, "Shipping the stored inputs".
 */
export const shipInputs = (input: ShipInputsInput): Promise<ShipInputsResult> =>
	shipInputsModule.shipInputs(input);

/** The erasure step of `shipInputs` alone. `pending` rows are still queued: the old object may still hold the facts. */
export const settleInputErasures = (
	input: ShipInputsInput,
): Promise<SettleInputErasuresResult> =>
	shipInputsModule.settleInputErasures(input);

/** The unshipped inputs and the open erasure queue of a school and env, with the age of the oldest of each. Reads only. */
export const inputsShipStatus = (args: {
	db: SqlDatabase;
	school: string;
	env: AtmEnv;
	nowMs: () => number;
}): InputsShipStatus => shipInputsModule.inputsShipStatus(args);

/** A shipped copy in any `Store` behind the `InputsSource` interface: the same `InputsRead` as `sqliteInputsSource`. */
export const storeInputsSource = (store: Store): InputsSource =>
	shipInputsModule.storeInputsSource(store);

/** A shipped copy in a folder (a `FolderStore` over `root`) behind the `InputsSource` interface. */
export const folderInputsSource = (root: string): InputsSource =>
	shipInputsModule.folderInputsSource(root);

/** The `appliedOrder` ranges missing between the first and last input read (a refusal takes an order and is not shipped). */
export const inputOrderGaps = (
	read: Pick<InputsRead, "inputs" | "refused">,
): { from: number; to: number }[] => shipInputsModule.inputOrderGaps(read);

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

// ---- Bookable items and codes (0.8.0) ----

/**
 * Checks an unknown value as a bookable item's `billing` (`free`, `included`, `price`, `included_or_price`) against the
 * menu: the feature exists, credits are a whole number of 1 or more, the amount is a whole number of cents above 0, the
 * currency is the menu's and every tier id exists. Dotted paths of what fails, as `validateMenu`.
 */
export const validateBilling = (
	input: unknown,
	menu: Menu,
): BillingValidation => bookable.validateBilling(input, menu);

/**
 * What one booking costs this member: credits to hold and spend, a price to pay at Checkout, nothing, or a typed reason
 * (`not_a_member`, `membership_not_active`, `tier_not_included`, `insufficient_credits`, ...). Pure; it reads no balance
 * unless the caller passes `available`.
 */
export const quoteBooking = (input: QuoteInput): BookingQuote =>
	bookable.quoteBooking(input);

/**
 * Holds a booking's credits on an engine lock (`track` with a lock, rejecting, `commandOrg(policy)` on it): they leave
 * what the member can spend but are not spent yet. Returns one write for the subject and its ledger events, like
 * `handleStripeEvent`; write it in one transaction after checking `revision`. The same call twice is a replay: ok, nothing to write.
 * Makes `credit.held`, and `credit.low` or `credit.depleted` when the hold takes the balance to the policy's threshold or to zero.
 */
export const holdBooking = (input: HoldBookingInput): BookingResult =>
	bookable.holdBooking(input);

/** Spends what a booking holds (`finalize` at the lock's value): the session happened. Makes `credit.spent`. */
export const confirmBooking = (input: SettleBookingInput): BookingResult =>
	bookable.confirmBooking(input);

/** Gives back what a booking holds (`finalize` at 0): the credits return to the rows they came from. */
export const releaseBooking = (input: SettleBookingInput): BookingResult =>
	bookable.releaseBooking(input);

/**
 * A member's cancel: before `policy.cancelCutoffHours` ahead of the start the credits are released; after it,
 * `policy.lateCancel` decides (`spend` confirms, `release` releases). The result says which (`late`). A spend here and a no-show's are `credit.forfeited`.
 */
export const cancelBooking = (input: SettleBookingInput): BookingResult =>
	bookable.cancelBooking(input);

/** The session passed and the member did not come: `policy.noShow` (`spend` confirms, `release` releases). */
export const noShowBooking = (input: SettleBookingInput): BookingResult =>
	bookable.noShowBooking(input);

/** The holds whose expiry has passed with nobody settling them, soonest first: a cron's worklist for `settleExpiredHold`. */
export const expiredHolds = (input: {
	rows: readonly BillingRow[];
	now: number;
}): ExpiredHold[] => bookable.expiredHolds(input);

/** Applies an expired hold's own expiry action (`confirm` or `release`, fixed when it was held from `policy.noShow`). */
export const settleExpiredHold = (input: SettleBookingInput): BookingResult =>
	bookable.settleExpiredHold(input);

/**
 * A payment-mode Checkout Session for one paid booking: one inline price, `b4u_school`, `family_id` and `booking_id` in the
 * metadata of the session and its payment intent. `handleStripeEvent` answers its `checkout.session.completed` and the
 * refund of its charge with a `booking` outcome.
 */
export const bookingCheckoutParams = (
	input: BookingCheckoutInput,
): BookingCheckoutResult => bookingPay.bookingCheckoutParams(input);

/** A session gift certificate: a code that grants credits of a feature once, redeemed in atm with no Stripe. */
export const createSessionGiftCode = (
	input: CreateSessionGiftCodeInput,
): CreateSessionGiftCodeResult => codes.createSessionGiftCode(input);

/** Redeems a session gift code for a holder: one new grant of credits and the code's next state; once only, and not after `redeemBy`. */
export const redeemSessionGiftCode = (
	input: RedeemSessionGiftCodeInput,
): RedeemSessionGiftCodeResult => codes.redeemSessionGiftCode(input);

/** The Stripe steps for a dollar gift certificate: a fixed-amount coupon and a promotion code that works once and ends. */
export const dollarGiftOps = (input: DollarGiftInput): DollarGiftResult =>
	codes.dollarGiftOps(input);

// ---- Reading a school's folder, and the ledger's own helpers (0.9.0) ----

/**
 * A school's events under `<root>/schools/<school>/events`, sorted by id, a second event with an `idem` already seen
 * dropped (the first by id wins), with each file read (key, sha256 of its text, line count). A day with a `day.jsonl`
 * reads it and its `late-*` batches; otherwise its batches. Reads the folder only; the same call `atm journal` makes.
 */
export const readEvents = (
	root: string,
	school: string,
): Promise<{ events: AtmEvent[]; files: AtmEventFile[] }> =>
	readEventsImpl(root, school);

/**
 * `atm journal`: reads the school's events under `root`, writes the month's journal, `accounts.journal`, `main.journal`
 * and `ledger/build.json` under `<root>/schools/<school>`, and returns the build and the paths written. A file is
 * rewritten only when its bytes would change, so a second run writes nothing. Throws when the school has no events.
 */
export const journalMonth = (input: {
	root: string;
	school: string;
	month: string;
}): Promise<JournalRun> => journalMonthImpl(input);

/** The reports `reportMonth` can run: `income-statement`, `balance-sheet` and `credits`. */
export const REPORT_NAMES: readonly ReportName[] = REPORT_NAMES_IMPL;

/**
 * `atm report`: builds the month's journal (`journalMonth`), then runs hledger on the school's `main.journal` for the
 * chosen reports (default all three, as tables). The reports are to date over every month journaled so far, so journal
 * each earlier month first. Needs `hledger` on PATH; throws a `HledgerError` before writing anything when it is missing.
 */
export const reportMonth = (input: {
	root: string;
	school: string;
	month: string;
	report?: ReportChoice;
	format?: ReportFormat;
}): Promise<ReportRun> => reportMonthImpl(input);

/** Thrown by `reportMonth` when hledger is not installed, not on PATH, or fails. The message is one line. */
export const HledgerError: HledgerErrorConstructor = HledgerErrorImpl;
export type HledgerError = InstanceType<HledgerErrorConstructor>;

/**
 * The balance per holder and feature as the engine counts it at `asOfMs`: `avail` is the sum of the rows and rollovers
 * not yet past their expiry, `held` the units the open locks hold. Sorted by holder then feature. Pure. `catalog` is the
 * one `menuCatalogRows` makes. `replayEvents` returns the same list as `balances`.
 */
export const balancesOf = (input: {
	states: Record<string, AtmSubjectState>;
	holds: Record<string, AtmHold>;
	catalog: readonly AtmCatalogRow[];
	asOfMs: number;
}): AtmBalance[] =>
	balancesOfImpl({ ...input, catalog: toCatalog(input.catalog) });

/** JSON with every object's keys sorted and `undefined` fields dropped, so the same value is always the same bytes: what an event's line and its hash are made from. */
export const canonicalize = (value: unknown): string => canonicalizeImpl(value);

/** `YYYY-MM-DD` of an instant (ms) in an IANA time zone; DST comes from the zone's rules. How an event's `date` is set. */
export const localDate = (ms: number, tz: string): string =>
	localDateImpl(ms, tz);

/** A decimal string (a posting's amount) as a whole count of the smallest unit: `decimalToUnits("130.00", 2)` is `13000n`. Throws when the text is not a decimal or has more than `places` places. */
export const decimalToUnits = (text: string, places: number): bigint =>
	decimalToUnitsImpl(text, places);

/** DuckDB `CREATE TABLE` text for the events, made from the envelope's JSON Schema (`schema/`); throws on an unresolved `$ref`. */
export const duckdbDdl = (envelope: Record<string, unknown>): string =>
	duckdbDdlImpl(envelope);

/**
 * The one insert into `ledger_outbox`, for events the caller built itself (`ledgerEvent`: a payment, payout or plan
 * change that is not an engine command; `recordEngineCommand` and `recordLapse` call it for the rest). `env` is the Stripe
 * mode the events were decided in. An event whose `idem` the outbox already holds in that env is left as it was. Runs in the
 * caller's transaction (opens none); returns the rows inserted.
 */
export const appendToOutbox = (
	db: SqlDatabase,
	events: readonly AtmEvent[],
	env: AtmEnv,
): number => appendToOutboxImpl(db, events, env);

// ---- Signed receipts and sealed months ----

/**
 * The receipt of a `payment.succeeded` or `payment.refunded` event, made from the event alone (`null` for any other type):
 * school, family timeline, amount, currency, the Stripe object id, the cause and `event_hash`, the sha256 of the event's
 * canonical form. No name or email. Throws naming the field when a required payload field is missing. Pure.
 */
export const receiptOf = (event: AtmEvent): AtmReceipt | null =>
	receiptOfImpl(event);

/** Signs a receipt with an Ed25519 private key (PKCS#8 PEM): `sig` over `canonicalize(receipt)`, base64url. Throws for any other key type. */
export const signReceipt = (
	receipt: AtmReceipt,
	signer: AtmSigner,
): AtmSignedReceipt => signReceiptImpl(receipt, signer);

/** Checks an untrusted signed receipt: its shape (`schema/receipt.v1.json`), its key id in `keys`, its signature. Never throws. */
export const verifyReceipt = (
	signed: unknown,
	keys: AtmPublicKeys,
): ReceiptVerdict => verifyReceiptImpl(signed, keys);

/** Makes the receipt again from the books' event and compares the bytes: `missing_event`, `not_receipted` or `event_changed` when they differ. */
export const checkReceiptAgainstEvents = (
	signed: AtmSignedReceipt,
	events: readonly AtmEvent[],
): LedgerVerdict => checkReceiptAgainstEventsImpl(signed, events);

/**
 * The seal of a school's month at `sealedAt` (the caller's clock): the ids, count and hash of every month event in
 * `events`, chained to the school's previous signed seal. Membership is by id, not by `ingest_time`. Throws on a bad
 * month or instant, or two month events with one id. Pure.
 */
export const sealOf = (input: SealOfInput): AtmSeal => sealOfImpl(input);

/** Signs a seal as `signReceipt` signs a receipt. */
export const signSeal = (seal: AtmSeal, signer: AtmSigner): AtmSignedSeal =>
	signSealImpl(seal, signer);

/**
 * A school's seal chain (in the order made) against its events: a verdict per seal (`ok`, `malformed`, `bad_signature`,
 * `unknown_key`, `broken_link`, `events_changed`) and the month events their month's latest seal does not name (late
 * deliveries, or insertions). Never throws on a bad seal.
 */
export const verifySeals = (
	seals: readonly unknown[],
	events: readonly AtmEvent[],
	keys: AtmPublicKeys,
): SealReport => verifySealsImpl(seals, events, keys);

// ---- Scenario bundles and hash checkpoints ----

/**
 * The committed end-to-end scenario bundles (`fixtures/scenarios/<id>/`), plain data: each holds the school's menu, the
 * Stripe events in delivery order, Stripe's side for reconcile, the hand-written numbers and the golden hashes. Replay a
 * bundle's `steps` through your own handler, take the checkpoints below from what it wrote, and compare them with `hashes`.
 * `directory` defaults to the package's own `fixtures/scenarios`.
 */
export const loadScenarioBundles = (
	directory?: string,
): Promise<ScenarioBundle[]> => bundles.loadScenarioBundles(directory);

/** One bundle from its folder (the five files; a missing `hashes.json` reads as no goldens yet). */
export const loadScenarioBundle = (
	directory: string,
): Promise<ScenarioBundle> => bundles.loadScenarioBundle(directory);

/**
 * The checkpoint canonicalizers, one per stage: H1 deliveries, H2 mutations and decisions, H3 outbox, H4 ledger file tree,
 * H5 journal, H6 reports and H7 KPI doc (per channel), H8 reconcile verdict. Each returns the canonical text (keys sorted,
 * whole minor units, ISO UTC instants, volatile fields such as `shippedAt` and run ids left out) and its sha256. For tests,
 * CI and the export job only: never put one of these hashes in anything a viewer can read.
 */
export const canonicalDeliveries = (
	steps: readonly CheckpointStep[],
): Checkpoint => checkpoints.canonicalDeliveries(steps);

export const canonicalMutations = (
	perSchool: Readonly<Record<string, MutationCheckpointInput>>,
): Checkpoint => checkpoints.canonicalMutations(perSchool);

export const canonicalOutbox = (
	perSchool: Readonly<Record<string, readonly OutboxCheckpointRow[]>>,
): Checkpoint => checkpoints.canonicalOutbox(perSchool);

export const canonicalLedgerTree = (
	perSchool: Readonly<Record<string, FileTree>>,
): Checkpoint => checkpoints.canonicalLedgerTree(perSchool);

export const canonicalJournal = (
	perSchool: Readonly<Record<string, FileTree>>,
): Checkpoint => checkpoints.canonicalJournal(perSchool);

export const canonicalReports = (
	perChannel: Readonly<Record<string, ChannelReport>>,
): Record<string, Checkpoint> => checkpoints.canonicalReports(perChannel);

export const canonicalKpis = (
	perChannel: Readonly<Record<string, readonly CheckpointKpiRow[]>>,
): Record<string, Checkpoint> => checkpoints.canonicalKpis(perChannel);

export const canonicalReconcile = (
	perSchool: Readonly<
		Record<string, Readonly<Record<string, ReconcileVerdictInput>>>
	>,
): Checkpoint => checkpoints.canonicalReconcile(perSchool);
