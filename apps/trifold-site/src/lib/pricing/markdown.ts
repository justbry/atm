/**
 * The pricing page's plans and add-ons as markdown, for pricing.md (scripts/agent-files.ts). The page shows one toggle
 * state at a time (monthly, for-profit); this lists every price at once, from the same data the page renders.
 */
import {
	ADDONS,
	ANNUAL_MONTHS_CHARGED,
	type Feature,
	PLANS,
	SIDE_PLANS,
} from "./data";

const dollars = (amount: number) =>
	`$${Math.round(amount).toLocaleString("en-US")}`;

function priceCells(monthly: number): [string, string] {
	if (monthly === 0) return ["$0", "$0"];
	const yearly = monthly * ANNUAL_MONTHS_CHARGED;
	return [
		`${dollars(monthly)}/mo`,
		`${dollars(yearly / 12)}/mo, billed ${dollars(yearly)} a year`,
	];
}

const featureText = (raw: Feature) => {
	const item = typeof raw === "string" ? { text: raw } : raw;
	const notes = [
		item.soon && "soon, not yet shipped",
		item.np && "non-profits",
	].filter(Boolean);
	return notes.length ? `${item.text} (${notes.join("; ")})` : item.text;
};

export function plansMarkdown(): string {
	const rows = PLANS.map((plan) => {
		const [stdMonthly, stdAnnual] = priceCells(plan.price.std);
		const [npMonthly, npAnnual] = priceCells(plan.price.np);
		return `| ${plan.name} | ${stdMonthly} | ${stdAnnual} | ${npMonthly} | ${npAnnual} | ${plan.events.toLocaleString("en-US")} (${plan.families.toLowerCase()}) |`;
	});
	const plans = PLANS.map(
		(plan) =>
			`### ${plan.name}\n\n${plan.tagline}\n\n${plan.features.map((raw) => `- ${featureText(raw)}`).join("\n")}`,
	);
	const side = SIDE_PLANS.map((plan) => `### ${plan.name}\n\n${plan.body}`);
	return [
		"## Plans",
		`Every planned price, in USD. Annual billing charges ${ANNUAL_MONTHS_CHARGED} months for 12. Non-profit and co-op prices are for verified 501(c) organizations and cooperatives.`,
		"| Plan | Monthly | Annual | Non-profit, monthly | Non-profit, annual | Ledger events a month |\n| --- | --- | --- | --- | --- | --- |\n" +
			rows.join("\n"),
		...plans,
		...side,
	].join("\n\n");
}

export function addonsMarkdown(): string {
	const rows = ADDONS.map(
		(addon) =>
			`| ${addon.name}${addon.npOnly ? " (non-profits and co-ops)" : ""} | ${addon.price.std} | ${addon.price.np} | ${addon.body} |`,
	);
	return `| Add-on | Price | Non-profit price | What it is |\n| --- | --- | --- | --- |\n${rows.join("\n")}`;
}
