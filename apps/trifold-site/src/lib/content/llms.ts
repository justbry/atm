/**
 * The summary and facts at the top of llms.txt (written by scripts/agent-files.ts). They follow the roadmap page: Today
 * is shipped, Next and Later are not. Prices come from the pricing data module.
 */
import { ANNUAL_MONTHS_CHARGED, PLANS } from "#lib/pricing/data";

export const LLMS_SUMMARY =
	"Books that show their work: every Stripe payment becomes balanced books and a signed receipt anyone can check for free, and every month is sealed so a later change shows.";

const paid = PLANS.filter((plan) => plan.price.std > 0);
const prices = `Free, ${paid.map((plan) => `${plan.name} $${plan.price.std}`).join(", ")} a month (non-profit and co-op: ${paid
	.map((plan) => `${plan.name} $${plan.price.np}`)
	.join(
		", ",
	)}); annual billing charges ${ANNUAL_MONTHS_CHARGED} months for 12. Witnessed is early access: its witness features ship with the witness`;

export const LLMS_FACTS = [
	"Trifold is the company and hosted service behind tfd, an engine for US schools, studios and non-profits paid through Stripe.",
	"Shipped today, in the engine and its CLI: balanced double-entry books built from Stripe events (Stripe's webhook signature checked, duplicate deliveries recorded once); corrections as new events, never edits; replay to the same balances and journals; an Ed25519-signed receipt for every Stripe payment and refund; monthly seals chained month to month, with key rotation that keeps old receipts verifying; Stripe reconcile on request; export to Parquet, hledger and CSV; and a free verifier that runs in the browser with no account.",
	"Next, not shipped: the hosted service (early access; design partners are free during the pilot); Rifo, an AI assistant that drafts and explains while you approve and the engine does the math; daily matching to Stripe payouts; a per-event hash chain; and Trifold as an independent witness that countersigns receipts and seals.",
	"Later: a year-end package for your CPA, donation acknowledgments, 1099 exports and cash forecasts.",
	`Planned prices in USD, subject to change: ${prices}. No per-seat or per-transaction fees.`,
	"The engine is source-available and free to self-host under FSL-1.1-ALv2; each tfd release becomes Apache-2.0 two years after it ships. The receipt and seal format and the verifier are Apache-2.0, and the test vectors are CC0-1.0. The hosted service, Rifo and the witness are proprietary. Sample data on this site is invented.",
].join(" ");
