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
	/** What the school calls a held credit (mockup `unit`): "1 session held", "2 sessions held". */
	creditUnit: { one: string; other: string };
	/** The month the Dashboard opens on (the mockup opens its fixture school on Jun); without it, the clock's month.
	 * Either snaps to a period the viewed audience may pick. */
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

/** What the Dashboard may ask the Reader for: the presets of the fixture schools, in switcher order. The audiences
 * come from the disclosure (`disclosure.ts`), and each cell carries its own text. */
export type DashboardOptions = {
	presets: [Preset, ...Preset[]];
};
