import type { FaqItem } from "#lib/components/Faq.svelte";

/** The six objections, in the claims-audited wording (docs/website/reviews/round-2-sonnet.md §4). */
export const HOME_FAQ: FaqItem[] = [
	{
		q: "Will my state program accept these receipts?",
		a: 'We don\'t know yet, so we won\'t say yes. Each program sets its own rules. We\'re building receipts to the published rules and checking them with CPAs. Until a program confirms, we say "designed for", never "accepted by". Ask your program before you rely on any record, ours included.',
	},
	{
		q: "Will you be around next year?",
		a: "We plan to be, but you don't have to bet on it. Your books export in open formats (Parquet, hledger, CSV). Receipts and sealed months can be checked with a free tool that doesn't need us.",
	},
	{
		q: "I already use QuickBooks or Mindbody.",
		a: "Keep them. Trifold doesn't replace them. It builds a second set of books from your Stripe payments, with receipts and sealed months, that you can export for your accountant. Direct sync to QuickBooks and Xero isn't built yet.",
	},
	{
		q: "What happens to my data if you go away?",
		a: "It's yours to download any time, in open formats. Receipts and sealed months stay checkable with the free verifier, with or without Trifold. What you'd lose is the hosted service, not your records.",
	},
	{
		q: "Is AI touching my numbers?",
		a: "No. Today every number comes from fixed rules: the same payments always give the same books. Rifo, our AI assistant, isn't live. When it is, it will explain and suggest, cite the payments behind each answer, and never change a number without your approval.",
	},
	{
		q: "What does it cost?",
		a: "Design partners pay nothing during the pilot and get onboarding from the founders. Planned prices are on the pricing page and may change before launch. Checking a receipt or a seal is always free.",
	},
];
