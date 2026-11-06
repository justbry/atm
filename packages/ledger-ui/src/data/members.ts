/** The Members tab contract (slice S4, orchestrator, protected): what the Reader returns for the roster, the balance
 * bars, the member drawer and the shared per-member ⋯ menu, and every Writer call those actions make. Field names
 * follow the buzz-school briefs (`plans/ledger-ui/design/buzz-school-briefs.md`): brief A item 1 (members list), A4
 * (capabilities), B4 (finance grants), C (money writes) and D (booking writes). A field the briefs do not have is
 * marked "not in brief": S8 must get it from buzz-school or derive it in the adapter. The fixture values are
 * `src/fixtures/members.ts`, generated from the mockup's schools (atm dev 742105b64, frozen); `test/golden/S4.json` holds what the UI shows.
 *
 * The Reader and the Writer of `src/data/reader.ts` and `writer.ts` gain `MembersReader` and `MembersWriter`. */

/** The audience a person reads the school's books at: `Audience` of `src/data/disclosure.ts` (the S7 gate, spec
 * v2). Declared here until that file is on this branch; then this line becomes `import type { Audience } from
 * "./disclosure.ts"`. */
type Audience = "public" | "member" | "governance" | "finance" | "owner";

/** The hash parameter `as=` (shared contract): the audience being viewed. The Members tab shows the roster to
 * `finance` and `owner` only; below them it renders `membersLock` instead and no row, strip or table (never an empty
 * table or a 0). Viewing as anyone but yourself is a preview (mockup `pvLock`): every write control is disabled with
 * the title `previewLock` ("View in Stripe", "Resend receipt", "View as member" and "Download CSV" stay as they are). */
export const membersVisibleTo: readonly Audience[] = ["finance", "owner"];
export const previewLock = "Exit preview to act";

/** What a viewer without finance sees in place of money per person (mockup `data-hid="no_grant"`): the strip's
 * income, payment amounts and history amounts. No `as=` value reaches it today (finance and owner both see money;
 * the mockup's "Admin" preview does), so the golden file does not check it. */
export const financeOnly = {
	text: "Finance only",
	title: "Finance admins and the owner see money",
} as const;

/** The lock panel the Members tab shows below `finance` (mockup `#mlock`, `data-lock="admins_only"`): who may see the
 * roster, and that it is never published (no "when"). */
export const membersLock = {
	code: "admins_only",
	title: "Owners and admins see the roster",
	text: "Members see only themselves and their family, in the member portal. To see one person's portal, an admin uses View as member on their row.",
} as const;

// ---- Brief A item 1: GET /school-admin/schools/<id>/billing/members-list

/** A credit unit, singular and plural (brief A1 `unit:{one,other}`), e.g. `{ one: "session", other: "sessions" }`. */
export type CreditUnit = { one: string; other: string };

/** One live lot group of a membership (brief A1 `balances[]`). The bar draws used, held and available out of
 * `granted`; used is `granted - available - held` (never below 0). */
export type MemberBalance = {
	featureId: string;
	featureName: string;
	unit: CreditUnit;
	available: number;
	held: number;
	/** Unix seconds, or null when nothing is left to expire (shown "—"). */
	expiresAt: number | null;
	/** Not in brief A: the credits granted for the current period, the bar's whole width and the "of N". */
	granted: number;
};

export type MembershipStatus =
	| "active"
	| "past_due"
	| "canceled"
	| "trialing"
	| "incomplete"
	| "unpaid";

/** One membership (brief A1 `members[]`). `key` equals the atm customer id `family:<familyId>`; a family with
 * several memberships (the Wu family) repeats the key and tells them apart by `profileId`. */
export type Member = {
	key: `family:${string}`;
	familyId: string;
	/** The profile the membership is for: equals `Person.id` of the person it belongs to. */
	profileId: string | null;
	/** The nickname, else the family name. */
	name: string;
	tierId: string;
	tierName: string;
	quantity: number;
	interval: "month" | "year";
	status: MembershipStatus;
	/** Unix seconds. */
	currentPeriodEnd: number;
	cancelAtPeriodEnd: boolean;
	menuVersion: number;
	balances: MemberBalance[];
	/** Not in brief A: the id brief C's credit adjust and the membership writes name. */
	membershipId: string;
};

/** Brief A1's answer. Page cap 100; the fixtures fit on one page (`nextCursor` null). */
export type MembersPage = { members: Member[]; nextCursor: string | null };

export type MembersQuery = {
	schoolId: string;
	status?: MembershipStatus;
	cursor?: string;
	limit?: number;
};

// ---- People: one row per person, plan holders and role holders (not in the briefs as one list)

/** A person's role at the school, apart from any plan (mockup `R`). */
export type Role = "owner" | "admin" | "member";

/** Why a plan holder needs attention (mockup `reasons`), worst first. Labels: `out` "Out of <unit.other>", `low`
 * "Low" (available under 20% of granted), `needs_outcome` "Needs outcome" (a confirmed booking that started),
 * `inside_cutoff` "Inside cutoff" (a held booking inside its cutoff). The sort score is 2 per `bad`, 1 per `warn`;
 * a booking reason carries its booking and drops while a write on that booking is pending. */
export type AttentionReason = {
	kind: "out" | "low" | "needs_outcome" | "inside_cutoff";
	tone: "bad" | "warn";
	bookingId: string | null;
};

/** One row of the Members table. Plan holders join their membership by `Member.profileId === Person.id`; a role
 * holder with no plan has no membership and shows "No plan" / "no plan", never 0. Rows sort by attention score
 * (highest first), then role (owner, admin, member), then name. */
export type Person = {
	/** The id the row shows (mono) and the drawer route uses (`member=<id>`). */
	id: string;
	name: string;
	role: Role;
	/** Brief B4: an admin's finance grant (owners have it implicitly and show no Finance chip). */
	financeGrant: boolean;
	planHolder: boolean;
	/** The atm customer key of the person's family (`Member.key`), or null for a role holder with no plan. */
	memberKey: `family:${string}` | null;
	/** Set for a person in a family of several (the family chip, title "Family key <key>"); null otherwise. */
	family: {
		key: string;
		label: string;
		relation: "adult" | "teen" | "child";
	} | null;
	/** The audience the person reads the books at (spec v2 "A person's audiences", computed live by the server). */
	audience: Audience;
	/** Why, as the server words it. The Audience chip reads "Audience: <name>" ("Audience: Owner · everything" for
	 * the owner; names Public, Member, Governance, Finance admin) with the title "Audience: <reason>". */
	audienceReason: string;
	/** The signed-in person ("(you)"). */
	you: boolean;
	attention: AttentionReason[];
};

/** What the strip and the expiring-gifts note above the table show (not in the briefs). The strip's income is
 * `membersIncome` for the period the shell's period control shows ("income · <period label>"). */
export type MembersSummary = {
	unit: CreditUnit;
	/** Sum of available and held over every live lot ("<unit.other> outstanding (incl. held)"). */
	creditsOutstanding: number;
	currency: string;
	/** Unredeemed gift codes that expire within 30 days, masked as the Promos tab masks them. */
	expiringGifts: Array<{ maskedCode: string; expiresOn: string }>;
	/** The school's booking rules the release preview quotes (Settings "Rules in force"). */
	bookingRules: {
		lateCancel: "spend" | "release";
		noShow: "spend" | "release";
	};
};

// ---- Brief A item 4: GET .../ledger/capabilities

export type CapabilityAction =
	| "refund"
	| "invoice"
	| "adjustCredits"
	| "releaseBooking"
	| "recordOutcome"
	| "cancelMembership"
	| "changeQuantity"
	| "switchTier"
	| "publishMenu"
	| "createPromo";

/** Why an action is not allowed: `owner_only` (shown "Owner role needed" in the menu, "Refunds need the owner role
 * in this school" on the drawer button), `stripe_permission_missing` with the permission (shown "The Stripe key lacks
 * <permission>. Fix it in Settings."), `not_built`. */
export type Capability =
	| { allowed: true }
	| {
			allowed: false;
			reason: "owner_only" | "not_built";
	  }
	| {
			allowed: false;
			reason: "stripe_permission_missing";
			permission: "Invoices (write)" | "Refunds (write)";
	  };

export type Capabilities = {
	role: "owner" | "admin";
	stripeConnected: boolean;
	actions: Record<CapabilityAction, Capability>;
};

// ---- Brief B item 4: GET/POST/DELETE /school-admin/schools/<id>/finance-grants (owner only)

export type FinanceGrant = {
	subject: string;
	grant: "finance";
	grantedBy: string;
	/** Unix seconds. */
	grantedAt: number;
	revokedAt: number | null;
};

// ---- The member drawer (not in the briefs as one route: brief A2 bookings, the payment history, the ledger)

/** An upcoming booking of the member (brief A2's booking, reduced to what the drawer row shows; S2's booking type
 * replaces it when both exist). `startsAt` is `YYYY-MM-DDTHH:MM` in the school's time zone. */
export type MemberBooking = {
	id: string;
	service: string;
	startsAt: string;
	hosts: string[];
	/** Credits held for it (0 when free or paid). */
	creditsHeld: number;
	/** Not in brief A2 (no billing fields yet): the amount paid in minor units, or null. */
	paidCents: number | null;
	state: "requested" | "confirmed";
	/** The series label ("weekly · 3 left"), or null. */
	series: string | null;
	cutoffMinutes: number;
};

/** One row of the member's payment history (newest first, the drawer shows 5 and "Show all payments (N)"). */
export type PaymentRow = {
	/** `YYYY-MM-DD`. */
	date: string;
	description: string;
	/** Signed minor units (a refund is negative). */
	amountCents: number;
	status: "Paid" | "Open" | "Refunded" | "Partly refunded" | "Failed";
	invoiceId: string | null;
	paymentId: string | null;
};

/** A payment the refund picker offers (brief C1 `paymentIntentId`), with what was already refunded. */
export type RefundablePayment = {
	paymentIntentId: string;
	description: string;
	amountCents: number;
	refundedCents: number;
	kind: "membership" | "booking" | "gift";
	bookingId: string | null;
};

/** A ledger event of the member (newest first, as given; the drawer shows 5). Its label is `eventLabels[type]` with
 * `{U}` the capitalised unit and `{u}` the unit, except a booking payment ("Booking payment") and a redeemed gift
 * ("Gift redeemed"). The line reads `<label> <credits or amount> <text>[ <bookingId>][ promo <promo>]`, then
 * `<Mon D> · <source>`; credits are signed (`+24`, `−1` with U+2212), an amount is signed with two decimals. */
export type HistoryEvent = {
	/** `YYYY-MM-DDTHH:MM` in the school's time zone. */
	at: string;
	type: string;
	kind: string | null;
	text: string;
	credits: number | null;
	amountCents: number | null;
	bookingId: string | null;
	/** The promo code as the Promos tab masks it, or null. */
	promo: string | null;
	source: string;
};

export const eventLabels: Readonly<Record<string, string>> = {
	"payment.succeeded": "Payment",
	"credit.granted": "{U} granted",
	"credit.spent": "{U} used",
	"credit.held": "{U} held",
	"credit.released": "Hold released",
	"credit.forfeited": "{U} forfeited",
	"credit.depleted": "Out of {u}",
	"payout.paid": "Payout",
	"payment.refunded": "Refund",
	"credit.refunded": "{U} returned",
	"credit.expired": "{U} expired",
	"credit.adjusted": "Adjustment",
	"booking.outcome": "Attendance recorded",
	"membership.changed": "Plan change",
	"role.changed": "Role change",
};

export type MemberDetail = {
	bookings: MemberBooking[];
	payments: PaymentRow[];
	refundable: RefundablePayment[];
	history: HistoryEvent[];
};

/** What "Send invoice…" offers (brief C3: one published add-on), with the label the select shows. */
export type InvoiceItem = {
	addonId: string;
	label: string;
	priceCents: number;
};

/** What "Switch plan…" offers: the published tiers, price per unit of quantity, and the quantities sold (null for a
 * tier sold in one size). */
export type SwitchTier = {
	id: string;
	name: string;
	monthlyCents: number;
	quantities: number[] | null;
};

export type MembersReader = {
	/** Brief A1. */
	members(query: MembersQuery): Promise<MembersPage>;
	/** Every person of the school: plan holders and role holders, in the order the server lists them. */
	people(query: { schoolId: string }): Promise<Person[]>;
	membersSummary(query: { schoolId: string }): Promise<MembersSummary>;
	/** Income (mockup `calc(...).inc`: memberships plus bookings less discounts) in minor units of the summary's
	 * currency, for `from` to `to` (`YYYY-MM-DD`, inclusive). Finance and owner only. */
	membersIncome(query: {
		schoolId: string;
		from: string;
		to: string;
	}): Promise<number>;
	/** Brief A4. */
	capabilities(query: { schoolId: string }): Promise<Capabilities>;
	/** Brief B4 (owner only); the chips read `Person.financeGrant`. */
	financeGrants(query: { schoolId: string }): Promise<FinanceGrant[]>;
	/** The drawer of one person (empty lists for a role holder with no plan). */
	memberDetail(query: {
		schoolId: string;
		personId: string;
	}): Promise<MemberDetail>;
	invoiceItems(query: { schoolId: string }): Promise<InvoiceItem[]>;
	switchTiers(query: { schoolId: string }): Promise<SwitchTier[]>;
};

// ---- Writer calls. Every call names its school; the S8 adapter adds the CSRF token and the Idempotency-Key, so
// the arguments are exactly what the golden file's `writes` list. While a call is pending the UI keeps its modal open
// with the confirm button disabled and `aria-busy="true"` (or the clicked button, when there is no modal); when it
// resolves the modal closes, the toast shows and the pending effect appears (`test/golden/S4.json` notes).

/** Brief C1 `POST .../billing/refunds`. `reason` is Stripe's; the mockup asks only for the note. */
export type RefundRequest = {
	schoolId: string;
	paymentIntentId: string;
	amountCents: number;
	reason: "requested_by_customer";
	note: string;
};
export type RefundResult = {
	refundId: string;
	status: "pending" | "succeeded" | "failed";
	refundedCents: number;
	remainingCents: number;
};

/** Brief C2 `POST .../billing/credits/adjust`. `amount` is signed; a gift is positive; the note has 3 or more
 * characters. */
export type AdjustCreditsRequest = {
	schoolId: string;
	membershipId: string;
	featureId: string;
	amount: number;
	kind: "goodwill" | "gift" | "correction";
	note: string;
};

/** Brief C3 `POST .../billing/invoices`; `memo` is left out when empty. */
export type InvoiceRequest = {
	schoolId: string;
	familyId: string;
	addonId: string;
	memo?: string;
};
export type InvoiceResult = { invoiceId: string; status: "open" };

/** Brief D3 `POST .../bookings/<bookingId>/cancel`: "Release a booking…" and "Release hold". The mockup asks for no
 * reason, so the UI sends `releaseReason`; `waiveCutoff` is the "Waive the late-cancel forfeit" box (false when the
 * box is not shown). */
export type CancelBookingRequest = {
	schoolId: string;
	bookingId: string;
	reason: typeof releaseReason;
	waiveCutoff: boolean;
};
export const releaseReason = "Released by an admin";

/** Brief D2 `POST .../bookings/<bookingId>/outcome` (the drawer's "Confirm attended" and "No-show"). */
export type RecordOutcomeRequest = {
	schoolId: string;
	bookingId: string;
	state: "attended" | "no_show";
};
export type RecordOutcomeResult = { creditEffect: "not_wired" };

/** Brief B4 `POST` / `DELETE .../finance-grants` (owner only, PIN and step-up in S8). */
export type FinanceGrantRequest = { schoolId: string; subject: string };

/** Not in the briefs: "Make admin" (`role: "admin"`), "Remove admin" and "Remove owner role" (`role: "member"`).
 * Owner only. Guards the UI applies before calling (and the server again): the last owner cannot be removed ("Last
 * owner: add another owner first"), an owner cannot demote themselves ("Owners can't demote themselves"). A role
 * change applies at the person's next sign-in refresh (the ledger token lives 5 minutes). */
export type ChangeRoleRequest = {
	schoolId: string;
	personId: string;
	role: "admin" | "member";
};

/** Not built in buzz-school (brief A4 `switchTier`, `cancelMembership` are `not_built` there today; the mockup
 * enables them). A switch takes effect at the renewal; a cancel is at period end or now (now needs a reason of 3 or
 * more characters; `reason` is left out when empty). Resume undoes a cancel (capability `cancelMembership`). */
export type SwitchTierRequest = {
	schoolId: string;
	membershipId: string;
	tierId: string;
	quantity: number;
};
export type CancelMembershipRequest = {
	schoolId: string;
	membershipId: string;
	at: "period_end" | "now";
	reason?: string;
};
export type ResumeMembershipRequest = {
	schoolId: string;
	membershipId: string;
};

/** The answer of a write that has no answer in the briefs. */
export type Accepted = { accepted: true };

export type MembersWriter = {
	refund(request: RefundRequest): Promise<RefundResult>;
	adjustCredits(request: AdjustCreditsRequest): Promise<Accepted>;
	sendInvoice(request: InvoiceRequest): Promise<InvoiceResult>;
	cancelBooking(request: CancelBookingRequest): Promise<Accepted>;
	recordOutcome(request: RecordOutcomeRequest): Promise<RecordOutcomeResult>;
	grantFinance(request: FinanceGrantRequest): Promise<Accepted>;
	revokeFinance(request: FinanceGrantRequest): Promise<Accepted>;
	changeRole(request: ChangeRoleRequest): Promise<Accepted>;
	switchTier(request: SwitchTierRequest): Promise<Accepted>;
	cancelMembership(request: CancelMembershipRequest): Promise<Accepted>;
	resumeMembership(request: ResumeMembershipRequest): Promise<Accepted>;
};

/** The fixture of one school (`src/fixtures/members.ts`): what each `MembersReader` call returns for it. */
export type MembersFixture = {
	page: MembersPage;
	people: Person[];
	summary: MembersSummary;
	capabilities: Capabilities;
	financeGrants: FinanceGrant[];
	/** Income by calendar month of 2026 (`YYYY-MM`); the fixture Reader sums the months a period covers. */
	incomeByMonth: Record<string, number>;
	details: Record<string, MemberDetail>;
	invoiceItems: InvoiceItem[];
	switchTiers: SwitchTier[];
};
