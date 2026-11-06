import type { BooksLevel, HiddenKind } from "./kpi-document.ts";

/** The clock the UI runs on (protocol §3): the UI never reads the system time. `today` is `YYYY-MM-DD`, `now` is
 * `YYYY-MM-DDTHH:MM`. */
export type Clock = { today: string; now: string };

/** A school the session may open, as the switcher and the tabs row show it. */
export type School = {
	id: string;
	name: string;
	/** IANA time zone, e.g. `America/Denver`. */
	timeZone: string;
	/** ISO 4217 code, e.g. `USD`. */
	currency: string;
	role: "owner" | "admin";
	/** The signed-in person's books level here (mockup `bkDefault`): the Dashboard opens at it. */
	booksLevel: BooksLevel;
	/** The month the Dashboard opens on at the month grain (the mockup opens its fixture school on Jun); without it,
	 * the last period shown. */
	dashboardOpensOn?: string;
	/** The ledger shipper is behind; `lagMinutes` says by how much. */
	stale: boolean;
	lagMinutes: number;
	/** Members that need attention. */
	attentionCount: number;
	tabBadges: {
		/** The plans have unpublished changes. */
		plansDraft: boolean;
		bookingsOverdue: number;
		promosExpiring: number;
	};
};

/** A fixture scenario the Dashboard's switcher offers (mockup `KFIX`): an atm preset, its label and, where the mockup
 * has one, the caveat shown above the cards. */
export type Preset = { id: string; label: string; note?: string };

/** A books level as the switcher offers it (cell-rules `levels`): its name, whether it opens with the family PIN, and
 * its granularity ceiling (`G2` categories, `G4` distributions, `G6` identified). */
export type BooksLevelOption = {
	id: BooksLevel;
	name: string;
	pin: boolean;
	steps: string;
};

/** What the Dashboard may ask the Reader for, each list in switcher order, and the text of each hidden kind
 * (cell-rules `labels`). */
export type DashboardOptions = {
	presets: [Preset, ...Preset[]];
	levels: BooksLevelOption[];
	labels: Record<HiddenKind, string>;
};
