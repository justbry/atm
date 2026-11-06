import type { BookingsWriter } from "./bookings.ts";
import type { LedgerWriter } from "./ledger.ts";
import type { MembersWriter } from "./members.ts";
import type { PlansWriter } from "./plans.ts";
import type { PortalWriter } from "./portal.ts";
import type { SettingsWriter } from "./settings.ts";

/** Every change the UI makes goes through the Writer: fixtures now, the buzz-school routes in S8. It is every slice's
 * contract at once: S2 the Bookings writes, S3 the Plans ones, S4 the Members ones, S5 the promo ones and the CSV
 * downloads, S6 the member portal's, S7 the Settings ones. The Bookings and Members tabs both record outcomes and
 * cancel bookings, each with its own request; an adapter answers either. */
export type Writer = BookingsWriter &
	PlansWriter &
	MembersWriter &
	LedgerWriter &
	PortalWriter &
	SettingsWriter;
