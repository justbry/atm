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
	| "policy.published";

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
	/** Stripe fee in cents, on `payment.succeeded`. */
	fee?: number;
	/** Income account tail on `payment.succeeded`: `membership:sparkle-2` -> `income:billing:membership:sparkle-2`. */
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
	amount: number;
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
	/** `firstTimeOnly`: the code works once per customer (Stripe `restrictions[first_time_transaction]`). */
	| {
			op: "promotion_code.ensure";
			code: string;
			couponId: string;
			firstTimeOnly: boolean;
			idempotencyKey: string;
	  }
	| { op: "promotion_code.deactivate"; code: string; idempotencyKey: string };

// ---- Menu validation ----

export type MenuValidation =
	| { ok: true; menu: Menu }
	| { ok: false; problems: string[] };

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
};

/** Why a checkout was refused. `quantity_not_offered`: `quantity` is not one of the tier's `quantities` (not 1, for a tier without them). */
export type CheckoutRefusal =
	| { ok: false; reason: "tier_not_found" }
	| { ok: false; reason: "addon_not_found"; addonId: string }
	| { ok: false; reason: "addon_interval_mismatch"; addonId: string }
	| { ok: false; reason: "quantity_not_offered"; quantity: number };

export type CheckoutResult =
	| { ok: true; params: CheckoutParams }
	| CheckoutRefusal;

export type CheckoutParamsWithPrices = Omit<CheckoutParams, "line_items"> & {
	line_items: [
		{ price: string; quantity: number },
		...{ price: string; quantity: 1 }[],
	];
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

export type FieldType = "string" | "int" | "seconds" | "bool" | "map";

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
};

export type MappingTarget =
	| "BillingInvoice"
	| "BillingRefund"
	| "BillingDispute"
	| "SubscriptionFact"
	| "InvoicePaymentFact";

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
	| InvoicePaymentFact;

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
};

/** Why an event was set aside: nothing was decided and nothing is to be written. Keep the event and retry after the cause is fixed. */
export type StripeEventRefusal = {
	reason:
		| "unknown_mapping"
		| "bad_event"
		| "missing_metadata"
		| "unmatched_line"
		| "unmatched_invoice"
		| "unknown_subscription"
		| "rejected";
	message: string;
};

export type StripeEventResult = {
	/** One write for the subject, or null when the event changes nothing (replayed, not about credits). */
	rowChanges: RowChanges | null;
	/** The decision events (credit.*), each with `cause` = the event id and the menu, policy and mapping labels. */
	events: AtmEvent[];
	refused?: StripeEventRefusal;
};

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
};

export type WebhookRequest = {
	/** The raw body, as received. Do not parse and re-serialize it before this. */
	payload: string;
	/** The `Stripe-Signature` header. */
	signatureHeader: string;
};

/**
 * What the handler did with a delivery; `handleStripeWebhook`'s header lists the status for each. Among them:
 * `school_mismatch` (422) is an event for a school other than `WebhookDeps.schoolId`; `ambiguous_payment` (422) is a
 * refund or dispute whose payment intent and charge were indexed under different subjects.
 */
export type WebhookOutcome =
	| "applied"
	| "duplicate"
	| "ignored"
	| "busy"
	| "bad_signature"
	| "bad_request"
	| "unmatched_payment"
	| "unmatched_invoice"
	| "unknown_school"
	| "school_mismatch"
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
		/** `applied`: how many events went to the outbox and whether rows changed. */
		events?: number;
		wroteRows?: boolean;
	};
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
