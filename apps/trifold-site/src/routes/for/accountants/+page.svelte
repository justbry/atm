<script lang="ts">
	import ForPage from "#lib/components/ForPage.svelte";
	import Body from "../../../content/for/accountants.md";

	const faq = [
		{
			q: "Will this replace me?",
			a: "No. Trifold keeps the books from payment events and makes them checkable. You review, advise and sign. Rifo, the assistant on the roadmap, will prepare and explain; it never computes a number and never signs anything.",
		},
		{
			q: "Is a sealed month an audit or an attestation?",
			a: "Neither. A seal proves the month's events haven't changed since it was sealed. It doesn't prove the money moved or that the books are complete.",
		},
		{
			q: "What does a firm pay?",
			a: "Nothing for its own seats: a firm's seats are free on every client's books. Planned: clients a firm brings get 20% off their first year. Trifold pays no referral fees to tax preparers.",
		},
		{
			q: "Which formats do I get?",
			a: "hledger journals, CSV and Parquet, with each entry linked to the Stripe event it came from.",
		},
	];
</script>

<ForPage
	eyebrow="For accountants and bookkeepers"
	seoTitle="For accountants"
	description="Clients whose books arrive sealed and traceable: every number traced to a Stripe event, every month sealed. You review and sign; you don't rebuild."
	title="Clients whose books arrive sealed and traceable."
	subhead="Every number traces to a Stripe event. Every month can be sealed. You review and sign; you don't rebuild."
	points={[
		{ text: "Your firm's seats are free on every client's books.", note: "Planned" },
		{ text: "Clients your firm brings get 20% off their first year.", note: "Planned" },
		{ text: "A sample client file: hledger, CSV and a sealed month you can verify yourself." },
		{ text: "Replay the events on your own machine and get the same balances and journals." },
	]}
	cta={{ href: "/early-access?role=accountant", label: "Join the partner list" }}
	secondary={{ href: "/how-it-works", label: "How it works" }}
	body={Body}
	{faq}
	closingTitle="Review books that show their work."
	closingNote="We'll send the sample client file and talk through the partner program."
/>
