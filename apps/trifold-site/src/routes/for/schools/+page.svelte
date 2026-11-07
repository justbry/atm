<script lang="ts">
	import ForPage from "#lib/components/ForPage.svelte";
	import ReceiptCard from "#lib/components/ReceiptCard.svelte";
	import { DEMO_URL } from "#lib/config";
	import Body from "../../../content/for/schools.md";

	const faq = [
		{
			q: "Will my state program accept these receipts?",
			a: 'We don\'t know yet, so we won\'t say yes. Each program sets its own rules. We\'re building receipts to the published rules and checking them with CPAs. Until a program confirms, we say "designed for", never "accepted by". Ask your program before you rely on any record, ours included.',
		},
		{
			q: "Does the signed receipt carry my students' names?",
			a: "No, by design. The signed record carries the payment, the date, the Stripe record and a hash of the event in your books. The child and the hours appear as itemised lines from your Stripe invoice, beside it, so a receipt can be shown to anyone without exposing more than it needs to.",
		},
		{
			q: "What does sealed mean?",
			a: "A signed fingerprint of the month as it stood when you sealed it. If any payment in a sealed month changes later, the fingerprint stops matching.",
		},
		{
			q: "What happens after I ask for early access?",
			a: "The founder replies by email to set up a call. Design partners are free during the pilot.",
		},
	];
</script>

<ForPage
	eyebrow="For schools · Idaho and Utah first"
	seoTitle="For schools"
	description="Signed, itemised tuition receipts your families can check, and sealed monthly books your CPA can trace. Built first for microschools in Idaho and Utah."
	title="Every tuition payment, a receipt your families can check."
	subhead="Trifold turns your Stripe payments into signed receipts and sealed monthly books. Built first for microschools in Idaho and Utah."
	points={[
		{ text: "Receipts with the child, the hours, the dates and your EIN as invoice lines, beside a signed record that shows any later change." },
		{ text: "A month that closes from your Stripe events, not from a spreadsheet." },
		{ text: "Books your CPA can trace to the payment behind every number." },
	]}
	cta={{ href: "/early-access?role=school", label: "Get early access" }}
	secondary={{ href: "/verify", label: "Verify a sample receipt" }}
	body={Body}
	{faq}
	closingTitle="Receipts your families can use. Books your CPA can sign."
	closingNote="Design partners: founder onboarding, free during the pilot."
>
	{#snippet aside()}
		<div class="grid items-center gap-[clamp(32px,5vw,72px)] md:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)]">
			<div>
				<p class="label-mono">A sample receipt</p>
				<h2 class="display-3 mt-3.5 mb-4">What a family gets.</h2>
				<p class="text-muted-foreground [&_a]:underline">
					Itemised lines from your Stripe invoice, and a signed record that links the payment to one exact entry in your
					books. Check it on the <a href="/verify">verify page</a>.
				</p>
				<p class="mt-6 text-[15px]">
					<a class="font-semibold text-foreground underline" href={DEMO_URL} rel="noopener" target="_blank"
						>See a school's dashboard live ↗<span class="sr-only"> (opens in a new tab)</span></a
					>
				</p>
				<p class="mt-1.5 text-sm text-muted-foreground">
					Honeycomb Hill Academy, a sample school with synthetic data. No login.
				</p>
			</div>
			<ReceiptCard />
		</div>
	{/snippet}
</ForPage>
