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
