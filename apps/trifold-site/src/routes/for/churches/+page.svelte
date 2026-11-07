<script lang="ts">
	import ForPage from "#lib/components/ForPage.svelte";
	import SimulatedSection from "#lib/components/SimulatedSection.svelte";
	import Body from "../../../content/for/churches.md";

	const faq = [
		{
			q: "Is giving a fixed amount?",
			a: "Not for you. The simulation uses four fixed giving levels ($25, $50, $100 and $250 a month, or the same yearly) because that's how the scenario generator is built. A real church sets its own prices in Stripe, and the books record each gift at the amount Stripe charged.",
		},
		{
			q: "Can givers get a year-end giving statement?",
			a: "Not yet. Year-end giving statements and donation acknowledgments are on the roadmap, marked Later. Today each gift has a signed receipt the giver can check, and your accountant gets the books in open formats.",
		},
		{
			q: "Does a receipt show the giver's name?",
			a: "No. The signed record carries the gift's amount, the date, the Stripe record and a hash of the event in your books. No name, no email, so a receipt can be shown to anyone.",
		},
		{
			q: "Do you file anything for us?",
			a: "No. We prepare records; we don't file taxes or returns.",
		},
	];
</script>

<ForPage
	eyebrow="For churches"
	seoTitle="For churches"
	description="Giving records your treasurer can trust: every gift through Stripe becomes a signed receipt givers can check and a line in sealed, replayable books."
	title="Giving records your treasurer can trust."
	subhead="Every gift paid through Stripe, recurring giving or a one-time gift, becomes a signed receipt and a line in sealed, replayable books. Givers can check their own receipts, no account."
	points={[
		{ text: "Signed receipts givers can check themselves." },
		{ text: "A sealed month for every board meeting, not a spreadsheet." },
		{ text: "Open exports for your accountant: hledger, Parquet and CSV." },
		{ text: "Year-end giving statements, one per giver.", note: "Later" },
	]}
	cta={{ href: "/early-access?role=church", label: "Get early access" }}
	secondary={{ href: "/pricing?org=np", label: "See planned non-profit pricing" }}
	body={Body}
	{faq}
	closingTitle="Giving records that show their work."
>
	{#snippet aside()}
		<SimulatedSection slug="churches" title="A year of giving, simulated." />
	{/snippet}
</ForPage>
