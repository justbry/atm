<script lang="ts">
	import ForPage from "#lib/components/ForPage.svelte";
	import SimulatedSection from "#lib/components/SimulatedSection.svelte";
	import Body from "../../../content/for/nonprofits.md";

	const faq = [
		{
			q: "Is there a non-profit simulation?",
			a: "Not one of its own. The closest is Cedar Hill Community Church, a simulated church: recurring gifts at fixed levels, one-time gifts and a few refunds. It shows how gifts move through the same books and checks.",
		},
		{
			q: "Can donors get acknowledgment letters?",
			a: "Not yet. Donation acknowledgment letters are on the roadmap, marked Later. Today each gift has a signed receipt the donor can check.",
		},
		{
			q: "Do you track restricted funds or grants?",
			a: "No. The books record what came in through Stripe and trace every number to its payment. Splitting money by fund or grant isn't built.",
		},
	];
</script>

<ForPage
	eyebrow="For non-profits and co-ops"
	seoTitle="For non-profits and co-ops"
	description="Open books your donors, members and board can check: every gift and due through Stripe becomes a signed receipt in sealed, replayable books. Anyone can verify, no account."
	title="Open books your donors, members and board can check."
	subhead="Every gift and due paid through Stripe becomes a signed receipt and a line in replayable books. Anyone can verify, no account."
	points={[
		{ text: "A sealed month for every board meeting, not a spreadsheet." },
		{ text: "Receipts donors and members can verify themselves.", note: "Acknowledgment letters: Later" },
		{ text: "Open formats: your auditor gets the events and rebuilds the books." },
	]}
	cta={{ href: "/early-access?role=nonprofit", label: "Get early access" }}
	secondary={{ href: "/pricing?org=np", label: "See planned non-profit pricing" }}
	body={Body}
	{faq}
>
	{#snippet aside()}
		<SimulatedSection
			slug="churches"
			title="The closest simulation: a year of giving."
			lede="There's no non-profit or co-op simulation of its own. The closest giving model is Cedar Hill Community Church, a simulated church. Its year runs through the engine, hledger and DuckDB, and all three give the same KPI hash."
		/>
	{/snippet}
</ForPage>
