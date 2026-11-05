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
	prices: TierPrice[];
	grants: MenuGrant[];
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
	/** The gift kind on the Stripe price's metadata (`b4u_gift`), when the invoice line shows it. The menu's add-on says the same. */
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
	/** Our metadata from checkout (`b4u_school`, `family_id`, `tier_id`, `profile_id`, `menu_version`, …). */
	metadata: Record<string, string>;
};

export type BillingRefund = {
	source: FactSource;
	id: string;
	/**
	 * The invoice the refunded charge paid. Stripe's charge (API 2025-10-29.clover) does not name it: the mapping gives
	 * the payment intent, and `handleStripeEvent` fills this from the caller's `invoiceIds`.
	 */
	invoiceId?: string | null;
	paymentIntentId?: string | null;
	chargeId: string;
	amount: number;
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
	tierId: string | null;
	interval: Interval | null;
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
	/** Every invoice seen, by id: a replayed invoice finds its record and decides nothing. */
	invoices: Record<string, InvoiceRecord>;
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
};

/** A Checkout Session's parameters (nested, Stripe's shape); `line_items` name prices by lookup key until `withPriceIds`. */
export type CheckoutParams = {
	mode: "subscription";
	client_reference_id: string;
	success_url: string;
	cancel_url: string;
	line_items: { lookupKey: string; quantity: 1 }[];
	metadata: Record<string, string>;
	subscription_data: { metadata: Record<string, string> };
	allow_promotion_codes?: true;
};

export type CheckoutRefusal =
	| { ok: false; reason: "tier_not_found" }
	| { ok: false; reason: "addon_not_found"; addonId: string }
	| { ok: false; reason: "addon_interval_mismatch"; addonId: string };

export type CheckoutResult =
	| { ok: true; params: CheckoutParams }
	| CheckoutRefusal;

export type CheckoutParamsWithPrices = Omit<CheckoutParams, "line_items"> & {
	line_items: { price: string; quantity: 1 }[];
};

// ---- Membership status ----

/**
 * - `active`: paid up (Stripe `active`, `trialing`).
 * - `past_due`: a renewal failed; Stripe is retrying (`past_due`) or gave up on collecting (`unpaid`).
 * - `payment_incomplete`: the first payment is not finished (`incomplete`).
 * - `ended`: over (`canceled`, `incomplete_expired`).
 * - `inactive`: paused (`paused`).
 */
export type MembershipStatus =
	| "active"
	| "past_due"
	| "payment_incomplete"
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
};

export type MappingTarget =
	| "BillingInvoice"
	| "BillingRefund"
	| "BillingDispute"
	| "SubscriptionFact";

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
	| SubscriptionFact;

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
	/** The price's interval (null: one-time), likewise not on the line. */
	interval?: Interval | null;
	/** An add-on that is a gift certificate. */
	gift?: GiftKind;
};

// ---- One entry point for a Stripe event ----

export type StripeEventInput = {
	/** The raw Stripe event, as received (verified and deduplicated by the caller). */
	event: unknown;
	/** The stored input event's id: it becomes `cause` on every decision event and the id of every command. */
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
