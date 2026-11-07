<script lang="ts">
	import ForPage from "#lib/components/ForPage.svelte";
	import SimulatedSection from "#lib/components/SimulatedSection.svelte";
	import Body from "../../../content/for/saas.md";

	const faq = [
		{
			q: "Is there a recurring-revenue number?",
			a: "Not yet: there's no MRR KPI yet. The simulations report gross collected, net income, refunds, disputes, Stripe fees, payouts, payments, paying members and credits.",
		},
		{
			q: "Does Trifold do revenue recognition?",
			a: "No. It keeps balanced books of what Stripe charged, collected and refunded, every number traced to its payment. Recognising revenue over a contract (ASC 606) is not something we claim.",
		},
		{
			q: "How is API usage counted?",
			a: "As credits. In the Lumen Notes simulation one credit is a block of 1,000 calls, granted with the plan and used each month.",
		},
	];
</script>

<ForPage
	eyebrow="For SaaS and digital products"
	seoTitle="For SaaS and digital products"
	description="Seats, plans, proration and usage credits through Stripe, as balanced books with a signed receipt for every payment. Replay the events and get the same books."
	title="Seats, plans and usage credits, in books that balance."
	subhead="Every Stripe invoice, prorated seat changes included, becomes balanced books, a signed receipt and tracked credits. Replay the events and get the same books."
	points={[
		{ text: "Seat changes, upgrades and proration posted from the invoices Stripe sent." },
		{ text: "Usage credits granted, used and expired, tracked as balances." },
		{ text: "Signed receipts and sealed months; replay to the same books." },
	]}
	cta={{ href: "/early-access?role=saas", label: "Get early access" }}
	secondary={{ href: "/for/developers", label: "For developers" }}
	body={Body}
	{faq}
	closingTitle="Seats and credits that show their work."
>
	{#snippet aside()}
		<SimulatedSection slug="saas" title="A SaaS product, simulated." />
	{/snippet}
</ForPage>
