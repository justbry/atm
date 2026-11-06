import type { BookingsReader } from "./bookings.ts";
import type { DisclosureReader } from "./disclosure.ts";
import type { KpiDocument, KpiQuery } from "./kpi-document.ts";
import type { PlansReader } from "./plans.ts";
import type { MembersReader } from "./members.ts";
import type { LedgerReader } from "./ledger.ts";
import type { PortalReader } from "./portal.ts";
import type { SettingsReader } from "./settings.ts";
import type { DashboardOptions, School } from "./types.ts";

/** Everything the UI reads: fixtures now, atm's read slice and the buzz-school routes in S8. Each slice adds the
 * methods it uses. */
export interface Reader
	extends BookingsReader,
		PlansReader,
		MembersReader,
		LedgerReader,
		PortalReader,
		DisclosureReader,
		SettingsReader {
	/** The schools the session may open, in switcher order. */
	schools(): Promise<School[]>;
	/** The presets and books levels the KPI documents exist for, and the cell labels. */
	dashboardOptions(): Promise<DashboardOptions>;
	/** The KPI document of one preset, books level and PIN state, as the server computed it (the UI derives nothing from it), or
	 * undefined when there is none. */
	kpiDocument(query: KpiQuery): Promise<KpiDocument | undefined>;
}
