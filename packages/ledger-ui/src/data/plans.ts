/**
 * The Plans contract (slice S3; orchestrator file, protected for builders). What the Plans tab reads and writes, in the
 * shapes of the buzz-school routes it will call in S8 (no invented routes):
 *
 * - reads, brief A item 3 (`packages/family-service/src/routes/ledger-admin.ts`):
 *   `GET /school-admin/schools/<id>/billing/menu/versions` and `GET .../billing/menu/versions/<n>`;
 * - counts, `GET /school-admin/schools/<id>/billing/members` (per tier) plus the members list (quantities) and atm's
 *   ledger (collected), joined by the S8 adapter into `PlanSummary`;
 * - writes, the existing menu save and publish (`src/routes/school-billing.ts`):
 *   `POST /school-admin/schools/<id>/billing/menu` with the whole `Menu` as its body (an unpublished draft is edited in
 *   place; editing a published menu starts the next version) and `POST .../billing/menu/publish` with no body.
 *
 * The draft and the live version. The live version is the newest version with `publishedAt` set; the draft is the
 * newest version when its `publishedAt` is null (buzz-school keeps at most one, edited in place). With no unpublished
 * version the draft starts as a copy of the live menu; with no version at all it starts empty, from the school's
 * currency (lower case) and time zone and `PlanSummary.features`. "Changes" are the draft compared with the live menu,
 * item by item (the mockup's `diff`): a draft equal to the live menu has no changes and shows no draft badge.
 *
 * One draft, three views. Edit (table and drawer), Preview (the purchase page) and Code (YAML) show and change the SAME
 * draft: a change made in one is what the other two show next. The UI saves the draft with `saveMenu` whenever it
 * changes and has no problems (Save to draft in the drawer, a Code edit once applied, Discard draft, Reset to
 * published), always with the whole menu; a draft with problems stays on screen, unsaved, until fixed. Publishing calls
 * `publishMenu` and then shows the draft as the new live version (the version number plus one) without re-reading.
 *
 * YAML round trip (Code mode). The text is the mockup's layout (`kEmit`/`kParse`, mockup.html "Plans as YAML") over this
 * `Menu`, and `parse(emit(menu))` equals `menu` for every fixture:
 *
 * ```yaml
 * # <school name>: plans. Edit here, then Review and publish.
 * # Each plan is keyed by its id: rename a plan by changing name, not id.
 * # Lines that start with # stripe: are read-only and come back when you Format.
 * version: 3                 # the live version (0 before the first publish); read-only
 * currency: USD              # Menu.currency upper-cased; read-only (Settings)
 * timeZone: America/Denver   # read-only (Settings)
 *
 * memberships:               # `memberships: []` when there are none
 *   # stripe: product · month price · year price
 *   - id: sparkle
 *     name: Sparkle
 *     blurb: A little time, every month
 *     public: true
 *     audience: governance   # only when the audience is not member
 *     prices:                # left out when the tier has no price
 *       month: 32.5          # major units: amount / 100
 *       year: 350
 *     quantities: [1, 2, 4]  # only when set
 *     grants:
 *       - feature: sessions  # a featureId of the menu
 *         units: 8           # amount
 *         every: month
 *         rollover: 1        # rollover.months, 0 when there is none
 *
 * packs:                     # `packs: []` when there are none
 *   # stripe: product · price
 *   - id: pack8
 *     name: Top-up pack
 *     price: 40
 *     every: once
 *     grants: (as above)
 * ```
 *
 * A scalar is written plain when it matches `/^[A-Za-z0-9][A-Za-z0-9 .,;!?()/&+_-]*$/`, has no trailing space, is not a
 * YAML word (true, false, null, yes, no, on, off, y, n) and is not a number; otherwise as a JSON string. The text ends
 * with a newline. A `# stripe:` line lists what the LIVE version has on Stripe for that item (`MenuVersionBody.stripe`,
 * keys `t:<id>`, `t:<id>:<interval>`, `a:<id>`, `a:<id>:<every>`), never an id: `product`, then `month price`,
 * `year price` (tiers) or `price` (packs), joined by ` · `; an item with no product there reads
 * `# stripe: created when you publish`. Comments are not kept (Format drops them and writes the `# stripe:` lines
 * again); anchors, aliases, tags, merge keys, block text, inline maps, tabs, unknown keys and a second document are
 * refused with the mockup's messages, and a refused text leaves the draft unchanged. Amounts parse back as cents and
 * must be whole cents. `rollover.max` is not offered (the mockup: "A cap on rollover isn't enforced yet") and a Code
 * edit keeps the draft's value. A pack's grants keep their stored `every` (buzz-school grants a `once` pack's grants on
 * its first invoice whatever their interval; the fixtures store `month`).
 */

/** How often a tier is billed or a grant refills (buzz-school `Interval`). */
export type MenuInterval = "month" | "year";

/** What a tier or pack gives: `amount` of one feature (buzz-school `Grant`). */
export type MenuGrant = {
	featureId: string;
	amount: number;
	every: MenuInterval;
	/** Months past the period end the credits stay usable; `max` is stored but not enforced by buzz-school. */
	rollover?: { months: number; max?: number };
};

/** A price of a tier, in minor units of `Menu.currency`. */
export type MenuPrice = { interval: MenuInterval; amount: number };

/** The audience a tier names: what its members see of the school's books (mockup disclosure v2, the drawer's Audience
 * select and `K_AUD`). Absent means `member`; finance and owner are never a tier's audience. Not yet in buzz-school's
 * Menu: S8 sends it once the family service takes it. */
export type MenuAudience = "member" | "governance" | "public";

/** A membership (buzz-school `MenuTier`, plus the optional audience). */
export type MenuTier = {
	id: string;
	name: string;
	blurb: string;
	/** On sale. A non-public tier is not sold and not put on Stripe; its current members keep it. */
	public: boolean;
	/** At most one per interval. Empty only for a tier that is not for sale (the mockup's Board tier). */
	prices: MenuPrice[];
	grants: MenuGrant[];
	/** The counts a buyer may pick; prices and grant amounts are then per unit. */
	quantities?: number[];
	audience?: MenuAudience;
};

/** A pack or add-on (buzz-school `addons`). It has no `public` flag: every pack in a published menu is on sale. */
export type MenuAddon = {
	id: string;
	name: string;
	price: { amount: number; every: "once" | MenuInterval };
	grants: MenuGrant[];
};

/** What the plans give, with the unit words the UI writes ("8 sessions"). */
export type MenuFeature = {
	id: string;
	name: string;
	unit: { one: string; other: string };
};

/** A version's whole menu (buzz-school `Menu`). Amounts are minor units of `currency`. */
export type Menu = {
	/** ISO 4217, lower case. */
	currency: string;
	/** IANA zone. */
	timeZone: string;
	features: MenuFeature[];
	tiers: MenuTier[];
	addons: MenuAddon[];
};

/** One row of the versions list (brief A item 3). Times are unix seconds, as buzz-school writes them. */
export type MenuVersion = {
	version: number;
	publishedAt: number | null;
	savedAt: number;
};

/** `GET .../billing/menu/versions`: newest first. */
export type MenuVersions = { versions: MenuVersion[] };

/** `GET .../billing/menu/versions/<n>`: the whole body, non-public tiers included, and which menu keys have a Stripe
 * id (never the ids). */
export type MenuVersionBody = MenuVersion & {
	menu: Menu;
	stripe: { products: string[]; prices: string[]; portal: boolean };
};

/** Members of one tier of the live menu. */
export type PlanTierCount = {
	tierId: string;
	/** Live memberships not ending at the period end. */
	active: number;
	/** Live memberships set to end at the period end ("+1 ending"). */
	ending: number;
	/** The quantities of the `active` memberships, summed. */
	activeUnits: number;
	/**
	 * The Monthly column: what the `active` memberships bring in per month at the prices they bought (a member keeps
	 * the version they bought), in minor units, summed by the server. null when the server has no figure (a tier with
	 * no monthly price): the UI shows "—", never 0, and never multiplies a draft price.
	 */
	monthlyMinor: number | null;
};

/** What the Plans tab shows besides the menu. */
export type PlanSummary = {
	/** "Active members": the `active` of every tier, summed by the server. */
	activeMembers: number;
	/** "Ending soon": the `ending` of every tier, summed by the server. */
	endingSoon: number;
	/** "Collected in <month>": gross collected in one month (`YYYY-MM`), minor units; null when nothing is sold yet. */
	collected: { period: string; amount: number } | null;
	tiers: PlanTierCount[];
	/** The features a new draft grants from when the school has no menu version yet. */
	features: MenuFeature[];
	/** Get started, step 1 (brief A capabilities `stripeConnected`). */
	stripeConnected: boolean;
	/** Get started, step 4 ("Share your purchase link"): the mockup's own state; buzz-school has no source for it yet. */
	purchaseLinkShared: boolean;
};

/** The Reader methods S3 adds (the builder makes `Reader` extend this). */
export interface PlansReader {
	/** The school's menu versions, newest first; `{ versions: [] }` before the first save. */
	menuVersions(schoolId: string): Promise<MenuVersions>;
	/** One version's body, or undefined when the school has no such version. */
	menuVersion(
		schoolId: string,
		version: number,
	): Promise<MenuVersionBody | undefined>;
	/** Counts, collected and Get started facts for the Plans tab. */
	planSummary(schoolId: string): Promise<PlanSummary>;
}

/** The Writer methods S3 adds (the builder makes `Writer` extend this). Each resolves once the server has taken the
 * change; the fixture Writer records `{ method, args }` exactly as called. */
export interface PlansWriter {
	/** `POST /school-admin/schools/<id>/billing/menu`: the whole draft. */
	saveMenu(schoolId: string, menu: Menu): Promise<void>;
	/** `POST /school-admin/schools/<id>/billing/menu/publish`: publishes the saved draft. The family PIN the review asks
	 * for only enables the button here; buzz-school checks the PIN on the session, so S8 opens it before this call. */
	publishMenu(schoolId: string): Promise<void>;
}

/** Tiers and packs: buzz-school's menu limits (`src/school-billing/menu.ts`), drawn as "3 of 4" and "2 of 6". Grants
 * per plan: the mockup's drawer limit ("Add another" off at 3; buzz-school allows 12). */
export const planLimits = { tiers: 4, addons: 6, grants: 3 } as const;
