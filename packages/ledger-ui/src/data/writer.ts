import type { BookingsWriter } from "./bookings.ts";
import type { PlansWriter } from "./plans.ts";

/** Every change the UI makes goes through the Writer: fixtures now, the buzz-school routes in S8. Each slice adds the
 * methods its actions call: S2 the Bookings ones, S3 the Plans ones. */
export type Writer = BookingsWriter & PlansWriter;
