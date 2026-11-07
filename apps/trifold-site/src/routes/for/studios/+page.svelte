<script lang="ts">
	import ForPage from "#lib/components/ForPage.svelte";
	import SimulatedSection from "#lib/components/SimulatedSection.svelte";
	import Body from "../../../content/for/studios.md";

	const faq = [
		{
			q: "Do I have to leave my booking app?",
			a: "No. Trifold builds the books from your Stripe payments. Direct sync to booking and accounting apps isn't built yet.",
		},
		{
			q: "How are class packs tracked?",
			a: "As credits: granted when a pack is paid, used when a class is booked, and expired when they run out of time. The books keep the balance, so you know who has visits left.",
		},
	];
</script>

<ForPage
	eyebrow="For studios and gyms"
	seoTitle="For studios and gyms"
	description="Memberships, class packs and credits through Stripe, recorded as balanced books with a signed receipt for every payment and a sealed month at the end."
	title="Sell plans and packs. Know who has visits left."
	subhead="Memberships, class packs and drop-ins through Stripe, recorded as balanced books with a signed receipt for every payment."
	points={[
		{ text: "Credits tracked as balances, so you know who has visits left." },
		{ text: "A signed receipt for every payment, and a sealed month at the end." },
		{ text: "Keep your booking app. Export to CSV and hledger for your accountant." },
	]}
	cta={{ href: "/early-access?role=studio", label: "Get early access" }}
	secondary={{ href: "/pricing", label: "Planned pricing" }}
	body={Body}
	{faq}
>
	{#snippet aside()}
		<SimulatedSection slug="studios" title="A studio's year, simulated." />
	{/snippet}
</ForPage>
