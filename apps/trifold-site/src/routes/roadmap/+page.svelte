<script lang="ts">
	import { reveal } from "#lib/actions/reveal";
	import ClosingCta from "#lib/components/ClosingCta.svelte";
	import PageHero from "#lib/components/PageHero.svelte";
	import Seo from "#lib/components/Seo.svelte";
	import Tag from "#lib/components/Tag.svelte";

	type State = "lit" | "ember" | "outline";
	const WHEN: Record<State, string> = { lit: "Today", ember: "Next", outline: "Later" };
	const TONE: Record<State, "today" | "next" | "later"> = { lit: "today", ember: "next", outline: "later" };
	const NODE: Record<State, string> = {
		lit: "bg-card [&_.when]:text-proof-text",
		ember:
			"border-[color-mix(in_srgb,var(--ember)_50%,transparent)] bg-[color-mix(in_srgb,var(--ember)_10%,transparent)] shadow-[0_0_40px_-16px_color-mix(in_srgb,var(--ember)_45%,transparent)] [&_.when]:text-ember-text",
		outline: "border-dashed border-fg-dim [&_.name]:text-muted-foreground",
	};
	const COLUMN: Record<State, string> = {
		lit: "bg-card",
		ember:
			"border-[color-mix(in_srgb,var(--ember)_40%,transparent)] bg-card bg-[radial-gradient(120%_80%_at_0%_0%,color-mix(in_srgb,var(--ember)_12%,transparent),transparent_60%)]",
		outline: "border-dashed border-fg-dim [&_.title]:text-muted-foreground [&_.head]:text-muted-foreground",
	};
	const ITEM: Record<State, string> = {
		lit: "text-foreground [&_.state]:text-proof-text",
		ember: "[&_.state]:text-ember-text",
		outline: "",
	};

	const CHAPTERS: { n: string; name: string; state: State; line: string; items: { text: string; state: State }[] }[] = [
		{
			n: "01",
			name: "Money in",
			state: "lit",
			line: "Stripe payments arrive as events.",
			items: [
				{ text: "Tuition, memberships, packs and bookings from Stripe", state: "lit" },
				{ text: "Stripe's webhook signature checked on ingest", state: "lit" },
				{ text: "Duplicate deliveries recorded once", state: "lit" },
				{ text: "Each event carries its Stripe record id", state: "lit" },
			],
		},
		{
			n: "02",
			name: "Books",
			state: "lit",
			line: "Balanced, append-only, replayable.",
			items: [
				{ text: "Double-entry postings that must balance", state: "lit" },
				{ text: "Corrections as new events, never edits", state: "lit" },
				{ text: "Replay to the same balances and journals", state: "lit" },
				{ text: "Export to hledger, Parquet and CSV", state: "lit" },
			],
		},
		{
			n: "03",
			name: "Proof",
			state: "lit",
			line: "Signed receipts, sealed months, a free verifier.",
			items: [
				{ text: "Ed25519 receipt for every Stripe payment and refund", state: "lit" },
				{ text: "Monthly seals, chained month to month", state: "lit" },
				{ text: "Verifier in the browser and in the CLI", state: "lit" },
				{ text: "Key rotation that keeps old receipts verifying", state: "lit" },
				{ text: "A hash chain per event", state: "ember" },
			],
		},
		{
			n: "04",
			name: "Close",
			state: "ember",
			line: "The month closes itself.",
			items: [
				{ text: "Reconcile against Stripe on request", state: "lit" },
				{ text: "Rifo reads, explains and proposes the close", state: "ember" },
				{ text: "Daily matching to Stripe payouts", state: "ember" },
				{ text: "Trifold as independent witness to each seal", state: "ember" },
				{ text: "The hosted service", state: "ember" },
			],
		},
		{
			n: "05",
			name: "Taxes",
			state: "outline",
			line: "Tax time with nothing to find.",
			items: [
				{ text: "Signed receipts and exports for your CPA", state: "lit" },
				{ text: "A year-end package built for your CPA", state: "outline" },
				{ text: "Donation acknowledgments", state: "outline" },
				{ text: "1099 exports", state: "outline" },
			],
		},
		{
			n: "06",
			name: "Finance",
			state: "outline",
			line: "Your numbers, in tables that last.",
			items: [
				{ text: "Your history in open tables you query with SQL", state: "outline" },
				{ text: "Cash forecasts", state: "outline" },
				{ text: "Agents for payables and receivables", state: "outline" },
			],
		},
	];
</script>

<Seo
	title="Roadmap"
	description="Money in, books, proof, close, taxes, finance: what Trifold ships today, what's next and what's later. Chapters light up as they ship."
/>

<PageHero
	eyebrow="Roadmap"
	title="Lit where it ships."
	lede="One story from money in to finance. Today is lit, Next glows, Later is an outline. We don't promise dates; chapters light up as they ship."
/>

<section class="border-t border-border py-10">
	<div class="container-page">
		<ol class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" aria-label="The end-to-end flow">
			{#each CHAPTERS as chapter, index (chapter.n)}
				<li class="grid gap-1 rounded-md border border-border px-[18px] py-4 {NODE[chapter.state]}" use:reveal={index}>
					<span class="num text-[11px] text-muted-foreground">{chapter.n}</span>
					<span class="name font-display text-xl">{chapter.name}</span>
					<span class="when font-mono text-[10.5px] tracking-[0.12em] text-muted-foreground uppercase">{WHEN[chapter.state]}</span>
				</li>
			{/each}
		</ol>
	</div>
</section>

<section class="py-[clamp(48px,6vw,88px)]">
	<div class="container-page grid gap-[18px] md:grid-cols-2 lg:grid-cols-3">
		{#each CHAPTERS as chapter, index (chapter.n)}
			<article class="rounded-lg border border-border p-6 {COLUMN[chapter.state]}" use:reveal={index}>
				<p class="head label-mono flex items-center gap-2.5 text-foreground">
					<span class="text-ember-text dark:text-seal">{chapter.n}</span> · {chapter.name}
					<Tag tone={TONE[chapter.state]}>{WHEN[chapter.state]}</Tag>
				</p>
				<h2 class="title mt-4 text-2xl font-[420]">{chapter.line}</h2>
				<ul class="mt-[18px] grid gap-2.5 text-[15px]">
					{#each chapter.items as item (item.text)}
						<li class="grid grid-cols-[52px_1fr] gap-2.5 text-muted-foreground {ITEM[item.state]}">
							<span class="state pt-1 font-mono text-[10px] tracking-[0.1em] uppercase">{WHEN[item.state]}</span>
							<span>{item.text}</span>
						</li>
					{/each}
				</ul>
			</article>
		{/each}
	</div>
	<div class="container-page">
		<p class="mt-7 text-sm text-muted-foreground">
			No dates are promised. Rifo drafts. You approve. The engine does the math, and Rifo cites the events behind every
			answer.
		</p>
	</div>
</section>

<ClosingCta title="Help us decide what lights up next." note="Design partners get a say in the roadmap." />
