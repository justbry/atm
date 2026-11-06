import type { BookingsWriter } from "./bookings.ts";
import type { LedgerWriter } from "./ledger.ts";

/** Every change the UI makes goes through the Writer: fixtures now, the buzz-school routes in S8. Each slice adds the
 * methods its actions call: S2 the Bookings ones, S5 the promo ones and the CSV downloads. */
export type Writer = BookingsWriter & LedgerWriter;
