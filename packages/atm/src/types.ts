/**
 * atm's public types: plain JSON shapes, with no import from the engine, zod or @autumn/shared, so the built
 * library's declarations stand alone. They describe what a caller sends and reads; the engine's own parsers
 * still validate every command at runtime. tests/types.test.ts fails if the engine's types stop fitting them.
 */

export type AtmCommandType =
	| "check"
	| "finalize"
	| "confirmExpiredLock"
	| "reset"
	| "recalculateBalance"
	| "track"
	| "updateBalance"
	| "deleteBalance";

/** The Stripe mode a subject belongs to; it is part of the subject key (`<school>|<env>|<customer>`). */
export type AtmEnv = "live" | "test";

export type AtmIdentity = {
	orgId: string;
	env: string;
	customerId: string;
	entityId: string | null;
};

/** Autumn's WorkerFullSubject: the customer (or entity) with its products, entitlements, pools, windows and open locks. */
export type AtmSubject = {
	identity: AtmIdentity;
	revision: number;
	customer: Record<string, unknown>;
	entity: Record<string, unknown> | null;
	customer_products: Record<string, unknown>[];
	extra_customer_entitlements: Record<string, unknown>[];
	pooled_customer_entitlements: Record<string, unknown>[];
	usage_windows: Record<string, unknown>[];
	open_locks: Record<string, unknown>[];
};

/** Fields every engine command carries; each type adds its own (see the engine's parsers). */
export type AtmCommand = {
	schemaVersion: 1;
	type: AtmCommandType;
	requestId: string;
	identity: AtmIdentity;
	occurredAt: number;
	/** Required on commands that change balances; duplicates are dropped on it. */
	commandId?: string;
	[field: string]: unknown;
};

export type AtmCheckResult = {
	allowed: boolean;
	reason: string | null;
	limitType: string | null;
	requiredBalance: number;
	fundingFeatureId: string | null;
	isFlag: boolean;
};

export type AtmRowChange = {
	table: string;
	op: string;
	[field: string]: unknown;
};

/** What a command that changes balances returns: row changes guarded by the subject's revision. */
export type AtmMutation = {
	schemaVersion: 1;
	type: "mutation";
	id: string;
	identity: AtmIdentity;
	revision: { before: number; after: number };
	changes: AtmRowChange[];
	[field: string]: unknown;
};

export type AtmResultFor<T extends AtmCommandType> = T extends "check"
	? AtmCheckResult
	: T extends "reset" | "updateBalance"
		? AtmMutation | null
		: T extends "recalculateBalance"
			? Record<string, unknown>
			: AtmMutation;

export type AtmResult = AtmResultFor<AtmCommandType>;

// ---------------------------------------------------------------------------------------------------------------
// Ledger: events, postings, replay and journals (the B4 Uni school ledger spec, "Event envelope").
// ---------------------------------------------------------------------------------------------------------------

export type AtmEventType =
	| "payment.succeeded"
	| "payment.refunded"
	| "payment.disputed"
	| "dispute.closed"
	| "payout.paid"
	| "plan.attached"
	| "plan.changed"
	| "plan.canceled"
	| "credit.granted"
	| "credit.held"
	| "credit.released"
	| "credit.spent"
	| "credit.refunded"
	| "credit.forfeited"
	| "credit.expired"
	| "credit.adjusted"
	| "credit.expiration_changed"
	| "credit.low"
	| "credit.depleted"
	| "fundraise.received"
	| "fundraise.paid_out"
	| "subject.erased"
	| "share.charged"
	| "referral.qualified"
	| "referral.rewarded"
	| "catalog.published"
	| "policy.published"
	/**
	 * B4 Uni's revenue share on a school's collected payments, in the school's books: `share.accrued` (a payment's share),
	 * `share.reversed` (the part of it a refund takes back) and `share.settled` (the school paid B4 Uni). A log that holds
	 * one is rejected by a reader built before they existed.
	 */
	| "share.accrued"
	| "share.reversed"
	| "share.settled"
	/** A Stripe money fact the books did not take (a payment, refund, payout or dispute in a currency other than USD): no postings, a count. */
	| "money.skipped";

/** One line of a transaction. `amount` is a decimal string (two places for USD, none for credits), never a float. */
export type AtmPosting = {
	account: string;
	amount: string;
	commodity: string;
};

/** The envelope every event in `schools/<id>/events/` has. A new optional field is not a new version; `v` is. */
export type AtmEvent = {
	v: 1;
	/** A ULID; the hledger transaction code. */
	id: string;
	school: string;
	source: string;
	event_type: AtmEventType;
	/** UTC instant, ISO 8601 with `Z`. */
	event_time: string;
	ingest_time: string;
	/** `event_time` in `tz`, set once at write. */
	date: string;
	tz: string;
	/** The timeline: the Autumn customer id, e.g. `family:fam_8k2`. */
	key: string;
	labels: Record<string, string>;
	/** Unique per school; a second event with the same `idem` is dropped. */
	idem: string;
	cause?: string;
	text: string;
	postings: AtmPosting[];
	/** Lossless. */
	payload: Record<string, unknown>;
	/** `payload` with personal fields removed; absent when there are none. */
	redacted?: Record<string, unknown>;
};

/** What `mutationToEvents` needs besides the mutation. Everything here is persisted in the events (labels, payload), so a replay can rebuild it. */
export type AtmEventContext = {
	school: string;
	/** IANA zone of the school when the event is written. */
	tz: string;
	/** The credit feature the mutation moves, e.g. `visit`; its commodity is `VISIT`. */
	feature: string;
	/** The plan (with version) that issues credits: `sparkle-2@v1`. Names `credits:issued:<plan>` and `labels.plan`. */
	plan?: string;
	/** The service a spend or its refund is booked to: `credits:spent:<service>`. */
	service?: string;
	/** An `updateBalance` that adds credit is `credit.refunded` (as `refunded`) or `credit.adjusted` (the default). */
	as?: "refunded" | "adjusted";
	/** Required on `credit.adjusted`. */
	reason?: string;
	/** Units the lock held, for `confirmExpiredLock`, whose mutation does not say. */
	held?: number;
	/** What a confirmed lock becomes: `spent` for a finalize (default), `forfeited` for an expired lock that confirmed (a no-show; default there). */
	settleAs?: "forfeited" | "spent";
	/** Who wrote it; default `family` (`cron` for resets and expiry). */
	source?: string;
	cause?: string;
	ingestTime?: string;
	/** Extra labels (`booking`, `service`, ...). */
	labels?: Record<string, string>;
	/** The state the mutation was computed against; resolves lapsed rollover rows and the balance a delete removes. */
	before?: AtmSubjectState | null;
	/** Extra payload fields kept beside the engine record. */
	payload?: Record<string, unknown>;
	/** Prefix of `idem` (default `engine`). */
	idemPrefix?: string;
	/**
	 * Turns on `credit.low` and `credit.depleted` for a `track` or `finalize` (a draw by the family); without it neither is
	 * made, and no other command makes them. Units of the feature at or under which a draw makes `credit.low`: the balance
	 * goes from above this to at most this (and above 0); 0 makes only `credit.depleted`. Written into `credit.low`'s
	 * payload, so a replay reads it back. Both events need `before`: without the state, the balance before is not known.
	 */
	lowCreditThreshold?: number;
	/**
	 * The changes that make up the feature's balance movement, when the caller cuts one mutation into several calls (a
	 * feature with credits from several plans): give the whole feature's changes to ONE call and `[]` to the others, so
	 * the low and depleted events judge the feature's total once. Default: the mutation's changes to the rows of the
	 * feature the command draws (its `internalFeatureId`).
	 */
	featureChanges?: AtmMutation["changes"];
	/**
	 * Positions in `mutation.changes` of the changes these events are made from, when the caller cuts one mutation into
	 * one call per feature and plan. The payload still records the whole mutation (a replay runs the whole command), and
	 * the positions are written beside it as `payload.slice`, so a replay derives the same events from the same cut.
	 * Default: all of them.
	 */
	slice?: number[];
};

/** Inputs of the events that are not engine mutations (payments, payouts, plan changes, ...). */
export type AtmLedgerEventInput = {
	type: AtmEventType;
	school: string;
	tz: string;
	/** UTC instant (ISO) or epoch ms. */
	eventTime: string | number;
	ingestTime?: string | number;
	source?: string;
	key: string;
	idem: string;
	cause?: string;
	labels?: Record<string, string>;
	/** Integer cents for USD events; whole units for credit events. */
	amount?: number;
	/** Stripe fee in cents, on `payment.succeeded`; on `payment.disputed`, Stripe's dispute fee (`expenses:billing:dispute-fees`). */
	fee?: number;
	/** Income account tail on `payment.succeeded`: `membership:sparkle-2` -> `income:billing:membership:sparkle-2`; a paid booking's is `booking`. */
	incomeKind?: string;
	campaign?: string;
	won?: boolean;
	payload?: Record<string, unknown>;
	redacted?: Record<string, unknown>;
	text?: string;
	revision?: number;
};

export type AtmCatalogRow = { table: string; row: Record<string, unknown> };

/** The engine's `SubjectState`: one subject's rows, revisioned by its mutation log. */
export type AtmSubjectState = {
	schemaVersion: 1;
	identity: AtmIdentity;
	revision: number;
	customer: Record<string, unknown>;
	customerProducts: Record<string, unknown>[];
	customerPrices: Record<string, unknown>[];
	customerEntitlements: Record<string, unknown>[];
	rollovers: Record<string, unknown>[];
	replaceables: Record<string, unknown>[];
	usageWindows: Record<string, unknown>[];
	openLocks: Record<string, unknown>[];
	pooledBalances: Record<string, unknown>[];
	customerLicenses: Record<string, unknown>[];
	entity: Record<string, unknown> | null;
	[field: string]: unknown;
};

export type AtmHold = { holder: string; feature: string; units: number };

/** Where a replay starts: the states and the units each open lock holds, as of `lastEventId`. */
export type AtmSnapshot = {
	states: Record<string, AtmSubjectState>;
	holds: Record<string, AtmHold>;
	lastEventId: string | null;
};

export type AtmBalance = {
	holder: string;
	feature: string;
	avail: number;
	held: number;
};

export type AtmReplayResult = {
	snapshot: AtmSnapshot;
	/** The balances at `asOf`, sorted by holder then feature. */
	balances: AtmBalance[];
	asOf: string | null;
	applied: number;
	lastEventId: string | null;
	/**
	 * Subjects whose last handler command in the log was written by atm 0.3.0, which did not log every command: a
	 * command it ran after the last one logged (the cycle-end update after a renewal) is not in the log, so their replayed
	 * rows may lack it. Absent when there are none.
	 */
	lossySubjects?: string[];
};

/** One row change of an engine mutation, shortened for a diff: the table, the op, the row's id, and the rest of the change as canonical JSON. */
export type AtmSimulateChange = {
	table: string;
	op: string;
	id: string | null;
	detail: string;
};

/** A command the candidate decides differently from the log: the changes only one side makes. */
export type AtmSimulateDecision = {
	key: string;
	commandId: string;
	/** The engine command's type (`track`, `reset`, ...). */
	command: string;
	/** The command's time (the first of its events). */
	at: string;
	/** The recorded events of this command. */
	eventIds: string[];
	/** Changes the log has and the candidate does not make. */
	removed: AtmSimulateChange[];
	/** Changes the candidate makes and the log does not have. */
	added: AtmSimulateChange[];
	/** The engine's answer to the command (`result`) is not the recorded one. */
	resultChanged: boolean;
};

/** A command the candidate's engine refused (it threw, decided nothing, or answered `rejected`); the replay went on from the state before it. */
export type AtmSimulateRefusal = {
	key: string;
	commandId: string;
	command: string;
	at: string;
	eventIds: string[];
	reason: string;
	/** The changes the log made that the candidate does not. */
	lost: AtmSimulateChange[];
};

export type AtmSimulateBalanceChange = {
	holder: string;
	feature: string;
	current: { avail: number; held: number };
	candidate: { avail: number; held: number };
};

/** A posting total (summed over the events of `month`, by the school's calendar) that is not the same on both sides. */
export type AtmSimulatePostingChange = {
	month: string;
	account: string;
	commodity: string;
	current: string;
	candidate: string;
};

export type AtmSimulateInput = {
	events: readonly AtmEvent[];
	/** The catalog rows the log was written under. Give these or `menu`. */
	catalog?: readonly AtmCatalogRow[];
	/** The menu the log was written under, instead of `catalog` (its rows come from `menuCatalogRows`). */
	menu?: Menu;
	/** The school id the menus' rows are made for; default the first event's. */
	school?: string;
	/**
	 * What to try. `catalog` or `menu` replaces the one the log ran under, `policy` sets the draw order
	 * (`deductionOrder`) of every command that carries an `org`. Nothing given is the identity: no difference.
	 */
	candidate: {
		catalog?: readonly AtmCatalogRow[];
		menu?: Menu;
		policy?: BillingPolicy;
	};
	/** Balances are counted at this instant on both sides; default the last event applied. */
	asOf?: string;
	/** `YYYY-MM`: report only the posting totals and the commands of this month (balances stay as of `asOf`). */
	month?: string;
};

export type AtmSimulation = {
	/** The candidate's events (every one the log has, as decided by the candidate); build its journal from these. Left out of the CLI's `--json`. */
	events: AtmEvent[];
	balances: { current: AtmBalance[]; candidate: AtmBalance[] };
	/** The holder and feature pairs whose balance differs, sorted. */
	balanceChanges: AtmSimulateBalanceChange[];
	/** Posting totals by month, account and commodity that differ, sorted. */
	postingChanges: AtmSimulatePostingChange[];
	/** Transactions (events with postings) per month on each side, as `buildJournal` counts them. */
	transactions: { month: string; current: number; candidate: number }[];
	/** Commands the candidate decides differently. */
	changed: AtmSimulateDecision[];
	/** Commands the candidate's engine refuses. */
	refused: AtmSimulateRefusal[];
	/** Events no engine command made (payments, refunds, payouts, disputes, the cron's expiries), carried over as they are: a replay cannot change what Stripe charged. */
	unaffected: { events: number; byType: Record<string, number> };
	/** The sum of the balance, posting, changed and refused entries; 0 means the candidate changes nothing the log can show. */
	differences: number;
	asOf: string | null;
	/** A few lines of text for a person. */
	summary: string;
};

export type AtmValidationError = { path: string; message: string };

export type AtmValidation =
	| { ok: true; errors: [] }
	| { ok: false; errors: AtmValidationError[] };

/** The text of every file `buildJournal` makes, keyed by path under the school's prefix. */
export type AtmJournalFiles = Record<string, string>;

export type AtmJournalBuild = {
	/** `ledger/b4u/YYYY-MM.journal`. */
	month: string;
	files: AtmJournalFiles;
	/** Transactions written (events with postings). */
	transactions: number;
	/** sha256 of the month's input event lines, in order. */
	inputsHash: string;
};

/**
 * One payment's line on a school's revenue-share statement. Amounts are whole cents (USD). `accrued` and `reversed` are
 * what was booked in the statement's month: a payment accrued in an earlier month and refunded in this one has `accrued`
 * 0, and `date`, `collected` and `percent` are those of its accrual (null when the log holds no accrual for it).
 */
export type ShareStatementRow = {
	/** The payment's id: an invoice id, or a booking's payment intent id. */
	paymentId: string;
	kind: "invoice" | "booking" | null;
	/** The payment's date in the school's time zone (`YYYY-MM-DD`); the first reversal's when there is no accrual. */
	date: string;
	collected: number | null;
	/** The rate in force when the payment was booked. */
	percent: number | null;
	accrued: number;
	reversed: number;
};

/** What a school owes B4 Uni for one month, from its events alone (`shareStatement`). */
export type ShareStatement = {
	school: string;
	/** `YYYY-MM`, by each event's date in the school's time zone. */
	month: string;
	rows: ShareStatementRow[];
	/** `share.settled` payments dated in the month. */
	settlements: { date: string; amount: number; reference: string | null }[];
	totals: {
		accrued: number;
		reversed: number;
		settled: number;
		/** `accrued - reversed - settled`, all in the month: what the month adds to what is owed. */
		owed: number;
	};
	/**
	 * What `liabilities:b4uni` holds at the end of the month, over every event dated up to it (also a `share.charged`):
	 * what the school owes B4 Uni in all, whichever month it accrued in. 0 when everything is paid.
	 */
	balanceOwed: number;
};

/** A grant or rollover row past its expiry that still holds a balance: the engine drops it by the clock, the cron books `credit.expired`. */
export type AtmLapsedRow = {
	table: "customerEntitlements" | "rollovers";
	id: string;
	balance: number;
	expires_at: number;
};

/*
 * ---- Billing ----
 * Shared types for atm's billing functions: the school's menu and policy, and the normalized Stripe facts that the
 * pure billing rules take as input. Plain JSON shapes. Money is in minor units (cents) of the menu's currency;
 * times are Unix milliseconds.
 *
 * Who produces what:
 * - normalize (raw Stripe payloads + the mapping files) -> BillingInvoice, BillingRefund, BillingDispute, SubscriptionFact
 * - invoiceToCommands etc. (facts + Menu + BillingPolicy + GrantsState) -> engine commands
 * - menuToStripe, checkoutParams (Menu) -> StripeOp[] and checkout params
 * - rows (storage rows) <-> engine subject and row changes
 */

export type Interval = "month" | "year";
export type AddonEvery = "once" | Interval;

/** Both forms of the word shown after a count: `{ one: "visit", other: "visits" }`. */
export type Unit = { one: string; other: string };
export type MenuFeature = { id: string; name: string; unit: Unit };
export type Rollover = { max?: number; months: number };
/** `amount` of one feature every month or year. */
export type MenuGrant = {
	featureId: string;
	amount: number;
	every: Interval;
	rollover?: Rollover;
};
export type TierPrice = { interval: Interval; amount: number };
export type MenuTier = {
	id: string;
	name: string;
	blurb: string;
	/** Shown on the public page and sold. A tier that is not public is a draft: neither shown nor sold. */
	public: boolean;
	/** Per unit when the tier has `quantities`: a buyer of quantity q pays q times each amount. */
	prices: TierPrice[];
	/** Per unit when the tier has `quantities`: quantity q grants q times each amount. */
	grants: MenuGrant[];
	/**
	 * The counts a buyer may pick (e.g. `[1, 2, 4]` sessions a month): 1 to 6 unique whole numbers from 1 to 50, in
	 * ascending order. Absent: sold one at a time (the same as `[1]`). Prices and lookup keys stay per unit, so changing
	 * the counts publishes nothing new to Stripe.
	 */
	quantities?: number[];
};
/** What a gift certificate holds: `sessions` (credits that lapse after `giftSessionMonths`) or `dollars` (a coupon the family service issues; no credits). */
export type GiftKind = "sessions" | "dollars";
export type MenuAddon = {
	id: string;
	name: string;
	price: { amount: number; every: AddonEvery };
	grants: MenuGrant[];
	/** Makes the add-on a gift certificate. Needs a one-time price; `sessions` needs grants, `dollars` has none. */
	gift?: GiftKind;
};

/** A school's menu (lowercase ISO currency, IANA time zone). Same shape as the family service's and the web's. */
export type Menu = {
	currency: string;
	timeZone: string;
	features: MenuFeature[];
	tiers: MenuTier[];
	addons: MenuAddon[];
	/** Discount codes for membership tiers (0.8.0). Absent: none beyond `policy.memberCode`. */
	codes?: MenuCode[];
};

/**
 * A member discount code: a percentage off membership tiers, never add-ons or gifts. `menuToStripe` makes a Stripe coupon
 * restricted to the tier products (the code's `tierIds`, else every public tier) and a promotion code for it.
 * `policy.memberCode` is the same thing for one code, kept so a 0.6.0 menu and policy still work; a menu code with the
 * same text as the policy's wins.
 */
export type MenuCode = {
	/** The menu's name for it; the Stripe coupon id is made from it. Lowercase letters, digits, `-` and `_`. */
	id: string;
	kind: "member";
	/** What the member types: letters, digits, `-` and `_`, 2 to 40 (Stripe compares it without case). */
	code: string;
	percentOff: number;
	/** Limit to these tiers; absent: every public tier. */
	tierIds?: string[];
	/** Works once per customer (Stripe `first_time_transaction`). Default true. */
	firstTimeOnly?: boolean;
	/** The code stops working at this time (ms); absent: no end. */
	expiresAt?: number;
};

/**
 * A school's billing choices. `DEFAULT_POLICY` in `policy.ts` holds the defaults from the tiers spec ("Default
 * billing rules"); a school's `catalog/policy.json` in R2 overrides only what it names.
 */
export type BillingPolicy = {
	v: 1;
	/** Sessions granted on a mid-cycle upgrade: the allowance difference × share of cycle left, rounded up; all of it; or none. */
	upgradeGrant: "prorated" | "full" | "none";
	/** On a full refund of a payment, remove that payment's unused credits. */
	removeOnFullRefund: boolean;
	/** On a lost dispute, remove that payment's unused credits. */
	removeOnLostDispute: boolean;
	/** A session gift certificate lasts this many months from purchase. */
	giftSessionMonths: number;
	/** Smallest dollar gift certificate, in cents. */
	giftDollarMinimum: number;
	/** A dollar gift certificate lasts this many months. */
	giftDollarMonths: number;
	/** The member discount code, or null for none. Applies to membership tiers only. */
	memberCode: { code: string; percentOff: number } | null;
	/**
	 * Which credit row a `track` draws from first when a holder has several for one feature. `expiry`: the row whose
	 * unused credits lapse soonest (a refilling row lapses at its next reset, a one-off row at its expiry), then the
	 * oldest grant; a row that never lapses goes last. `engine`: Autumn's own order (refilling rows first, shorter
	 * interval first, then soonest expiry, add-ons after the main plan, oldest first). Reaches the engine through
	 * `commandOrg(policy)`, which the caller puts on every `track` and `check` it runs.
	 */
	deductionOrder: "expiry" | "engine";
	/**
	 * A draw (a `track` or `finalize`) that takes a family's balance of a feature from above this many credits to this
	 * many or fewer (and not to zero) makes a `credit.low` event, for the family service's "N visits left" notice. The
	 * caller passes it as `lowCreditThreshold` in the context of its `track` and `finalize` events. Whole credits; 0 turns
	 * the event off. Reaching zero is always `credit.depleted`, whatever this is.
	 */
	lowCreditThreshold: number;
	/**
	 * A booking can be canceled with its credits back until this many hours before it starts; later is a late cancel
	 * (`lateCancel`). Whole hours, 0 to 720. A policy stored before 0.8.0 has none: that is the default.
	 */
	cancelCutoffHours: number;
	/** What a no-show costs the member: `spend` keeps the held credits spent, `release` gives them back. */
	noShow: "spend" | "release";
	/** What a cancel after the cutoff costs: `spend` keeps the held credits spent, `release` gives them back. */
	lateCancel: "spend" | "release";
	/**
	 * B4 Uni's revenue share, negotiated per school: a percentage (0 to 100, at most two decimals) of each payment the
	 * handler books, taken on the amount collected before Stripe's fee. `null` is no share (the default), and so is 0. A
	 * policy stored before 0.9.0 has none: read it with `?? null`. A change applies to payments booked after it; a share
	 * already accrued stays as it was. A policy must pass `resolvePolicy`, which refuses a rate outside 0 to 100 or with more
	 * than two decimals; a hand-built one with such a rate (or NaN) makes no share and never blocks a payment or its credits.
	 */
	revenueShare: { percent: number } | null;
};

/**
 * Where a fact came from: the stored input event (raw Stripe payload, lossless) and the mapping version that
 * read it. Decision events carry `eventId` as their `cause`, so replay can re-derive every decision from inputs.
 */
export type FactSource = {
	eventId: string;
	mapping: string;
	stripeApiVersion: string;
};

/** One line of a paid invoice, already matched to the menu by the price's lookup key. */
export type InvoiceLine = {
	kind: "tier" | "addon" | "unknown";
	/** The Stripe price's lookup key and id, kept so an unmatched line can be traced. */
	lookupKey?: string | null;
	priceId?: string | null;
	tierId?: string;
	addonId?: string;
	/** The gift kind, from the matched add-on (or the Stripe price's metadata, when a line shows it). */
	gift?: GiftKind | null;
	/** null for a one-time price. */
	interval: Interval | null;
	quantity: number;
	/** Stripe marks proration lines (an upgrade or downgrade mid-cycle). */
	proration: boolean;
	/** Minor units, before any discount: what the price times the quantity comes to. */
	amount: number;
	/**
	 * What discounts took off this line (the sum of its `discount_amounts`, minor units, 0 or more); absent on a fact built
	 * before 0.8.0 or by hand, which reads as 0. Credits follow the quantity and the line's `amount`, never this: a
	 * discounted invoice grants in full. What the member paid is `BillingInvoice.amountPaid`.
	 */
	discount?: number;
	/** The line's own period (ms), when Stripe gives one. */
	periodStart?: number;
	periodEnd?: number;
};

/**
 * What `prorationPair` reads of an invoice line: `InvoiceLine` fits it, and so does a line a caller built from the raw
 * Stripe invoice (`proration` from the line's parent, `amount` in minor units, `quantity` as Stripe has it, the period
 * in milliseconds, the unit of the `at` given to `raiseUnits`).
 */
export type ProrationLine = {
	/** Stripe marks the lines of a mid-cycle change (a proration). */
	proration: boolean;
	/** Minor units: negative for the credit of what was left, positive for the charge. */
	amount: number;
	quantity: number;
	/** The line's own period (ms), when Stripe gives one. */
	periodStart?: number;
	periodEnd?: number;
};

/** Stripe's proration pair for a raise of the quantity, as `prorationPair` reads it. */
export type ProrationPair = {
	/** The credit line's quantity: what Stripe had before. null when the invoice has no credit line. */
	oldQuantity: number | null;
	/** The charge line's quantity: the new total, not the difference. */
	newQuantity: number;
	/** The charge line's period start (ms): when the raise took effect. null when the line has none. */
	start: number | null;
	/** The charge line's period end (ms): the end of the cycle. null when the line has none. */
	end: number | null;
};

/** What `raiseUnits` needs: the units one unit of the quantity grants, the two counts, the time and the cycle. */
export type RaiseUnitsInput = {
	/** The units one unit of the quantity grants for the cycle (a yearly payment on a monthly grant: twelve times it). */
	perUnit: number;
	/** The quantity the credits reflect now; a raise counts from it, not from Stripe's credit line (see `prorationPair`). */
	oldQuantity: number;
	newQuantity: number;
	/** When the raise took effect (ms): the pair's `start`. */
	at: number;
	/** The cycle the raise falls in (ms). Either null grants the whole difference. */
	cycleStart: number | null;
	cycleEnd: number | null;
	policy: Pick<BillingPolicy, "upgradeGrant">;
};

/** A paid Stripe invoice, normalized. */
export type BillingInvoice = {
	source: FactSource;
	id: string;
	customerId: string;
	subscriptionId: string | null;
	reason:
		| "subscription_create"
		| "subscription_cycle"
		| "subscription_update"
		| "manual"
		| "other";
	currency: string;
	amountPaid: number;
	/** What discounts took off the invoice in all (minor units); absent reads as 0. `amountPaid` is after it. */
	discount?: number;
	paidAt: number;
	periodStart: number;
	periodEnd: number;
	lines: InvoiceLine[];
	/**
	 * The invoice's number as the school's Stripe account prints it (`EGXTP8OW-0001`): null until Stripe numbers it, absent on a
	 * fact built by hand. For a receipt link, with `hostedInvoiceUrl` and `invoicePdf`.
	 */
	number?: string | null;
	/**
	 * Stripe's hosted invoice page. A bearer link: anyone who holds it can open the invoice, which shows the customer's name,
	 * so hand it only to the family it belongs to and keep it out of logs. Null when Stripe has none, absent on a fact built by hand.
	 */
	hostedInvoiceUrl?: string | null;
	/** Stripe's invoice PDF (a bearer link, as `hostedInvoiceUrl`). Null when Stripe has none, absent on a fact built by hand. */
	invoicePdf?: string | null;
	/**
	 * Our metadata from checkout (`b4u_school`, `family_id`, `tier_id`, `profile_id`, `menu_version`, …). Checkout's
	 * `subscription_data.metadata` sits on the invoice at `parent.subscription_details.metadata`; it is merged with the
	 * invoice's own `metadata`, the invoice's own keys winning.
	 */
	metadata: Record<string, string>;
};

export type BillingRefund = {
	source: FactSource;
	/**
	 * Identifies the refund EVENT: the Stripe event id (`evt_…`). A real `charge.refunded` event carries the charge, not
	 * the refund object (`re_…`), so there is no refund id to read. Nothing reads it for logic: it only labels the fact.
	 */
	id: string;
	/**
	 * The invoice the refunded charge paid. Stripe's charge (API 2025-10-29.clover) does not name it: the mapping gives
	 * the payment intent, and `handleStripeEvent` fills this from the caller's `invoiceIds`.
	 */
	invoiceId?: string | null;
	paymentIntentId?: string | null;
	chargeId: string;
	/**
	 * The charge's total refunded amount after this event (`amount_refunded`), not this one refund's amount: the charge
	 * has no refund list. The rules use only `full`.
	 */
	amount: number;
	/**
	 * What `amount` was before this event (`previous_attributes.amount_refunded`); 0 when the event carries none, as for a
	 * first refund. `amount - previousAmount` is what this event refunded, which is what the books take.
	 */
	previousAmount?: number;
	/** The charge's currency (lowercase ISO code). Absent on a fact built by hand; the books take it as USD then. */
	currency?: string;
	/**
	 * The booking the charge paid, from the charge's own `metadata.booking_id` (`bookingCheckoutParams` puts it on the payment
	 * intent, which Stripe copies to the charge). Absent when the charge carries none, as for an invoice's.
	 */
	bookingId?: string;
	/**
	 * The charge is refunded in full: Stripe's own `refunded` flag. Not a comparison of amounts: on a partly captured
	 * charge `amount_refunded` may or may not count the released remainder, and the flag is right either way.
	 */
	full: boolean;
	at: number;
};
export type BillingDispute = {
	source: FactSource;
	id: string;
	/** As on `BillingRefund`: filled from the caller's `invoiceIds` by the payment intent. */
	invoiceId?: string | null;
	paymentIntentId?: string | null;
	chargeId: string;
	status: "open" | "won" | "lost";
	at: number;
	/** The dispute's amount in minor units (`data.object.amount`). Absent when the event has none. */
	amount?: number;
	/** The dispute's currency, as Stripe sends it (lowercase). */
	currency?: string;
	/** When the dispute was opened (`data.object.created`), in ms: the instant its money lines are dated. */
	openedAt?: number;
	/**
	 * What Stripe withdrew for the dispute, from the first of the dispute's own `balance_transactions`: its `amount`
	 * (negative) and its `fee` (the dispute fee, 1500 cents in the recorded events). Both absent when the list is empty,
	 * as for an inquiry (`warning_*`), which moves no money.
	 */
	withdrawn?: number;
	fee?: number;
	/**
	 * When that withdrawal was made (its balance transaction's `created`), in ms. It can be a second after the dispute's own
	 * `created` and, for an inquiry that became a chargeback, weeks after: it is the instant Stripe's balance fell, so the
	 * opening line is dated by it and `reconcile`'s balance-transaction check puts it in the same month.
	 */
	withdrawnAt?: number;
	/** A `charge.dispute.closed` only: the `created` of the second balance transaction, the reversal of a won dispute, in ms. */
	reversedAt?: number;
};

/**
 * A Stripe Checkout Session event (`checkout.session.completed`, `.async_payment_succeeded`, `.expired`), normalized. Only a
 * payment-mode session made by `bookingCheckoutParams` (its `metadata.booking_id`) is decided on; the handler ignores the rest.
 */
export type CheckoutSessionFact = {
	source: FactSource;
	/** Identifies the EVENT (`evt_…`), as on `BillingRefund`. */
	id: string;
	/** The session's own id (`cs_…`). */
	sessionId: string;
	/** `other` is a mode this version of atm does not know. */
	mode: "payment" | "subscription" | "setup" | "other";
	/** `complete` once the customer has finished, `expired` when the session lapsed unpaid. */
	status: "open" | "complete" | "expired";
	/** `paid` only when the money is in: a delayed payment method completes a session as `unpaid` first. */
	paymentStatus: "paid" | "unpaid" | "no_payment_required" | "other";
	/** The payment intent a payment-mode session made; null before it is paid or for a subscription. */
	paymentIntentId: string | null;
	/** What the session charged in all (minor units); null when Stripe sends none. */
	amountTotal: number | null;
	/** Lowercase ISO code; null when Stripe sends none. */
	currency: string | null;
	/** The session's own metadata (`b4u_school`, `family_id`, `booking_id`, `b4u_kind`, ...). */
	metadata: Record<string, string>;
	at: number;
};

/**
 * What an `invoice_payment.paid` event says: this invoice was paid by this payment intent (or, for a payment that has
 * no intent, this charge). It is the only place API 2025-10-29.clover links a payment to its invoice, since neither the
 * charge nor the webhook's invoice names the other. Not a billing rule's input: the webhook handler records the link
 * so a later refund or dispute finds its invoice.
 */
export type InvoicePaymentFact = {
	source: FactSource;
	/** Identifies the EVENT (`evt_…`), as on `BillingRefund`; the invoice payment's own id (`inpay_…`) is not kept. */
	id: string;
	invoiceId: string;
	/** Set when the payment's `type` is `payment_intent`. */
	paymentIntentId: string | null;
	/** Set when the payment's `type` is `charge` (a charge that has no payment intent); else null. */
	chargeId: string | null;
	at: number;
};

/**
 * A Stripe `payout.paid`: money left the Stripe balance for the school's bank. Not about any family, so it has no
 * subject; the books move it from `assets:stripe` to `assets:clearing:stripe-payouts`.
 */
export type StripePayout = {
	source: FactSource;
	/** The payout's id (`po_...`): the books' idem, so another delivery of the same payout books nothing. */
	id: string;
	/** What reaches the bank, in minor units: the payout's own `amount`, already net of Stripe's fees. */
	amount: number;
	currency: string;
	/** The event's `created` (ms). */
	at: number;
};

/**
 * One item of a subscription: the tier's price or a recurring add-on's. The menu names what it is, by the price's
 * lookup key, else by its id (`resolveSubscriptionPlan`): the subscription's metadata is written once at checkout and
 * goes stale when the plan changes in the billing portal.
 */
export type SubscriptionItem = {
	priceId: string;
	lookupKey: string | null;
	interval: Interval | null;
	/** Stripe's item quantity, a whole number from 0 (a paused item) up: the truth for how many units are paid for. */
	quantity: number;
};

/** A subscription's state after a `customer.subscription.*` event. */
export type SubscriptionFact = {
	source: FactSource;
	id: string;
	customerId: string;
	status:
		| "active"
		| "trialing"
		| "past_due"
		| "unpaid"
		| "incomplete"
		| "incomplete_expired"
		| "canceled"
		| "paused";
	items: SubscriptionItem[];
	currentPeriodStart: number;
	currentPeriodEnd: number;
	cancelAtPeriodEnd: boolean;
	at: number;
	metadata: Record<string, string>;
};

/** One step to make Stripe match a menu. Idempotent: `lookupKey` names a price for life; `idempotencyKey` goes in the header. */
export type StripeOp =
	| {
			op: "product.create";
			key: string;
			name: string;
			description?: string;
			metadata: Record<string, string>;
			idempotencyKey: string;
	  }
	| {
			op: "product.update";
			key: string;
			name: string;
			description?: string;
			active: boolean;
			idempotencyKey: string;
	  }
	| {
			op: "price.create";
			productKey: string;
			lookupKey: string;
			currency: string;
			unitAmount: number;
			recurring: { interval: Interval } | null;
			metadata: Record<string, string>;
			idempotencyKey: string;
	  }
	| { op: "price.archive"; lookupKey: string; idempotencyKey: string }
	| {
			op: "coupon.ensure";
			id: string;
			percentOff: number;
			appliesToProductKeys: string[];
			idempotencyKey: string;
	  }
	| { op: "coupon.archive"; id: string; idempotencyKey: string }
	/**
	 * `firstTimeOnly`: the code works once per customer (Stripe `restrictions[first_time_transaction]`). `expiresAt` (ms; the
	 * caller divides by 1000 for Stripe's `expires_at`): the code stops working then. Only a menu code that has one makes it;
	 * Stripe cannot change it afterwards, so a changed expiry is a deactivate and a new ensure.
	 */
	| {
			op: "promotion_code.ensure";
			code: string;
			couponId: string;
			firstTimeOnly: boolean;
			expiresAt?: number;
			idempotencyKey: string;
	  }
	| { op: "promotion_code.deactivate"; code: string; idempotencyKey: string };

// ---- Menu validation ----

export type MenuValidation =
	| { ok: true; menu: Menu }
	/**
	 * `problems` are dotted paths. `messages`, when present, say in a sentence what a path alone does not: today a feature id
	 * with no letter, or two feature ids that become one credit commodity (`features.<n>.id`, naming both ids).
	 */
	| { ok: false; problems: string[]; messages?: string[] };

// ---- Grants ----

export type GrantCommand = {
	type: string;
	commandId: string;
	requestId: string;
	occurredAt: number;
} & Record<string, unknown>;

/** What a decision event is labelled with, so a reader can tell which menu, policy and mapping decided. */
export type GrantLabels = {
	menu_version: string;
	policy_version: string;
	mapping: string;
};

/**
 * What one invoice put into one credit row. `epoch` says which refill of the row it went into. `rolloverExpiresAt`
 * is when the engine's rollover of that refill's leftovers lapses (null: the row has no rollover), so a later reset's
 * carried-over leftovers can be found again and traced to this invoice.
 */
export type GrantedRow = {
	invoiceId: string;
	rowId: string;
	feature: string;
	units: number;
	epoch: number;
	rolloverExpiresAt: number | null;
};

export type InvoiceRecord = {
	paidAt: number;
	granted: GrantedRow[];
	/** A refund or a lost dispute has already taken this invoice's unused credits back. */
	removed: boolean;
	/**
	 * The cents the books took for this invoice (its `payment.succeeded`). Absent when none was booked: an invoice handled
	 * before payments were booked, one that paid nothing or paid in another currency (its `money.skipped` marker is not a
	 * payment), or one a caller adopted. A refund of such an invoice makes no `payment.refunded`: there is no payment for
	 * it to take back from.
	 */
	paid?: number;
	/**
	 * The revenue share accrued on this payment (`share.accrued`) and the part of it a refund has taken back
	 * (`share.reversed`), in cents. Absent when no share was accrued (the school had no rate when the payment was booked,
	 * the share was 0, or the payment is not in USD), so a state with no share is written as before; a refund of such a
	 * payment reverses nothing. The rate in force at payment is not kept here: the event's payload has it.
	 */
	share?: { accrued: number; reversed: number };
	/**
	 * Units of this invoice that an open booking held when a refund or a lost dispute removed it, by credit row id: they were
	 * not in the balance, so the removal could not take them back. The release that frees them takes them back instead (a
	 * `credit.adjusted`); a confirm spends them (they were used) and clears them. Absent when nothing was held, so a state that
	 * never booked is written as before.
	 */
	owed?: Record<string, number>;
};

/** Everything the rules need to remember between facts. Plain JSON: store it as is. */
export type GrantsState = {
	v: 1;
	/** Set when the engine subject was created (the first grant). */
	identity: { orgId: string; customerId: string } | null;
	/** Whose credits these are, from the first invoice of any kind (a dollar gift creates no engine subject but has a holder). */
	holder: { orgId: string; customerId: string } | null;
	subscriptionId: string | null;
	tierId: string | null;
	interval: Interval | null;
	/** Period start of the first paid invoice: the subscription's billing anchor. */
	anchor: number | null;
	/** The paid cycle now running (period start and end, ms). */
	cycleStart: number | null;
	cycleEnd: number | null;
	/**
	 * How many units of the tier the credits reflect (the tier's grants are per unit). It moves only with paid invoices
	 * (the create, a renewal's tier line, a raise mid-cycle), never with a subscription event. A state stored before it
	 * existed loads with 1.
	 */
	quantity: number;
	/** Recurring add-ons now on the subscription. */
	addonIds: string[];
	/** When the subscription ended (ms), or null while it runs. Its credit rows then lapse on their own and nothing refills. */
	endedAt: number | null;
	/** Credit rows of the tier and recurring add-ons, with how many times each has been refilled. */
	rows: Record<string, number>;
	/**
	 * Credit rows the plan has moved off (a downgrade to a tier without that feature) with their refill count: they
	 * stopped refilling and keep what is left. A later move back onto the feature revives the same row.
	 */
	retired: Record<string, number>;
	/**
	 * What Stripe says the membership is, from the latest `customer.subscription.*` event. It never grants credits:
	 * `tierId` and `interval` above move with paid invoices, so a plan change Stripe has made but no invoice has paid
	 * yet shows here as a different `membership.tierId`. Null until a subscription event is seen.
	 */
	membership: MembershipRecord | null;
	/** Every invoice seen, by id: a replayed invoice finds its record and decides nothing. */
	invoices: Record<string, InvoiceRecord>;
	/**
	 * Bookings this holder has held, spent, released or paid for, by the caller's booking id (0.8.0). Absent until the first
	 * one: a state stored by 0.6.0 or 0.7.x has none, and a rule that does not touch bookings leaves the key as it found it,
	 * so reading and writing a state never adds it (the handler compares states to decide whether a row changed).
	 */
	bookings?: Record<string, BookingRecord>;
	/** Gift codes this holder has redeemed, by code id (0.8.0). Absent until the first, as `bookings`. */
	redeemed?: Record<string, RedeemedCode>;
};

/** A subscription as the membership shows it (`subscriptionStatus`), with the plan the menu names for its price. */
export type MembershipRecord = {
	subscriptionId: string;
	status: MembershipStatus;
	/** The tier the subscription's price is on the menu, or null when no item is a menu tier. */
	tierId: string | null;
	interval: Interval | null;
	/** The tier item's quantity Stripe says (1 when no item is a tier). Grants nothing: credits follow paid invoices. */
	quantity: number;
	renewsAt: number | null;
	cancelAtPeriodEnd: boolean;
	endsAt: number | null;
	/** The time of the subscription event this came from (ms): an older event arriving late changes nothing. */
	at: number;
};

export type GrantResult = {
	commands: GrantCommand[];
	labels: GrantLabels;
	state: GrantsState;
};

/** The menu and policy versions a decision is labelled with. */
export type GrantVersions = {
	menuVersion: string | number;
	policyVersion: string | number;
};

export type InvoiceGrantInput = {
	invoice: BillingInvoice;
	menu: Menu;
	policy: BillingPolicy;
	state: GrantsState;
	/** The time of the event being handled, not the clock. */
	now: number;
	/**
	 * Stripe's mode for this subject, part of its subject key. Default `"live"`; a school with both a test and a live
	 * endpoint passes it so the two do not share a subject. Anything else throws.
	 */
	env?: AtmEnv;
} & GrantVersions;

/**
 * `subject` is the engine subject as it stands (`subjectFromRows`), or null when it has no rows: the rules read each
 * credit row's balance, reset date and rollovers from it, so a removal never takes more than a row holds.
 */
export type GrantRemovalInput = {
	menu?: Menu;
	policy: BillingPolicy;
	state: GrantsState;
	subject: AtmSubject | null;
	now: number;
	/**
	 * Stripe's mode for this subject, part of its subject key. Default `"live"`; a school with both a test and a live
	 * endpoint passes it so the two do not share a subject. Anything else throws.
	 */
	env?: AtmEnv;
} & GrantVersions;

export type SubscriptionEndInput = {
	/** A `canceled` subscription fact (`customer.subscription.deleted`). Any other status gives no commands. */
	subscription: SubscriptionFact;
	/** The tier and interval the menu names for the subscription's items (`resolveSubscriptionPlan`); null when none is a tier. */
	plan?: {
		tierId: string;
		interval: Interval | null;
		/** The tier item's quantity; default 1. */
		quantity?: number;
	} | null;
	menu: Menu;
	policy: BillingPolicy;
	state: GrantsState;
	subject: AtmSubject | null;
	now: number;
	/**
	 * Stripe's mode for this subject, part of its subject key. Default `"live"`; a school with both a test and a live
	 * endpoint passes it so the two do not share a subject. Anything else throws.
	 */
	env?: AtmEnv;
} & GrantVersions;

// ---- Stripe menu and checkout ----

export type MenuToStripeInput = {
	schoolId: string;
	menu: Menu;
	/** The menu last published to this Stripe account, or null for the first publish. */
	previous: Menu | null;
	policy: BillingPolicy;
	/** The policy `previous` was published under. Defaults to `policy`. */
	previousPolicy?: BillingPolicy | null;
};

export type CheckoutInput = {
	schoolId: string;
	menu: Menu;
	tierId: string;
	interval: Interval;
	addonIds?: readonly string[];
	/** A child profile the membership is for; omit for the buyer's own. */
	forProfileId?: string | null;
	familyId: string;
	menuVersion: number | string;
	returnUrls: { success: string; cancel: string };
	policy: BillingPolicy;
	/** How many of the tier (e.g. sessions a month): one of the tier's `quantities`, or 1 for a tier without them. Default 1. */
	quantity?: number;
	/**
	 * A member code to apply now (a `MenuCode.code` or `policy.memberCode.code`, compared without case). Sets `discounts` in the
	 * params and not `allow_promotion_codes` (Stripe refuses both). Absent: the buyer may type a code at checkout
	 * (`allow_promotion_codes`) when the school has any.
	 */
	code?: string;
};

/**
 * A Checkout Session's parameters (nested, Stripe's shape); `line_items` name prices by lookup key until `withPriceIds`.
 * The first line is the tier, at the quantity bought; each add-on line after it is one.
 */
export type CheckoutParams = {
	mode: "subscription";
	client_reference_id: string;
	success_url: string;
	cancel_url: string;
	line_items: [
		{ lookupKey: string; quantity: number },
		...{ lookupKey: string; quantity: 1 }[],
	];
	metadata: Record<string, string>;
	subscription_data: { metadata: Record<string, string> };
	allow_promotion_codes?: true;
	/** Set when `CheckoutInput.code` names a member code: the promotion code by its text until `withPriceIds` (its third argument) swaps in Stripe's id. */
	discounts?: [{ promotionCode: string }];
};

/** Why a checkout was refused. `quantity_not_offered`: `quantity` is not one of the tier's `quantities` (not 1, for a tier without them). */
export type CheckoutRefusal =
	| { ok: false; reason: "tier_not_found" }
	| { ok: false; reason: "addon_not_found"; addonId: string }
	| { ok: false; reason: "addon_interval_mismatch"; addonId: string }
	| { ok: false; reason: "quantity_not_offered"; quantity: number }
	| { ok: false; reason: "code_not_found"; code: string }
	| { ok: false; reason: "code_not_applicable"; code: string };

export type CheckoutResult =
	| { ok: true; params: CheckoutParams }
	| CheckoutRefusal;

export type CheckoutParamsWithPrices = Omit<
	CheckoutParams,
	"line_items" | "discounts"
> & {
	line_items: [
		{ price: string; quantity: number },
		...{ price: string; quantity: 1 }[],
	];
	/** Stripe's shape: the promotion code's id (`promo_...`), swapped in by `withPriceIds` for the text `CheckoutParams.discounts` carries. */
	discounts?: [{ promotion_code: string }];
};

/**
 * A one-time purchase (a gift certificate, a pack) with no membership. `addonIds` are add-ons priced `once`, one each.
 * `invoice` is optional text for the paid invoice Stripe makes.
 */
export type OneTimeCheckoutInput = {
	schoolId: string;
	menu: Menu;
	addonIds: readonly string[];
	/** A child profile the purchase is for; omit for the buyer's own. */
	forProfileId?: string | null;
	familyId: string;
	menuVersion: number | string;
	returnUrls: { success: string; cancel: string };
	invoice?: { description?: string; footer?: string };
};

/**
 * A payment-mode Checkout Session's parameters (nested, Stripe's shape); `line_items` name prices by lookup key until
 * `withPriceIds`. `invoice_creation` is always on: Stripe makes no invoice for a payment-mode session otherwise, and atm
 * grants credits only from a paid invoice. The invoice carries our metadata, which is how atm finds the family.
 */
export type OneTimeCheckoutParams = {
	mode: "payment";
	client_reference_id: string;
	success_url: string;
	cancel_url: string;
	line_items: { lookupKey: string; quantity: 1 }[];
	metadata: Record<string, string>;
	invoice_creation: {
		enabled: true;
		invoice_data: {
			metadata: Record<string, string>;
			description?: string;
			footer?: string;
		};
	};
};

/** Why a one-time checkout was refused: no add-on named, an add-on not on the menu, or one that is not priced `once`. */
export type OneTimeCheckoutRefusal =
	| { ok: false; reason: "no_addons" }
	| { ok: false; reason: "addon_not_found"; addonId: string }
	| { ok: false; reason: "addon_not_one_time"; addonId: string };

export type OneTimeCheckoutResult =
	| { ok: true; params: OneTimeCheckoutParams }
	| OneTimeCheckoutRefusal;

export type OneTimeCheckoutParamsWithPrices = Omit<
	OneTimeCheckoutParams,
	"line_items"
> & {
	line_items: { price: string; quantity: 1 }[];
};

/**
 * The Stripe ids a portal configuration names, by the menu's own keys: `products["t:<tierId>"]` and
 * `prices["t:<tierId>:<interval>"]` (the product step's `key` and `tierPriceKey`; a price step carries that key only as its `metadata.b4u_key`, and names its product by `productKey`).
 */
export type PortalConfigIds = {
	products: Readonly<Record<string, string>>;
	prices: Readonly<Record<string, string>>;
};

// ---- Bookable items: what a booking or an event costs (0.8.0) ----

/**
 * What a bookable item (a booking type, an event with sign-ups) costs the person who books it. The item is the caller's
 * (atm has no bookings); this is its price tag. `included`: a session of the membership, `credits` of `featureId`.
 * `price`: money, paid at Checkout. `included_or_price`: credits when the member has them (and, when `tierIds` is set,
 * holds one of those tiers), else the price. `tierIds` limits which tiers the credits count for: absent, any holder of
 * the feature.
 */
export type Billing =
	| { kind: "free" }
	| { kind: "included"; featureId: string; credits: number; tierIds?: string[] }
	| { kind: "price"; amount: number; currency: string }
	| {
			kind: "included_or_price";
			featureId: string;
			credits: number;
			tierIds?: string[];
			amount: number;
			currency: string;
	  };

/** `problems` are dotted paths into the billing (`credits`, `featureId`, `tierIds.1`, `amount`, `currency`), as `MenuValidation`'s are into a menu; `messages` say what a path alone does not. */
export type BillingValidation =
	| { ok: true; billing: Billing }
	| { ok: false; problems: string[]; messages?: string[] };

/** What one booking costs once the rules have looked at the member: nothing, credits to hold and spend, or money to pay. */
export type BookingCost =
	| { kind: "free" }
	| { kind: "credits"; featureId: string; credits: number }
	| { kind: "price"; amount: number; currency: string };

/**
 * Why a booking rule said no. Typed: the caller maps each to its own answer and text.
 * - `invalid_billing`: the item's billing fails `validateBilling` against the menu.
 * - `bad_input`: a count, time or id the rule cannot use (a hold that ends before it starts, a non-whole `credits`).
 * - `not_a_member`: the holder has no credits of the feature (no subject) and the item is only for members.
 * - `membership_not_active`: the membership is past due, ended or not paid yet (`MembershipStatus` other than `active`).
 * - `tier_not_included`: the holder's tier is not in the item's `tierIds`.
 * - `feature_not_in_plan`: the holder's plan has no credits of the item's feature.
 * - `insufficient_credits`: fewer spendable credits than the item costs (the engine's own check refused the hold).
 * - `currency_mismatch`: the item is priced in another currency than the menu's.
 * - `booking_conflict`: the booking id is known and this call differs from what it held or paid (a replay of the same call is not an error).
 * - `no_hold`: nothing is held for this booking id.
 * - `already_settled`: the booking was already spent, released or paid and this call would undo that.
 * - `hold_expired`: the hold's expiry has passed and this call would do the opposite of its expiry action (a release or a free cancel of a `confirm` hold, a spend of a `release` hold): use `settleExpiredHold`. A call that does what the expiry action does still works.
 * - `not_credits`: the call is for credits and the booking's cost is free or a price.
 * - `session_started`: a cancel at or after the session's `startsAt`: the session is not cancelled once it has started; settle it with `noShowBooking` (or `confirmBooking`).
 */
export type BookingRefusalReason =
	| "invalid_billing"
	| "bad_input"
	| "not_a_member"
	| "membership_not_active"
	| "tier_not_included"
	| "feature_not_in_plan"
	| "insufficient_credits"
	| "currency_mismatch"
	| "booking_conflict"
	| "no_hold"
	| "already_settled"
	| "hold_expired"
	| "not_credits"
	| "session_started";

export type BookingRefusal = {
	ok: false;
	reason: BookingRefusalReason;
	message: string;
};

export type QuoteInput = {
	billing: Billing;
	menu: Menu;
	policy: BillingPolicy;
	/** The holder's grants state (`grantsFromRows`): its tier, its membership status, the credit rows it holds. */
	grants: GrantsState;
	/** Overrides `grants.tierId` (a caller that already resolved the tier). */
	tierId?: string | null;
	/**
	 * The units of `featureId` the holder can spend now (`balancesOf`'s `avail`, which leaves out what is held); null or absent
	 * when the caller has not read it. With it, an `included` item the holder cannot afford is `insufficient_credits` and an
	 * `included_or_price` one is quoted at its price; without it the quote trusts the plan and the hold's own check decides.
	 */
	available?: number | null;
	/** The time of the call (ms), not the clock. */
	now: number;
};

export type BookingQuote =
	| {
			ok: true;
			cost: BookingCost;
			/** `included_or_price` only: which half applied. */
			via?: "included" | "price";
	  }
	| BookingRefusal;

/** An open lock row as the engine makes it (`locks` insert of a track); kept so a finalize can settle it. */
export type HoldLock = Record<string, unknown>;

/**
 * One booking's place in the holder's grants state, by the caller's booking id.
 * - `held`: credits are held on `lock` (open lock row) until `expiresAt`; nothing is spent yet.
 * - `spent`: settled by a confirm, a no-show or late cancel that spends, or an expired hold that confirms.
 * - `released`: settled with the credits given back.
 * - `paid`: a one-time payment for the booking was made (`payment`).
 * - `refunded`: that payment was refunded in full.
 */
export type BookingState = "held" | "spent" | "released" | "paid" | "refunded";

export type BookingRecord = {
	state: BookingState;
	cost: BookingCost;
	/** When the session starts (ms); the cancel cutoff counts back from it. */
	startsAt: number | null;
	/** When a held booking's lock expires (ms). */
	expiresAt: number | null;
	/** What the lock does at `expiresAt` when nobody settled it: from `policy.noShow` when the hold was made. */
	expiryAction?: "confirm" | "release";
	/** The open lock row while `state` is `held`; dropped when settled. */
	lock?: HoldLock;
	/**
	 * When each refilling credit row the hold drew from (a tier or recurring add-on row) was due to reset when the hold was
	 * made, by row id; dropped when settled. A release after that reset ran does not give last cycle's credits to the new
	 * cycle: they go back as the row's rollover would have carried them, or lapse. Absent when the hold drew from no such row.
	 */
	resetsAt?: Record<string, number>;
	/** When the hold was made, and when it was settled (ms). */
	heldAt?: number;
	settledAt?: number;
	/** How it was settled: `confirm`, `cancel` (before the cutoff), `late_cancel`, `no_show`, `release`, `expiry`. */
	settledBy?:
		| "confirm"
		| "cancel"
		| "late_cancel"
		| "no_show"
		| "release"
		| "expiry";
	/** A paid booking's payment (a `booking` payment mode checkout). */
	payment?: {
		sessionId: string;
		paymentIntentId: string | null;
		amount: number;
		currency: string;
		/** The charge's total refunded so far (minor units). */
		refunded: number;
		/**
		 * The books took this payment (its `payment.succeeded`), as `InvoiceRecord.paid` says for an invoice. Absent when none
		 * was booked: a payment decided before payments were booked, or one in another currency (its `money.skipped` marker is
		 * not a payment). A refund of such a payment makes no `payment.refunded`: there is no payment for it to take back from.
		 */
		booked?: boolean;
		/**
		 * The revenue share accrued on this payment and the part a refund has taken back, as `InvoiceRecord.share` says for an
		 * invoice. Absent when none was accrued, so a state with no share is written as before.
		 */
		share?: { accrued: number; reversed: number };
	};
};

/** What every booking command takes besides its own fields: the subject as stored, the menu and the policy, like a Stripe event. */
export type BookingContext = {
	menu: Menu;
	menuVersion: number | string;
	policy: BillingPolicy;
	policyVersion: number | string;
	/** The subject's stored rows and revision (as `StripeEventInput`). */
	rows: readonly BillingRow[];
	revision: number;
	/** The engine catalog rows from `menuCatalogRows` for this menu. */
	catalog: readonly AtmCatalogRow[];
	/** The time of the call (ms), not the clock. */
	now: number;
	env?: AtmEnv;
};

/**
 * Hold credits for a booking. `credits` of `featureId` are taken out of what the holder can spend (the engine's `track`
 * with a lock, rejecting rather than overdrawing, `commandOrg(policy)` on it so the row that lapses soonest is drawn
 * first) and kept on a lock until `expiresAt`, so no other booking can use them. The lock's expiry action is `confirm`
 * when `policy.noShow` is `spend` (an unsettled booking is a no-show) and `release` otherwise. The same booking id with
 * the same fields again is a replay: ok, nothing to write.
 */
export type HoldBookingInput = BookingContext & {
	bookingId: string;
	featureId: string;
	credits: number;
	/** When the session starts (ms); the cancel cutoff counts back from it. */
	startsAt: number;
	/** When the hold lapses (ms), after `startsAt` and the time of the call. */
	expiresAt: number;
};

/** The same for confirm, release, cancel and no-show: which booking, and the context. */
export type SettleBookingInput = BookingContext & { bookingId: string };

/**
 * `rowChanges` is one write for the subject (the engine's rows and the grants row under one revision), null when the call
 * changes nothing (a replay). `events` are the ledger events: a hold is `credit.held`; a release `credit.released`; a
 * `confirmBooking` is `credit.spent`; a no-show, a late cancel and an expired hold that confirms are `credit.forfeited` (the
 * credits leave `credits:held` for `credits:forfeited`, not for a service); and a hold that takes the holder's balance to
 * the policy's `lowCreditThreshold` or to zero adds `credit.low` or `credit.depleted` (the balance falls when the credits are
 * held, so that is where the alert is made). A command that moves no credits is a `plan.changed`.
 */
export type BookingResult =
	| {
			ok: true;
			rowChanges: RowChanges | null;
			events: AtmEvent[];
			booking: BookingRecord;
			/** `cancel` only: whether the cutoff had passed (the late-cancel rule applied). */
			late?: boolean;
	  }
	| BookingRefusal;

/** A hold whose expiry has passed and has not been settled. */
export type ExpiredHold = {
	bookingId: string;
	expiresAt: number;
	expiryAction: "confirm" | "release";
	featureId: string;
	credits: number;
};

// ---- A one-time payment for a booking (0.8.0) ----

export type BookingCheckoutInput = {
	schoolId: string;
	familyId: string;
	/** The caller's booking id; it comes back on the paid event. */
	bookingId: string;
	/** What the Checkout page calls the line (the booking type's name). */
	name: string;
	amount: number;
	currency: string;
	/** A child profile the booking is for; omit for the buyer's own. */
	forProfileId?: string | null;
	returnUrls: { success: string; cancel: string };
};

/**
 * A payment-mode Checkout Session's parameters (nested, Stripe's shape) for one booking: a single inline price
 * (`price_data`, so nothing is published for it), `metadata` with `b4u_school`, `family_id`, `booking_id` and `b4u_kind`
 * `booking` on the session and on its payment intent (so the charge, and its refund, carry them). No `invoice_creation`:
 * a booking is not a membership invoice and grants no credits.
 */
export type BookingCheckoutParams = {
	mode: "payment";
	client_reference_id: string;
	success_url: string;
	cancel_url: string;
	line_items: [
		{
			quantity: 1;
			price_data: {
				currency: string;
				unit_amount: number;
				product_data: { name: string };
			};
		},
	];
	metadata: Record<string, string>;
	payment_intent_data: { metadata: Record<string, string> };
};

export type BookingCheckoutRefusal =
	| { ok: false; reason: "bad_amount" }
	| { ok: false; reason: "bad_currency" }
	| { ok: false; reason: "no_booking_id" };

export type BookingCheckoutResult =
	| { ok: true; params: BookingCheckoutParams }
	| BookingCheckoutRefusal;

/**
 * What the handler decided about a booking's payment, for the caller to act on.
 * - `paid`: the session completed and is paid. Confirm the booking.
 * - `refunded`: the charge is refunded in full. Cancel the booking.
 * - `partly_refunded`: part of the charge is refunded. Cancel nothing: the school decides.
 * - `expired`: the Checkout Session expired unpaid. Free the booking's slot.
 */
export type BookingPaymentOutcome = {
	action: "paid" | "refunded" | "partly_refunded" | "expired";
	bookingId: string;
	familyId: string;
	schoolId: string;
	sessionId: string | null;
	/** Learn `paymentIntentId` and `chargeId` here and pass them back as `StripeEventInput.bookingIds`. */
	paymentIntentId: string | null;
	chargeId: string | null;
	/** The amount paid, or for a refund the amount refunded in all so far (minor units). */
	amount: number;
	currency: string;
};

// ---- Gift codes (0.8.0) ----

/**
 * A session gift certificate: a code that grants `credits` of `featureId` to whoever redeems it, once. Stripe is not
 * involved. The caller stores it (a row per code, found by `code`) and writes the redeemed copy back in the same
 * transaction as the holder's rows, guarded so that two redemptions cannot both pass (`UPDATE ... WHERE redeemed IS NULL`);
 * `redeemSessionGiftCode` checks the one-use rule against the state it is given and `GrantsState.redeemed` makes a replay by
 * the same holder a no-op, but only the caller's guarded write stops two holders at once.
 */
export type SessionGiftCode = {
	v: 1;
	/** The caller's id for the code (a row id); names the credit row and the command, so it must not repeat. */
	id: string;
	kind: "sessions";
	/** What the redeemer types: letters, digits, `-` and `_`, 6 to 40, compared without case. */
	code: string;
	featureId: string;
	/** Whole credits, 1 or more. */
	credits: number;
	/** The code cannot be redeemed after this time (ms). */
	redeemBy: number;
	/** The granted credits lapse this many months after redemption: `policy.giftSessionMonths` when it was made. */
	creditMonths: number;
	createdAt: number;
	/** null until redeemed. */
	redeemed: { holderId: string; at: number } | null;
};

export type RedeemedCode = {
	codeId: string;
	feature: string;
	credits: number;
	at: number;
	/** The credit row it made, and when its credits lapse (ms). */
	rowId: string;
	expiresAt: number | null;
};

export type CreateSessionGiftCodeInput = {
	id: string;
	code: string;
	featureId: string;
	credits: number;
	/** Redeem by this time (ms); atm does not read the clock. */
	redeemBy: number;
	createdAt: number;
	menu: Menu;
	policy: BillingPolicy;
};

export type GiftCodeRefusalReason =
	| "bad_code"
	| "bad_credits"
	| "unknown_feature"
	| "bad_expiry"
	| "code_mismatch"
	| "expired"
	| "already_redeemed"
	| "wrong_school"
	| "below_minimum"
	| "above_maximum"
	| "nothing_to_sell";

export type GiftCodeRefusal = {
	ok: false;
	reason: GiftCodeRefusalReason;
	message: string;
};

export type CreateSessionGiftCodeResult =
	| { ok: true; code: SessionGiftCode }
	| GiftCodeRefusal;

export type RedeemSessionGiftCodeInput = BookingContext & {
	/** The stored code state. */
	code: SessionGiftCode;
	/** What the person typed; compared with `code.code` without case. */
	entered: string;
	/** Whose credits these are when the subject has no rows yet (a new family with no membership). */
	holder: { orgId: string; customerId: string };
};

/**
 * `code` is the code's next state (redeemed by this holder at `now`); write it with `rowChanges` in one transaction. A
 * replay by the same holder (the grants state already names this code) is ok with nothing to write and the stored
 * `code` unchanged.
 */
export type RedeemSessionGiftCodeResult =
	| {
			ok: true;
			rowChanges: RowChanges | null;
			events: AtmEvent[];
			code: SessionGiftCode;
			redeemed: RedeemedCode;
	  }
	| GiftCodeRefusal;

/** Stripe steps for a dollar gift certificate: a coupon for a fixed amount off, and a promotion code that works once and ends. Not a `StripeOp`: they come per gift, not per menu. */
export type GiftStripeOp =
	| {
			op: "coupon.ensure_amount";
			id: string;
			amountOff: number;
			currency: string;
			appliesToProductKeys: string[];
			idempotencyKey: string;
	  }
	| {
			op: "promotion_code.ensure_limited";
			code: string;
			couponId: string;
			/** Stripe `max_redemptions`: 1. */
			maxRedemptions: 1;
			/** Stripe `expires_at`, in ms here (the caller divides by 1000). */
			expiresAt: number;
			idempotencyKey: string;
	  }
	| { op: "promotion_code.deactivate"; code: string; idempotencyKey: string };

export type DollarGiftInput = {
	schoolId: string;
	menu: Menu;
	policy: BillingPolicy;
	/** The caller's id for the gift (names the coupon). */
	giftId: string;
	/** The code text; same rules as `SessionGiftCode.code`. */
	code: string;
	/** Cents, at least `policy.giftDollarMinimum`. */
	amount: number;
	/** When it was issued (ms); it ends `policy.giftDollarMonths` later on the school's calendar. */
	issuedAt: number;
};

export type DollarGiftResult =
	| { ok: true; ops: GiftStripeOp[]; expiresAt: number }
	| GiftCodeRefusal;

// ---- Membership status ----

/**
 * - `active`: paid up (Stripe `active`, `trialing`).
 * - `past_due`: a renewal failed; Stripe is retrying (`past_due`) or gave up on collecting (`unpaid`).
 * - `incomplete`: the first payment is not finished (`incomplete`).
 * - `ended`: over (`canceled`, `incomplete_expired`).
 * - `inactive`: paused (`paused`).
 */
export type MembershipStatus =
	| "active"
	| "past_due"
	| "incomplete"
	| "ended"
	| "inactive";

export type SubscriptionStatus = {
	status: MembershipStatus;
	/** When the next renewal is due (ms); null unless the subscription is active or past due and will renew. */
	renewsAt: number | null;
	/** Cancels at the end of the paid period. False once the subscription has ended. */
	cancelAtPeriodEnd: boolean;
	/** When the paid period ends and the membership stops (ms), for a subscription set to cancel; else null. */
	endsAt: number | null;
	/** Counts as a current member: `active` or `trialing` in Stripe. */
	active: boolean;
};

// ---- Normalizing Stripe events ----

export type FieldType = "string" | "int" | "seconds" | "bool" | "map" | "sum";

export type FieldSpec = {
	/** JSONPath from the event root (for top-level fields) or from the line (for `lines.fields`). */
	path: string;
	type: FieldType;
	/** A missing optional path is not an error: the field takes `default`, or is left out when there is none. */
	optional?: boolean;
	default?: unknown;
	/** String fields: maps the raw value to the fact's value (an enum, or null). */
	values?: Record<string, string | null>;
	/** With `values`: the value when the raw value is not in the table. Without it, an unknown value is an error. */
	fallback?: string | null;
	/** Bool fields: true when the int at `path` equals the int at `equalsPath`. */
	equalsPath?: string;
	/** Int fields: the smallest value allowed. With it, a value that is not a whole number at or above it is a `bad_value`, not a `bad_type`. */
	min?: number;
	/** For an `int` field: the largest value accepted; a larger number is a `bad_value`. */
	max?: number;
	/** Sum fields: the list is at `path`; each element's whole number is at `each` (from the element). A total of 0 leaves the field out. */
	each?: string;
};

export type MappingTarget =
	| "BillingInvoice"
	| "BillingRefund"
	| "BillingDispute"
	| "SubscriptionFact"
	| "InvoicePaymentFact"
	| "StripePayout"
	| "CheckoutSessionFact";

/** A declarative mapping: one Stripe event type at one API version, and where each fact field sits in the raw JSON. */
export type Mapping = {
	v: number;
	source: "stripe";
	event: string;
	target: MappingTarget;
	/** The Stripe API version this mapping reads. An event from any other version is refused. */
	stripeApiVersion: string;
	fields: Record<string, FieldSpec>;
	/** For invoices: where the line items are, and how to read each one. */
	lines?: { path: string; fields: Record<string, FieldSpec> };
	/** Paths (from the event root) holding personal data. `redactPersonal` removes them. */
	personal: string[];
};

export type BillingFact =
	| BillingInvoice
	| BillingRefund
	| BillingDispute
	| SubscriptionFact
	| InvoicePaymentFact
	| StripePayout
	| CheckoutSessionFact;

export type NormalizeError =
	| { kind: "missing_path"; field: string; path: string }
	| { kind: "bad_type"; field: string; path: string; expected: FieldType }
	| { kind: "bad_value"; field: string; path: string }
	| { kind: "bad_path"; field: string; path: string }
	| { kind: "event_type"; expected: string; got: unknown }
	| { kind: "api_version"; expected: string; got: unknown }
	| {
			kind: "unknown_mapping";
			event: string;
			apiVersion: string;
			known: string[];
	  };

export type NormalizeResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: NormalizeError };

export type NormalizeContext = { eventId: string };

/** A line item of the menu, found by a line's lookup key or price id. */
export type LineItem = (
	| { kind: "tier"; tierId: string }
	| { kind: "addon"; addonId: string }
) & {
	/** The price's lookup key, which a Stripe invoice line (API 2025-10-29.clover) does not carry. */
	lookupKey?: string;
	/** The price's interval (null: one-time), likewise not on the line. Required: "not given" must not read as one-time. */
	interval: Interval | null;
	/** An add-on that is a gift certificate. */
	gift?: GiftKind;
};

// ---- One entry point for a Stripe event ----

export type StripeEventInput = {
	/** The raw Stripe event, as received (verified and deduplicated by the caller). */
	event: unknown;
	/**
	 * The stored input event's id, a ULID (not Stripe's `evt_` id: the caller dedupes on that one): it becomes `cause`
	 * on every decision event, which the ledger's envelope requires to be a ULID, and the id of every command. Any
	 * other value comes back `refused` as `bad_event`.
	 */
	eventId: string;
	menu: Menu;
	menuVersion: number | string;
	policy: BillingPolicy;
	policyVersion: number | string;
	/** The subject's stored rows, engine tables and the grants row; empty for a subject not created yet. */
	rows: readonly BillingRow[];
	/** The revision the store holds for the subject (0 for none). */
	revision: number;
	/** The engine catalog rows from `menuCatalogRows` for this menu. */
	catalog: readonly AtmCatalogRow[];
	/** The time of the event being handled (ms), not the clock. */
	now: number;
	/**
	 * Stripe price ids by lookup key (what publishing the menu made). A Stripe invoice line (API 2025-10-29.clover)
	 * names its price by id only, so without this no line matches the menu.
	 */
	priceIds?: Readonly<Record<string, string>>;
	/**
	 * Invoice ids by payment intent id (or charge id). A Stripe charge or dispute does not name its invoice, so a refund
	 * or lost dispute finds the invoice to take credits back from here. Learn it from `invoice_payment.paid`.
	 */
	invoiceIds?: Readonly<Record<string, string>>;
	/**
	 * Booking ids by payment intent id (or charge id), for a paid booking's refund, as `invoiceIds` is for an invoice's:
	 * a charge names neither. Learn it from the `booking` a `checkout.session.completed` result carries.
	 */
	bookingIds?: Readonly<Record<string, string>>;
	/**
	 * What Stripe took for the payment an `invoice.paid` is, in cents: the `fee` of the charge's balance transaction. No
	 * webhook event carries it, so the caller reads it from Stripe (see `WebhookDeps.paymentFee`) and passes it in, which
	 * keeps this function pure. It becomes the `fee` of the `payment.succeeded` event. Absent: no fee line is booked
	 * (the books then hold the gross amount in `assets:stripe`). Anything but a whole number from 0 to the amount paid
	 * comes back `refused` as `bad_event`. Read only for `invoice.paid` and for the paid `checkout.session.completed` (or
	 * `async_payment_succeeded`) of a booking, where it is the fee of the payment intent's charge; read from the first
	 * delivery only, as a replay decides nothing.
	 */
	fee?: number;
	/**
	 * The school the event is for. Needed only for events that name no family (`payout.paid`), which have no subject to
	 * take it from; without it such an event comes back `refused` as `bad_event`.
	 */
	school?: string;
	/**
	 * Stripe's mode for this subject, part of its subject key and of `identity.env` on every command. Default `"live"`.
	 * A school with both a test and a live endpoint passes it so the two do not share a subject; build `catalog` with
	 * the same `env` (`menuCatalogRows`). Anything else throws.
	 */
	env?: AtmEnv;
};

/** Why an event was set aside: nothing was decided and nothing is to be written. Keep the event and retry after the cause is fixed. */
export type StripeEventRefusal = {
	reason:
		| "unknown_mapping"
		| "bad_event"
		| "missing_metadata"
		| "unmatched_line"
		| "addon_only_subscription"
		| "tier_on_other_subscription"
		| "unmatched_invoice"
		| "unknown_subscription"
		| "unmatched_booking"
		| "rejected";
	message: string;
	/**
	 * The money line of a paid invoice whose credits were refused (`unmatched_line`, `tier_on_other_subscription`,
	 * `addon_only_subscription`, `rejected`): its `payment.succeeded`, or the `money.skipped` marker of a non-USD one.
	 * Stripe has collected the money whatever the menu says, so the caller appends these to the outbox in the
	 * transaction that releases the claim (the reference handler does). `rowChanges` stays null and `events` empty: no
	 * credit is granted. The line's idem is `stripe:<invoice id>`, so the delivery that is applied after the cause is
	 * fixed makes the same event and the outbox keeps the one it has. Absent for every other refusal, and ignored by a
	 * caller that does not know it: the refusal is then what it was.
	 */
	payment?: AtmEvent[];
};

export type StripeEventResult = {
	/** One write for the subject, or null when the event changes nothing (replayed, not about credits). */
	rowChanges: RowChanges | null;
	/**
	 * The decision events, each with `cause` = the event id and the menu, policy and mapping labels: `credit.*` and
	 * `plan.changed`, and the money lines of a payment (`payment.succeeded`, also of a paid booking's), a refund (`payment.refunded`) and a payout
	 * (`payout.paid`), and of a dispute that moved money: `payment.disputed` when it opens (the withdrawal and Stripe's
	 * dispute fee) and `dispute.closed` when it closes.
	 */
	events: AtmEvent[];
	/**
	 * What a one-time booking payment's event decided, for the caller to act on (0.8.0): confirm the booking on `paid`, cancel
	 * it on `refunded`, free its slot on `expired`. Set only for a payment-mode Checkout Session made by `bookingCheckoutParams`
	 * and the refund of its charge; every other event leaves it out.
	 */
	booking?: BookingPaymentOutcome;
	refused?: StripeEventRefusal;
};

/**
 * A `BillingFact` without what the grant rules never read: its `source` (rebuilt from the event id, the mapping and the API
 * version), the invoice's number and its bearer links. A fact's `metadata` is cut to the keys the rules read
 * (`REPLAY_METADATA_KEYS`; a checkout session also keeps `booking_id`). Built by `replayFactOf`.
 */
export type ReplayFact =
	| Omit<
			BillingInvoice,
			"source" | "number" | "hostedInvoiceUrl" | "invoicePdf"
	  >
	| Omit<BillingRefund, "source">
	| Omit<BillingDispute, "source">
	| Omit<SubscriptionFact, "source">
	| Omit<InvoicePaymentFact, "source">
	| Omit<StripePayout, "source">
	| Omit<CheckoutSessionFact, "source">;

/** The shape of a stored fact body. `v` is the version of this shape. */
export type StoredFactBody = { v: 1; fact: ReplayFact };

/** The mapping and normalization step of `handleStripeEvent`: the fact the rules will decide on, or why there is none. */
export type NormalizedStripeEvent =
	| {
			ok: true;
			target: MappingTarget;
			/** `stripe/invoice.paid@v1`: the label the fact's `source.mapping` carries. */
			mappingLabel: string;
			apiVersion: string;
			/** The event's `type`. */
			type: string;
			fact: BillingFact;
	  }
	| { ok: false; refusal: StripeEventRefusal };

/** `handleStripeEvent` from the step "decide" on: an already normalized fact in place of the raw event. */
export type StripeFactInput = Omit<StripeEventInput, "event"> & {
	/** The fact, or the stored replay fact (`replayFactOf`); `source` is rebuilt from `eventId`, `mapping` and `apiVersion`. */
	fact: ReplayFact;
	target: MappingTarget;
	/**
	 * The event type. The dispute rule reads it to tell `charge.dispute.closed` from `charge.dispute.created`; there is
	 * no raw event here to read it from.
	 */
	type: string;
	apiVersion: string;
	/** `stripe/invoice.paid@v1` */
	mapping: string;
};

// ---- Stored inputs ----

/** Whether a stored input was decided (`applied`) or set aside with a 422-type reason (`refused`). */
export type InputOutcome = "applied" | "refused";

/**
 * One handled Stripe input as the handler's database keeps it (`atm_event_inputs`): the trimmed fact the grant rules decided
 * on, the side inputs the fact does not hold, and the context it was decided under. Never the raw event.
 */
export type StoredInput = {
	/** The order the inputs were applied in (an `AUTOINCREMENT`): the order of replay. */
	appliedOrder: number;
	env: AtmEnv;
	/** Stripe's `evt_...`. */
	eventId: string;
	schoolId: string;
	/** `<school>|<env>|family:<id>` (a payout: `stripe:payouts`); null after an erasure. */
	subjectKey: string | null;
	type: string;
	apiVersion: string;
	/** `stripe/invoice.paid@v1`: the mapping that read the event. */
	mapping: string;
	livemode: boolean | null;
	/** Stripe's `created`, whole seconds: the decision clock. */
	stripeCreated: number;
	/** When the input was committed, ms. */
	receivedAt: number;
	outcome: InputOutcome;
	reason: StripeEventRefusal["reason"] | null;
	/** How often this event was handled: 1 for an applied input that never failed, more for one that was refused first. */
	attempts: number;
	revisionBefore: number | null;
	revisionAfter: number | null;
	/** The package version that decided it. */
	atmVersion: string;
	contextHash: string | null;
	menuVersion: string | null;
	policyVersion: string | null;
	/** The caller's `paymentFee` answer, cents. */
	fee: number | null;
	/** The payment intent and charge ids an invoice paid with. */
	paymentRefs: string[] | null;
	/** The ULID the decision events name as their `cause`. */
	inputId: string;
	/** The caller's `bookingIds` entries this fact's decision used: payment intent or charge id to booking id; null after an erasure. */
	bookingRefs: Record<string, string> | null;
	/** SHA-256 of the verified raw body; null after an erasure. */
	rawSha256: string | null;
	/** The stored replay fact; null after an erasure. */
	fact: ReplayFact | null;
	erasedAt: number | null;
	batchKey: string | null;
	shippedAt: number | null;
};

/** The menu, policy and Stripe price ids that were in force when inputs were handled (`atm_input_contexts`). */
export type StoredContext = {
	env: AtmEnv;
	schoolId: string;
	contextHash: string;
	menuVersion: string;
	policyVersion: string;
	firstUsedAt: number;
	menu: Menu;
	policy: BillingPolicy;
	priceIds: Record<string, string>;
};

/** A holder's rows and revision as they were just before its first stored input (`atm_input_seeds`). */
export type StoredSeed = {
	env: AtmEnv;
	subjectKey: string;
	revision: number;
	takenAt: number;
	firstEventId: string;
	rows: BillingRow[];
};

/** What `recordInput` takes. It runs in the caller's transaction. */
export type RecordInputArgs = {
	env: AtmEnv;
	schoolId: string;
	event: {
		/** Stripe's `evt_...`. */
		id: string;
		type: string;
		/** Stripe's `created`, whole seconds. */
		created: number;
		apiVersion: string;
		livemode: boolean | null;
	};
	/** The verified raw body: hashed, never stored. */
	rawBody: string;
	/** `normalizeStripeEvent` of the event; the fact stored is its `replayFactOf`. */
	normalized: Extract<NormalizedStripeEvent, { ok: true }>;
	outcome: InputOutcome;
	/** The 422-type reason of a refusal; null for an applied input. */
	reason: StripeEventRefusal["reason"] | null;
	subjectKey: string | null;
	revisionBefore: number | null;
	revisionAfter: number | null;
	/** The rows the decision was made on; stored as the holder's seed when this is its first stored applied input. */
	rowsBefore: readonly BillingRow[];
	/** The context the decision ran under; null for an input that decided nothing and read none (`invoice_payment.paid`). */
	context: WebhookContext | null;
	fee: number | null;
	/** An invoice's payment intent and charge ids; null for every other input. */
	paymentRefs: readonly string[] | null;
	/** The ULID passed to `handleStripeEvent` as `eventId` (the handler's is `inputCauseId`). */
	inputId: string;
	/** The `bookingIds` entries the decision used; null when none. */
	bookingRefs: Readonly<Record<string, string>> | null;
	nowMs: number;
	/** The package version; default: this package's own. */
	atmVersion?: string;
};

export type InputsStatus =
	| { available: false; reason: "no_table" | "empty" }
	| {
			available: true;
			applied: number;
			refused: number;
			erased: number;
			seeds: number;
			/** Applied or erased rows not yet shipped (`shipped_at` null). */
			unshipped: number;
			/** `received_at`, ms. */
			firstStoredAt: number;
			lastStoredAt: number;
			schools: string[];
			envs: AtmEnv[];
			atmVersions: string[];
	  };

/** What a replay reads: the stored inputs of one school and env, from SQLite or from a shipped copy. */
export type InputsRead = {
	/** Applied and erased inputs, ordered by `appliedOrder`. */
	inputs: StoredInput[];
	/** 422 refusals, ordered by `stripeCreated`; empty from a shipped folder. */
	refused: StoredInput[];
	/** By `subjectKey`. */
	seeds: Map<string, StoredSeed>;
	/** By `contextHash`. */
	contexts: Map<string, StoredContext>;
	/** Where it came from, for messages: a file path, a folder, or "store". */
	origin: string;
};

/** What the replay reads; the handler's SQLite (`sqliteInputsSource`) and a shipped copy both implement it. */
export interface InputsSource {
	read(filter: { env: AtmEnv; school: string }): Promise<InputsRead>;
}

// ---- Storage rows ----

/**
 * The tables a subject's rows live in, in the order rows are listed: the engine's state tables, then `atm_grants`,
 * the one JSON row (id `grants`) holding the billing rules' `GrantsState`. Both change under the one revision.
 */
export type RowTable =
	| "customer"
	| "entity"
	| "customerProducts"
	| "customerPrices"
	| "customerEntitlements"
	| "rollovers"
	| "replaceables"
	| "usageWindows"
	| "openLocks"
	| "pooledBalances"
	| "customerLicenses"
	| "atm_grants";

/** A JSON-safe object: what is stored in `atm_rows.data`. */
export type RowData = Record<string, unknown>;

export type BillingRow = { table: RowTable; id: string; data: RowData };
export type RowKey = { table: RowTable; id: string };

export type SubjectRows = {
	identity: AtmIdentity;
	revision: number;
	rows: readonly BillingRow[];
};

export type RowChanges = {
	subjectKey: string;
	/** The revision the store must hold for the write to apply. */
	expectedRevision: number;
	nextRevision: number;
	upserts: BillingRow[];
	deletes: RowKey[];
};

// ---- Moving a caller that grants on its own onto `handleStripeEvent` ----

/**
 * A row of the B4 Uni family service's `school_memberships` (migrations 0131 and 0134), as `SELECT *` returns it.
 * Instants are Unix SECONDS here (Stripe's own: `current_period_end`, `stripe_event_at`, `created_at`, `updated_at`).
 * atm reads `school_id`, `family_id`, `tier_id`, `interval`, `addon_ids`, `quantity`, `stripe_subscription_id`,
 * `status`, `current_period_end`, `cancel_at_period_end`, `stripe_event_at`, `created_at` and `updated_at`.
 */
export type CallerMembershipRow = {
	id: string;
	school_id: string;
	family_id: string;
	profile_id: string | null;
	tier_id: string;
	interval: Interval;
	/** The add-ons bought with the tier, comma-separated menu ids; '' = none. */
	addon_ids: string;
	menu_version: number;
	stripe_customer_id: string;
	/** The count of the tier bought (1 to 50). */
	quantity: number;
	stripe_subscription_id: string;
	status: "active" | "past_due" | "incomplete" | "canceled";
	current_period_end: number | null;
	/** 0 or 1 (SQLite has no boolean). */
	cancel_at_period_end: number;
	revision: number;
	stripe_event_at: number | null;
	created_at: number;
	updated_at: number;
};

/**
 * A row of the caller's `school_credit_lots` (migration 0131): one grant of one feature for one invoice, shaped as the
 * engine's customer entitlement. Instants are Unix MILLISECONDS here (`expires_at`, `next_reset_at`, `created_at`,
 * `removed_at`), unlike the membership's seconds. `created_at` is the time of the Stripe event that granted the lot.
 */
export type CallerCreditLotRow = {
	id: string;
	membership_id: string;
	school_id: string;
	feature_id: string;
	invoice_id: string;
	/** `tier` or `addon:<menu add-on id>`. */
	source: string;
	/** `once` for a one-time add-on; otherwise the grant's own interval on the menu. */
	every: Interval | "once";
	/** What the invoice put into the lot (already times the quantity, and times 12 for a monthly grant paid yearly). */
	allowance: number;
	/** When a refund or a lost dispute took the lot's unused credits back (once), else null. */
	removed_at: number | null;
	balance: number;
	adjustment: number;
	additional_balance: number;
	/** The caller never sets it: a lot lasts until `expires_at`. */
	next_reset_at: number | null;
	expires_at: number | null;
	created_at: number;
};

export type CallerRowsInput = {
	/** The member's `school_memberships` row. */
	membership: CallerMembershipRow;
	/** Every `school_credit_lots` row of that membership, in any order. */
	lots: readonly CallerCreditLotRow[];
	/** The menu the membership's invoices are granted against. */
	menu: Menu;
	/** The instant of the import (ms): a lot past its `expires_at` then holds nothing. atm reads no clock. */
	now: number;
};

/** A member's rows as atm keeps them: the engine rows and the grants row to write at one revision, and the grants state in them. */
export type CallerRowsImport = {
	state: GrantsState;
	/** The engine rows (customer, products, credit rows, rollovers) and the `atm_grants` row, in canonical order. */
	rows: BillingRow[];
};

/** Thrown by `assertRevision` and `applyRowChanges` when the stored revision is not the one a mutation was computed against: re-read, recompute, retry. */
export interface StaleRevisionError extends Error {
	readonly expected: number;
	readonly actual: number;
	readonly subjectKey?: string;
}
export interface StaleRevisionConstructor {
	new (
		expected: number,
		actual: number,
		subjectKey?: string,
	): StaleRevisionError;
	readonly prototype: StaleRevisionError;
}

// ---- Object store ----

/** A key and what a LIST knows about it. LIST returns no custom metadata, so no sha256 here. */
export type StoreObject = {
	key: string;
	size: number;
	etag: string;
};

/** What HEAD knows. `sha256` is null for an object written without `x-amz-meta-sha256` (by hand, or by a school). */
export type StoreHead = StoreObject & {
	sha256: string | null;
};

/** A GET. On a range GET `body` holds only the range and `size` is the object's total size (from `Content-Range`). */
export type StoreGet = StoreHead & {
	body: Uint8Array;
	/** The inclusive byte range `body` covers; absent on a whole-object GET. */
	range?: { start: number; end: number };
};

export type ListOptions = {
	prefix?: string;
	/** Group keys by this string after the prefix (usually "/"): the groups come back as `prefixes`. */
	delimiter?: string;
	/** At most this many keys and prefixes in one page. */
	maxKeys?: number;
	/** The `next` of the previous page. */
	cursor?: string;
};

export type ListPage = {
	/** In ascending key order. */
	objects: StoreObject[];
	/** Common prefixes (with the delimiter), in ascending order. */
	prefixes: string[];
	/** Pass as `cursor` for the next page; null on the last page. */
	next: string | null;
};

/** The stored object's identity after a put. */
export type PutResult = {
	etag: string;
	sha256: string;
};

export type PresignOptions = {
	/** 1 second to 7 days on R2; an expired URL is refused. */
	expiresInSeconds: number;
};

export interface Store {
	/**
	 * Create-only put (`If-None-Match: *`). Throws `AlreadyExists` when the key exists (a 412), whatever its bytes: see
	 * `putOnce` for the caller's rule.
	 */
	putIfAbsent(key: string, body: Uint8Array): Promise<PutResult>;
	/**
	 * Replace only while the object still has this ETag (`If-Match`). Throws `Stale` when it has another one (a 412), and
	 * `NotFound` or `Stale` when the key does not exist (AWS and R2 answer 404, SeaweedFS 412).
	 */
	putIfMatch(key: string, body: Uint8Array, etag: string): Promise<PutResult>;
	/** Throws `NotFound`. With `range`, the bytes from `start` to `end` inclusive (to the end when `end` is absent). */
	get(key: string, range?: { start: number; end?: number }): Promise<StoreGet>;
	/** Throws `NotFound`. The ETag it returns is one `putIfMatch` accepts. */
	head(key: string): Promise<StoreHead>;
	list(options?: ListOptions): Promise<ListPage>;
	/**
	 * Delete the object only if its sha256 is the one given: HEAD, compare, then DELETE (R2 documents no conditional
	 * DELETE, so this guards against a wrong key, not a race). Throws `ShaMismatch` and leaves the object when it
	 * differs. Returns false when the key is already gone, so a re-run is a no-op.
	 */
	delete(key: string, expectedSha256: string): Promise<boolean>;
	/** A GET URL valid for `expiresInSeconds`. Throws `Unsupported` where the store has no URLs to sign (the folder). */
	presign(key: string, options: PresignOptions): Promise<string>;
}

/** What every error a Store throws has in common. Its `name` says which: AlreadyExists, Stale, NotFound, Transient, ShaMismatch, Conflict, Unsupported. */
export type AtmStoreError = Error & { readonly key: string | null };

// ---- Stores and the reference webhook handler ----

/** Where a FolderStore keeps its objects. */
export type FolderStoreOptions = {
	root: string;
	/** A lock file older than this is taken over. Default 30_000. It must exceed the longest critical section. */
	lockStaleAfterMs?: number;
};

/** An R2 (or other S3-compatible) bucket and the credentials to reach it. */
export type R2StoreOptions = {
	/** `https://<account>.r2.cloudflarestorage.com`, or `http://127.0.0.1:8333` for SeaweedFS. */
	endpoint: string;
	bucket: string;
	/** Every key lives under this prefix; `list` and `get` never see it. */
	prefix?: string;
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	/** Default "auto". */
	region?: string;
	/** Default `globalThis.fetch`. Tests pass a fake S3. */
	fetch?: typeof fetch;
	/** Default: a real timer. Tests record the backoff and return at once. */
	sleep?: (ms: number) => Promise<void>;
	/** In [0, 1); the jitter. Default `Math.random`. */
	random?: () => number;
	/** Default 5. */
	maxTries?: number;
	/** Per request, default 30_000. */
	timeoutMs?: number;
};

/** A value SQLite binds. */
export type SqlValue = string | number | null;

/**
 * The smallest synchronous SQL surface the handler needs. bun:sqlite, node:sqlite and better-sqlite3 each satisfy it
 * with a few lines (see `bun-sqlite.ts`). Parameters are positional (`?`).
 */
export interface SqlDatabase {
	/** Runs one or more statements without parameters (the DDL). */
	exec(sql: string): void;
	all<T = Record<string, unknown>>(
		sql: string,
		params?: readonly SqlValue[],
	): T[];
	run(sql: string, params?: readonly SqlValue[]): { changes: number };
	/**
	 * Runs `fn` in one transaction: commit when it returns, roll back and rethrow when it throws. Should take the
	 * write lock up front (`BEGIN IMMEDIATE`) so that a read in `fn` cannot be overtaken by another writer.
	 */
	transaction<T>(fn: () => T): T;
}

/** What `migrateHandlerSchema` did: the tables it rebuilt with an `env` key (none when the database was current). */
export type HandlerMigrationResult = {
	rebuilt: string[];
};

export type SignatureFailure = "malformed" | "stale_timestamp" | "no_match";

export type SignatureVerdict =
	| { ok: true }
	| { ok: false; reason: SignatureFailure };

export type VerifySignatureInput = {
	/** The raw request body, byte for byte as Stripe sent it. */
	payload: string;
	/** The `Stripe-Signature` header: `t=<unix seconds>,v1=<hex>[,v1=<hex>...]`. */
	header: string;
	/** The endpoint's signing secret (`whsec_...`). */
	secret: string;
	nowMs: number;
	/** How far the signed timestamp may be from `nowMs`, either way. Default 300. */
	toleranceSeconds?: number;
};

/** What the handler needs to know about a school to decide its events. */
export type WebhookContext = {
	menu: Menu;
	menuVersion: number | string;
	policy: BillingPolicy;
	policyVersion: number | string;
	/** The engine catalog rows from `menuCatalogRows` for this menu. */
	catalog: readonly AtmCatalogRow[];
	/** Stripe price ids by lookup key, from publishing the menu. */
	priceIds?: Readonly<Record<string, string>>;
};

export type WebhookDeps = {
	db: SqlDatabase;
	/** The endpoint's signing secret. */
	secret: string;
	/**
	 * The school this endpoint and its `secret` belong to. A valid signature proves only that the event came from the
	 * Stripe account behind the endpoint, not which school it is for; the event's `b4u_school` metadata is the sender's
	 * claim. So an event whose school (from its metadata, or from the subject its invoice or payment was indexed under)
	 * is not this one is refused with 422 `school_mismatch` and nothing is written. Serve each school from its own
	 * endpoint and secret.
	 */
	schoolId: string;
	nowMs: () => number;
	/** Names this worker in `atm_event_claims.claimed_by`. */
	workerId: string;
	/** A claim older than this is taken over. Default 300_000. */
	claimStaleAfterMs?: number;
	/**
	 * The Stripe mode this endpoint receives, part of the subject key it writes (`<school>|<env>|family:<id>`). Default
	 * `"live"`. A school with both a test and a live endpoint passes it so the two do not share a subject; build the
	 * context's catalog with the same `env`. Anything else throws. A test-mode endpoint must pass `"test"`: an event whose
	 * boolean `livemode` disagrees with `env` is refused with 422 `livemode_mismatch`, before any claim, and writes nothing.
	 */
	env?: AtmEnv;
	/**
	 * The school's menu, policy and catalog; null when this service does not serve the school. Called once per attempt,
	 * inside the transaction, so a throw here leaves nothing written.
	 */
	context: (schoolId: string) => WebhookContext | null;
	/**
	 * Optional, and not needed: the handler learns which payment paid which invoice from the `invoice_payment.paid`
	 * event (subscribe the endpoint to it), and a refund or dispute finds its invoice through that link.
	 *
	 * An extra source for the same link: the payment intent and charge ids an `invoice.paid` event paid with, recorded
	 * when the invoice is applied (use it when the caller can read them elsewhere, say from the expanded invoice or its
	 * own records). Without `invoice_payment.paid` and without this, a refund or dispute answers 409
	 * `unmatched_payment` until Stripe gives up. Only the non-empty strings it returns are used.
	 */
	paymentRefs?: (event: unknown) => readonly string[];
	/**
	 * Optional: the Stripe fee, in cents, of the payment an `invoice.paid` event is (the `fee` of its charge's balance
	 * transaction). Without it a payment books its gross amount and no `expenses:billing:stripe-fees` line. No webhook event
	 * carries a fee, and an invoice names neither its charge nor its balance transaction, so Stripe has to be asked: before
	 * calling the handler, read the invoice's payment, its charge and the charge's `balance_transaction` (for a direct
	 * charge on a connected account, as that account) and return `fee` here. The handler is synchronous and calls this
	 * inside its transaction, so it must answer from what the caller already holds, not by a network call. Called once per
	 * `invoice.paid` attempt with the raw event; return `null` or `undefined` when the fee is not known (an asynchronous
	 * payment whose balance transaction is not there yet): the payment is then booked with no fee, and the fee is not
	 * booked later (the payment is booked once, and a re-send is answered `duplicate`). A value that is not a whole number
	 * from 0 to the amount paid is refused 422 `bad_event`.
	 */
	paymentFee?: (event: unknown) => number | null | undefined;
	/**
	 * Optional: where the handler says that it applied a delivery but did not book a money line (a non-USD invoice, refund,
	 * payout or dispute: outcome `non_usd`). Called once per such delivery, after the transaction committed, with one line of text.
	 * Default: the line goes to stderr. A throw here is caught (the delivery is committed, so it is still answered 200
	 * `non_usd`): the line goes to stderr instead, with the error's message.
	 */
	warn?: (line: string) => void;
};

export type WebhookRequest = {
	/** The raw body, as received. Do not parse and re-serialize it before this. */
	payload: string;
	/** The `Stripe-Signature` header. */
	signatureHeader: string;
};

/**
 * What the handler did with a delivery; `handleStripeWebhook`'s header lists the status for each. Among them:
 * `school_mismatch` (422) is an event for a school other than `WebhookDeps.schoolId`; `livemode_mismatch` (422) is an
 * event whose `livemode` disagrees with `WebhookDeps.env`; `ambiguous_payment` (422) is a refund or dispute whose
 * payment intent and charge were indexed under different subjects.
 */
export type WebhookOutcome =
	| "applied"
	/**
	 * 200, like `applied`: the rows and the credits were written, but a money line was not, because the invoice, refund,
	 * payout or dispute is not in USD. Each one left a `money.skipped` event in the outbox and `body.skipped` names them.
	 */
	| "non_usd"
	| "duplicate"
	| "ignored"
	| "busy"
	| "bad_signature"
	| "bad_request"
	| "unmatched_payment"
	| "unmatched_invoice"
	| "unknown_school"
	| "school_mismatch"
	| "livemode_mismatch"
	| "ambiguous_payment"
	| "stale_revision"
	| "refused";

export type WebhookResponse = {
	status: number;
	body: {
		outcome: WebhookOutcome;
		/** The Stripe event id, when the body parsed as an event. */
		stripeEventId?: string;
		/** `refused`: the reason from `handleStripeEvent`; `bad_signature`: why it failed. */
		reason?: string;
		message?: string;
		/** `applied` and `non_usd`: how many events went to the outbox and whether rows changed. */
		events?: number;
		wroteRows?: boolean;
		/** `non_usd`: what was not booked, one `<kind> <Stripe id> <amount> <currency>` per money line. */
		skipped?: string[];
	};
};

// ---- Shipping the outbox ----

/** The part of a `ledger_outbox` row a batch is made of. */
export type OutboxRow = {
	id: string;
	idem: string;
	/** The event's school-local date, `YYYY-MM-DD`: the partition its batch goes to. */
	date: string;
	/** The event's canonical serialized line (no newline). Shipped as it is. */
	body: string;
};

/** One object to put: a day's unshipped events, in id order, one line each. The key and the bytes depend on the rows alone. */
export type OutboxBatch = {
	/** `schools/<school>/events/date=<date>/batch-<first id>-<16 hex of sha256>.jsonl` */
	key: string;
	date: string;
	/** The ids in the object, ascending. */
	ids: string[];
	/** The object's text: the bodies joined by newlines, with a final newline. */
	text: string;
	sha256: string;
};

export type ShipOutboxInput = {
	/** The database the handler writes (`ledger_outbox`). */
	db: SqlDatabase;
	/** Where the batches go. Any `Store` works; only the create-only put and its equal-bytes check are used. */
	store: Store;
	school: string;
	/** Stamps `shipped_at` (milliseconds, as the handler stamps its claims). */
	nowMs: () => number;
};

export type ShippedBatch = {
	key: string;
	date: string;
	/** The rows this call marked shipped (fewer than the batch holds when another shipper marked some first). */
	events: number;
	/** `created`: this call wrote the object. `existing`: an equal one was already there (an earlier try or another shipper). */
	status: "created" | "existing";
};

/** A batch whose key already holds different bytes, or whose day already has a `day.jsonl`. Nothing was written and its rows stay unshipped. */
export type ShipConflict = {
	key: string;
	date: string;
	ids: string[];
	message: string;
};

export type ShipOutboxResult = {
	batches: ShippedBatch[];
	conflicts: ShipConflict[];
	/** The rows this call marked shipped. */
	shipped: number;
};

export type OutboxStatusInput = {
	/** The database the handler writes (`ledger_outbox`). */
	db: SqlDatabase;
	school: string;
	/** The clock the age is read against (milliseconds). */
	nowMs: () => number;
};

/** What a health check reads about one school's outbox. Nothing is written. */
export type OutboxStatus = {
	school: string;
	/** Every row of the school, shipped or not. */
	total: number;
	shipped: number;
	unshipped: number;
	/** The newest `shipped_at` (milliseconds), or null when nothing has shipped. */
	lastShippedAt: number | null;
	/** The `date` of the oldest unshipped row (`YYYY-MM-DD`), or null when nothing waits. */
	oldestUnshippedDate: string | null;
	/** The id of that row, or null when nothing waits. */
	oldestUnshippedId: string | null;
	/**
	 * How long that row has been waiting, read from the instant its id encodes (the event's own time, which the handler
	 * puts in the id), or from the date's UTC midnight when the id is not a ULID; null when nothing waits. The outbox
	 * keeps no insert time, so this is an upper bound on the lag: an event Stripe redelivers days late counts from its
	 * event time.
	 */
	oldestUnshippedAgeMs: number | null;
};

/**
 * How the events of one command the family service ran are booked: `AtmEventContext` without what `recordEngineCommand`
 * sets from the mutation and the state (`school`, `before`) or keeps for itself (`payload`, `idemPrefix`, `slice`).
 */
export type AtmCommandContext = Omit<
	AtmEventContext,
	"school" | "before" | "payload" | "idemPrefix" | "slice"
>;

export type RecordEngineCommandInput = {
	/** The database the handler writes. The caller's own transaction must be open: this opens none. */
	db: SqlDatabase;
	/** What `runEngineCommand` returned; null when the engine decided nothing. */
	mutation: AtmMutation | null;
	/** The subject as it was when the command ran (the state the engine ran on). Needed for the alerts, a delete and a lapsed rollover. */
	before: AtmSubjectState | null;
	/** The feature, service, reason and the rest the postings need; the school is the mutation's `identity.orgId`. */
	context: AtmCommandContext;
	/**
	 * The caller's claim that it records every engine command it runs for this subject, written as `payload.complete`.
	 * `replayEvents` reads it only for a command named `<ULID>:<step>` (the handler's names); a caller whose command ids
	 * are anything else needs nothing here. Default false: a claim a writer cannot keep is worse than none.
	 */
	logsEveryCommand?: boolean;
};

export type RecordLapseInput = {
	/** The database the handler writes. The caller's own transaction must be open: this opens none. */
	db: SqlDatabase;
	/** The subject as the cron read it; its identity names the school, the key and the holder, and its revision orders the events. */
	state: AtmSubjectState;
	featureOf: (internalFeatureId: string) => string | undefined;
	feature: string;
	atMs: number;
	tz: string;
	/** Opt in to `credit.depleted` (see `lapseAlertEvents`): the units of the feature the holder drew after an instant. */
	drawnAfter?: (instantMs: number) => number;
	labels?: Record<string, string>;
};

/** What a `record*` call made, and how many of those events were new to the outbox (a retry inserts none). */
export type RecordedEvents = {
	events: AtmEvent[];
	inserted: number;
};

/** Thrown by `replayEvents` where the engine disagrees with the log; `eventId` names the event. */
export interface ReplayErrorType extends Error {
	readonly eventId: string;
}
export interface ReplayErrorConstructor {
	new (eventId: string, message: string): ReplayErrorType;
	readonly prototype: ReplayErrorType;
}

/**
 * Thrown by `replayEvents` at a log written by atm 0.3.0 that has revisions with no event: an engine command that
 * writer did not log, or a write of the grants row alone (the two cannot be told apart). `prefix` is the replay of
 * everything before the gap.
 */
export interface ReplayGapErrorType extends ReplayErrorType {
	readonly gap: { subject: string; after: number; before: number };
	readonly prefix: AtmReplayResult;
}
export interface ReplayGapErrorConstructor {
	new (
		eventId: string,
		gap: { subject: string; after: number; before: number },
		prefix: AtmReplayResult,
	): ReplayGapErrorType;
	readonly prototype: ReplayGapErrorType;
}

// ---- Reconciling a school's log against Stripe's records ----

/** The fields `reconcile` reads of a Stripe invoice. Any other field is ignored, so a whole Stripe object is accepted. */
export type StripeInvoiceRecord = {
	id: string;
	/** Only `paid` invoices are compared. */
	status?: string | null;
	amount_paid: number;
	currency: string;
	created: number;
	livemode?: boolean;
	status_transitions?: { paid_at?: number | null } | null;
};

export type StripeRefundRecord = {
	id: string;
	amount: number;
	currency: string;
	created: number;
	/** The refunded charge (`ch_...`); with `payment_intent`, what a refund event labelled with a Stripe event id is paired by. */
	charge?: string | null;
	payment_intent?: string | null;
	/** `failed`, `canceled` and `requires_action` refunds moved no money and are ignored. */
	status?: string | null;
};

export type StripeDisputeRecord = {
	id: string;
	amount: number;
	currency: string;
	created: number;
	/** `won` and `lost` are outcomes; the `warning_*` statuses and `prevented` moved no money and are ignored. */
	status: string;
	livemode?: boolean;
};

export type StripePayoutRecord = {
	id: string;
	amount: number;
	currency: string;
	created: number;
	/** Only `paid` payouts are compared. */
	status?: string | null;
	livemode?: boolean;
};

/**
 * The fields `reconcile` reads of a Stripe payment intent, for a booking's one-time payment (no invoice). Only a `succeeded`
 * intent whose `metadata.booking_id` is set is compared (`bookingCheckoutParams` puts it there); the rest of the list, the
 * intents that paid invoices, is ignored.
 */
export type StripePaymentIntentRecord = {
	id: string;
	status?: string | null;
	amount: number;
	currency: string;
	created: number;
	livemode?: boolean;
	metadata?: Record<string, string> | null;
};

export type StripeBalanceTransactionRecord = {
	id: string;
	amount: number;
	fee: number;
	net: number;
	currency: string;
	created: number;
	type: string;
};

/** Stripe's side, as `stripe <resource> list` prints the `data` of each list. A list left out is "not supplied" and its checks are not run. */
export type ReconcileStripe = {
	invoices?: readonly StripeInvoiceRecord[];
	refunds?: readonly StripeRefundRecord[];
	disputes?: readonly StripeDisputeRecord[];
	payouts?: readonly StripePayoutRecord[];
	balanceTransactions?: readonly StripeBalanceTransactionRecord[];
	/**
	 * `stripe payment_intents list`: needed only by a school whose log holds a booking's `payment.succeeded`. When the log
	 * holds one and this is left out it is `notSupplied`; for a school with no booking payment it is never required.
	 */
	paymentIntents?: readonly StripePaymentIntentRecord[];
};

export type ReconcileStripeList = keyof ReconcileStripe;

/** A calendar month (`YYYY-MM`) or an inclusive range of days (`YYYY-MM-DD`), in the school's time zone. */
export type ReconcilePeriod = { month: string } | { from: string; to: string };

export type ReconcileInput = {
	/** The school's events, of any date: an event outside the period is still matched by id, so a payment the log dated a day off is `period_differs`, not two missing records. */
	events: readonly AtmEvent[];
	stripe: ReconcileStripe;
	period: ReconcilePeriod;
	/** The school's IANA zone, for dating Stripe's objects. Defaults to the zone of the latest event; required when there are none. */
	timeZone?: string;
	/** Stripe objects whose `livemode` disagrees are ignored. Default `live`. */
	mode?: "live" | "test";
};

export type ReconcileObject =
	| "invoice"
	| "refund"
	| "dispute"
	| "payout"
	| "fees"
	| "net"
	/** A booking's one-time payment (a payment intent, no invoice). */
	| "payment";

export type ReconcileKind =
	| "missing_in_log"
	| "missing_in_stripe"
	| "amount_differs"
	| "duplicate_in_log"
	/** A dispute's outcome in the log (`dispute.closed`) is not Stripe's status. */
	| "outcome_differs"
	/** Both sides have it, but one is dated inside the period and the other outside. */
	| "period_differs"
	/** A whole class of Stripe records has nothing in the log (fees with no fee postings): one record, not one per payment. */
	| "not_in_log";

export type ReconcileSide = {
	/** Cents; null when the log event has no whole-number amount. */
	amount: number | null;
	currency: string | null;
	/** The school-local day (`YYYY-MM-DD`); null for the totals. */
	date: string | null;
	/** Stripe's `status` (a dispute's); the log's `payload.status` (a `dispute.closed`). */
	status: string | null;
};

export type ReconcileDifference = {
	kind: ReconcileKind;
	object: ReconcileObject;
	/** Stripe's id (`in_`, `re_`, `dp_`, `po_`, `pi_` for a booking's payment); null for the totals. */
	id: string | null;
	/** The log event type compared against, null for the totals. */
	eventType: AtmEventType | null;
	/** The log events involved (more than one for `duplicate_in_log`). */
	eventIds: string[];
	stripe: ReconcileSide | null;
	log: ReconcileSide | null;
	/** The period's label: `2026-03`, or `2026-03-01..2026-03-31`. */
	period: string;
	message: string;
	/** For `net`: Stripe's net by balance transaction type, to show where a gap comes from. */
	stripeNetByType?: Record<string, number>;
};

export type ReconcileResult = {
	period: { from: string; to: string; label: string; timeZone: string };
	mode: "live" | "test";
	/** Sorted by object, id, kind. Empty means the books agree with Stripe. */
	differences: ReconcileDifference[];
	/** Lists of `stripe` that were undefined: their checks did not run. */
	notSupplied: ReconcileStripeList[];
	/** Records each side has in the period, after ignoring. Stripe's count is null for a list not supplied. */
	counts: Record<
		Exclude<ReconcileObject, "payment">,
		{ stripe: number | null; log: number }
	> & {
		/** A booking's payments; present only when `paymentIntents` was supplied or the log holds one, so a school with none reconciles as before. */
		payment?: { stripe: number | null; log: number };
	};
	/** Stripe records skipped, by reason (only reasons that applied). */
	ignored: Record<string, number>;
	/**
	 * The log's own `money.skipped` events dated in the period, by reason (`non_usd`): money Stripe moved that the handler
	 * deliberately did not book. Empty when there are none.
	 */
	skipped: Record<string, number>;
};

// ---- Reading a school's folder: events, journals and reports (the library form of `atm journal` and `atm report`) ----

/** What `journalMonth` made: the month's build, the paths it wrote (under the school's prefix), and whether it wrote none. */
export type JournalRun = {
	build: AtmJournalBuild;
	written: string[];
	unchanged: boolean;
};

/** One event file `readEvents` read: its key under the school's prefix, the sha256 of its text and its line count. */
export type AtmEventFile = { key: string; sha256: string; lines: number };

export type ReportName = "income-statement" | "balance-sheet" | "credits";
export type ReportChoice = ReportName | "all";
export type ReportFormat = "table" | "csv";

export type ReportOutput = { report: ReportName; text: string };

/** The `money.skipped` events (a non-USD invoice, refund, payout or dispute the handler applied but did not book), counted. */
export type SkippedNonUsd = { inMonth: number; total: number };

export type ReportRun = {
	journal: JournalRun;
	reports: ReportOutput[];
	/** Money the reports leave out because it is not in USD: in the month built, and in all the school's events. */
	skippedNonUsd: SkippedNonUsd;
};

/** Thrown by `reportMonth` when hledger cannot be run: not installed, not on PATH, or failing. The message is one line. */
export interface HledgerErrorConstructor {
	new (message?: string): Error;
	readonly prototype: Error;
}

// ---- Scenario bundles and hash checkpoints (`loadScenarioBundles`, `src/ledger/checkpoints.ts`) ----

/** What the handler answered: the HTTP status, the outcome, and the refusal's reason when there is one. */
export type BundleAnswer = [status: number, outcome: string, reason?: string];

/** One line of a bundle's `deliveries.jsonl`, in delivery order. */
export type BundleStep =
	| {
			kind?: "deliver";
			/** The clock of the delivery (ms); the event carries its own `created`. */
			atMs: number;
			/** A whole Stripe event, as Stripe sent it. */
			event: Record<string, unknown>;
			/** The endpoint that receives it (a school's own); default the bundle's `school`. */
			school?: string;
			/** The caller's fee lookup throws for this delivery (Stripe answers 5xx and retries). */
			feeFails?: boolean;
	  }
	| {
			/** The family service records an erasure after the payments: `subject.erased`, naming the payment objects. */
			kind: "erase";
			atMs: number;
			school?: string;
			family: string;
	  }
	| {
			/** The shipper runs: unshipped outbox rows become batches. `late` puts them in `late-*` files beside a combined day. */
			kind: "ship";
			atMs: number;
			school?: string;
			late?: boolean;
	  }
	| {
			/** A day's batches are combined into its `day.jsonl` (what the log's combiner does); later shipments for it are `late-*`. */
			kind: "combine";
			atMs: number;
			school?: string;
			date: string;
	  }
	| {
			/** The cron books the expiry of every lot of `feature` that has lapsed by `atMs` for the family, once. */
			kind: "lapse";
			atMs: number;
			school?: string;
			family: string;
			feature: string;
	  }
	| {
			/** `atm journal` runs for the month at this point in the story (a closed month a later event must reopen). */
			kind: "journal";
			atMs: number;
			school?: string;
			month: string;
	  };

export type BundleVerdict = "OK" | "KNOWN" | "DISCREPANCY";

/** `scenario.json`: who and what. A generated profile names `profile`, `seed` and `params` instead of deliveries. */
export type BundleScenario = {
	id: string;
	/** The school the deliveries go to unless a step names another. */
	school: string;
	menu: Menu;
	profile?: string;
	seed?: number;
	params?: Record<string, unknown>;
	title?: string;
	/** Which handler path it walks (the matrix doc's column). */
	path?: string;
	/** The environment the events were made in (recorded sandbox deliveries: `test`); default `live`. */
	env?: "test" | "live";
	/** The caller's fee lookup by invoice id; left out, the endpoint has no `paymentFee` at all. */
	fees?: Record<string, number | null>;
	/** Stripe price ids by lookup key, when the events carry ids the generated ones do not. */
	priceIds?: Record<string, string>;
	/** Strings no shipped file or journal may hold (a parent's name and email). */
	personal?: string[];
	/** The books to read when a bundle serves several schools; default `[school]`. */
	schools?: string[];
	/** Where the case sits in the matrix doc's listing (`matrix.csv`); bundles without one come after, by id. */
	order?: number;
};

/** Cents (USD) or credit units, by name (`income:<kind>`, `refunds`, `fees`, `net`, `avail:<holder>:<feature>`, …). A name left out is zero. */
export type BundleNumbers = Record<string, number>;

export type BundleBookExpected = {
	school: string;
	/** Written by hand: what the school's books must say. */
	hand: BundleNumbers;
	/** Today's behaviour where it differs from `hand`: asserted exactly, and must differ from `hand` (it is a discrepancy). */
	pinned?: BundleNumbers;
	/** Expected reconcile differences per month ("kind object id"); a month listed here is reconciled. */
	reconcile: Record<string, string[]>;
	/** The `money.skipped` markers the log holds, by reason, per month. */
	skipped?: Record<string, Record<string, number>>;
	/** Also print the monthly income statement (a case that crosses a month). */
	monthly?: boolean;
	handMonthly?: Record<string, BundleNumbers>;
	/** What Stripe's lists hold that is not this school's (another product's invoice on a shared account). */
	foreign?: { balance: number; fees: number };
};

/** `expected.json`: hand-written numbers, never computed. */
export type BundleExpected = {
	verdict: BundleVerdict;
	/** The ids of the matrix doc's discrepancies this bundle pins (empty for OK). */
	discrepancies?: string[];
	/** The handler's answer to each `deliver` step, in order. */
	answers: BundleAnswer[];
	books: BundleBookExpected[];
	/** How the hand numbers were worked out, and which discrepancy each pin marks: prose for a reader, never compared. */
	notes?: string[];
};

export type CheckpointStage =
	| "H1"
	| "H2"
	| "H3"
	| "H4"
	| "H5"
	| "H6"
	| "H7"
	| "H8";

/** A stage's golden: one hash, or one per KPI channel (H6, H7). */
export type StageHash = string | Record<string, string>;

/** `hashes.json`. Internal to tests, CI and the job: never shown to a viewer. */
export type BundleHashes = { version: 1 } & Partial<
	Record<CheckpointStage, StageHash>
>;

export type ScenarioBundle = {
	id: string;
	dir: string;
	scenario: BundleScenario;
	steps: BundleStep[];
	stripeSide: Record<string, ReconcileStripe>;
	expected: BundleExpected;
	hashes: BundleHashes;
};

/** A canonical text and its sha256: what a checkpoint is compared by, and what a diff is read from. */
export type Checkpoint = { canonical: string; hash: string };

/** A bundle step as the H1 canonicalizer reads it; only the clock (`atMs`, written out as an ISO instant) is touched. */
export type CheckpointStep = { atMs: number } & Record<string, unknown>;

export type MutationCheckpointInput = {
	/** What the handler answered to each delivery, in order: `[status, outcome, reason?]`. */
	answers: readonly unknown[];
	/** The stored input of each delivery in the order it was applied (event id, type, outcome, revisions, fee). */
	decisions: readonly unknown[];
	/** Every engine row the handler wrote, in order (subject, table, row id, operation, data). */
	mutations: readonly unknown[];
};

export type OutboxCheckpointRow = {
	id: string;
	idem: string;
	date: string;
	/** The event's canonical line, as the outbox stores it. */
	body: string;
};

/** A school's folder as `{ path relative to schools/<school>: text }`. */
export type FileTree = Readonly<Record<string, string>>;

/** A KPI channel's base aggregates: each base KPI id (`<id>` or `<id>:<dimension>`) to its whole-number value per period. */
export type ChannelReport = Readonly<
	Record<string, Readonly<Record<string, number>>>
>;

export type CheckpointKpiRow = {
	kpiId: string;
	period: string;
	value: number;
};

/** What `atm reconcile` found for one month, as `reconcile` returns it (only the fields that carry a verdict are read). */
export type ReconcileVerdictInput = {
	differences: readonly {
		kind: string;
		object: string;
		id: string | null;
		period: string;
		stripe: unknown;
		log: unknown;
	}[];
	counts: unknown;
	ignored: unknown;
	skipped: unknown;
};
