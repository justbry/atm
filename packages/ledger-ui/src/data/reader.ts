import type { School } from "./types.ts";

/** Everything the UI reads: fixtures now, atm's read slice and the buzz-school routes in S8. Each slice adds the
 * methods it uses. */
export interface Reader {
	/** The schools the session may open, in switcher order. */
	schools(): Promise<School[]>;
}
