import type { BookingsWriter } from "./bookings.ts";

/** Every change the UI makes goes through the Writer: fixtures now, the buzz-school routes in S8. Each slice adds the
 * methods its actions call: S2 the Bookings ones. */
export type Writer = BookingsWriter;
