<script lang="ts">
	import ForPage from "#lib/components/ForPage.svelte";
	import SimulatedSection from "#lib/components/SimulatedSection.svelte";
	import Body from "../../../content/for/creators.md";

	const faq = [
		{
			q: "Are course sales a separate income line?",
			a: "Not in today's simulation: a course sale is booked with the member's tier. The payment, its receipt and its refund are all there; the split by product isn't.",
		},
		{
			q: "Can I keep my course platform?",
			a: "Yes. Trifold builds the books from your Stripe payments. Direct sync to course or community platforms isn't built.",
		},
	];
</script>

<ForPage
	eyebrow="For creators and online courses"
	seoTitle="For creators and online courses"
	description="Community memberships, course sales and refunds through Stripe, as balanced books with a signed receipt for every payment. Know what actually came in."
	title="A launch month you can account for."
	subhead="Memberships, course sales and refunds through Stripe, recorded as balanced books with a signed receipt for every payment. Know what actually came in."
	points={[
		{ text: "Every payment and refund posts as balanced books." },
		{ text: "Refunds are new events, never edits." },
		{ text: "Signed receipts members can check, and a sealed month at the end." },
	]}
	cta={{ href: "/early-access?role=creator", label: "Get early access" }}
	secondary={{ href: "/pricing", label: "Planned pricing" }}
	body={Body}
	{faq}
	closingTitle="A launch that shows its work."
>
	{#snippet aside()}
		<SimulatedSection slug="creators" title="A course launch, simulated." />
	{/snippet}
</ForPage>
