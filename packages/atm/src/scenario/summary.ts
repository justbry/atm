/** A small readable snapshot of a KPI table: window totals of the additive KPIs and the last period's billed members. Committed beside each golden hash. */
import type { KpiRow } from "./kpis.js";

export const ADDITIVE = [
	"gross_collected",
	"refunds",
	"disputes_lost",
	"dispute_fees",
	"stripe_fees",
	"net_income",
	"payouts",
	"payments_count",
	"refunds_count",
	"disputes_opened",
	"new_members",
	"credits_granted",
	"credits_consumed",
	"credits_expired",
] as const;

export const summaryOf = (rows: readonly KpiRow[]): Record<string, number> => {
	const out: Record<string, number> = {};
	for (const id of ADDITIVE)
		out[id] = rows
			.filter((r) => r.kpiId === id)
			.reduce((n, r) => n + r.value, 0);
	const members = rows.filter((r) => r.kpiId === "active_members");
	out.billed_members_last_period = members.at(-1)?.value ?? 0;
	return out;
};
