<script lang="ts">
	import { onMount } from "svelte";
	import { foldLine } from "#lib/actions/foldLine";
	import { reveal } from "#lib/actions/reveal";
	import ClosingCta from "#lib/components/ClosingCta.svelte";
	import DemoShot from "#lib/components/DemoShot.svelte";
	import FaqDetails from "#lib/components/FaqDetails.svelte";
	import HeroField from "#lib/components/HeroField.svelte";
	import LedgerPanel from "#lib/components/LedgerPanel.svelte";
	import ReceiptCard from "#lib/components/ReceiptCard.svelte";
	import SamplePill from "#lib/components/SamplePill.svelte";
	import Seo from "#lib/components/Seo.svelte";
	import Tag from "#lib/components/Tag.svelte";
	import ThreeWays from "#lib/components/ThreeWays.svelte";
	import { Button } from "#lib/components/ui/button";
	import VerticalGallery from "#lib/components/VerticalGallery.svelte";
	import VerifierInline from "#lib/components/VerifierInline.svelte";
	import { DEMO_URL } from "#lib/config";
	import { HOME_FAQ } from "#lib/content/faq";
	import { UNIFIED_LINE } from "#lib/content/proof-summary";

	type Phase = "rest" | "events" | "books" | "receipts" | "matching" | "matched" | "sealed";
	let phase = $state<Phase>("sealed");
	let step = $state<1 | 2 | 3>(1);
	let pinned = $state<HTMLElement>();

	const SPINE = [
		{ n: "01", name: "Money in", state: "lit", when: "Today" },
		{ n: "02", name: "Books", state: "lit", when: "Today" },
		{ n: "03", name: "Proof", state: "lit", when: "Today" },
		{ n: "04", name: "Close", state: "ember", when: "Next" },
		{ n: "05", name: "Taxes", state: "outline", when: "Later" },
		{ n: "06", name: "Finance", state: "outline", when: "Later" },
	] as const;

	const SPINE_STYLE = {
		lit: "bg-card [&_.when]:text-proof-text",
		ember: "border-[color-mix(in_srgb,var(--ember)_45%,transparent)] bg-[color-mix(in_srgb,var(--ember)_10%,transparent)] [&_.when]:text-ember-text",
		outline: "border-dashed border-fg-dim [&_.name]:text-muted-foreground",
	} as const;

	const WHO = [
		["A parent at tax time", "checks any tuition receipt, in the browser, without an account."],
		["A treasurer before the board meeting", "shows a sealed month instead of a spreadsheet."],
		["A CPA in January", "traces every number to the payment behind it."],
		["An auditor with no account", "checks a sealed month with the free verifier."],
		["A donor", "verifies the receipt for their gift."],
	] as const;

	// Shared class strings for the chapters.
	const chapter = "py-8 md:min-h-[78vh] md:pt-10 md:pb-18";
	const chapterLabel = "label-mono mb-5 flex items-center gap-2.5 text-foreground";
	const chNum = "text-ember-text dark:text-seal";
	const body = "mt-5 max-w-[56ch] text-lg text-foreground/85";
	const trustLine =
		"mt-5 flex max-w-[60ch] gap-3 rounded-md border border-border bg-card/60 px-4 py-3.5 text-[15px] text-muted-foreground [&_strong]:text-foreground";
	const micro = "label-mono mt-6 text-[11px]";
	const card = "relative flex flex-col gap-4 rounded-lg px-6 py-[26px] text-[15.5px] [&_p]:text-muted-foreground";

	onMount(() => {
		if (!pinned) return;
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) step = Number((entry.target as HTMLElement).dataset.step) as 1 | 2 | 3;
				}
			},
			{ rootMargin: "-45% 0px -50% 0px" },
		);
		for (const element of pinned.querySelectorAll<HTMLElement>("[data-step]")) observer.observe(element);
		return () => observer.disconnect();
	});
</script>

<Seo
	title="Trifold"
	description="Books that show their work. For schools, studios and non-profits on Stripe: every payment becomes a signed receipt your families can check, and sealed months show any later change."
/>

<!-- 1 · Hero -->
<section class="relative overflow-hidden">
	<div
		class="pointer-events-none absolute -top-[20%] -right-[10%] left-[35%] h-[120%] bg-[radial-gradient(closest-side,#fff,transparent_70%)] dark:bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--seal)_7%,transparent),transparent_70%)]"
		aria-hidden="true"
	></div>
	<div
		class="container-page relative grid items-center gap-[clamp(24px,4vw,64px)] py-[clamp(40px,6vw,80px)] lg:min-h-[min(calc(100svh-4rem),860px)] lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]"
	>
		<div>
			<p class="label-mono max-w-[44ch] leading-[1.7]">For schools, studios and non-profits that take payments on Stripe</p>
			<h1 class="display-1 mt-5 [font-variation-settings:'opsz'_144,'SOFT'_50,'WONK'_1]">Books that show their work.</h1>
			<p class="lede mt-6 max-w-[54ch]">
				Every Stripe payment becomes a signed receipt your families can check. Seal a month, and any later change shows.
				Export in open formats any time; receipts and seals check with a free tool, with or without us.
			</p>
			<div class="mt-8 flex flex-wrap items-center gap-3">
				<Button href="/early-access">Get early access</Button>
				<Button href="/for/accountants" variant="outline">Accountants: free seat</Button>
			</div>
			<p class="mt-5 text-[15px]"><a class="link-arrow text-foreground" href="#proof">Verify a sample receipt</a></p>
			<div class="mt-6" data-agent="skip"><SamplePill active={phase === "receipts" || phase === "matching"} /></div>
		</div>
		<div class="mt-2 h-[340px] sm:h-[380px] lg:mt-0 lg:h-[clamp(380px,46vw,600px)]">
			<HeroField bind:phase />
		</div>
	</div>
</section>

<!-- 2 · The question -->
<section class="border-t border-border py-[clamp(48px,6vw,88px)]">
	<div class="container-page max-w-[760px] text-center">
		<p class="display-2 font-[330]" use:reveal>AI can do your books. How would you know it did them right?</p>
		<p class="lede mx-auto mt-7" use:reveal={1}>
			<strong class="font-semibold text-foreground">Because every number shows its work.</strong> Each total opens to the
			payments behind it. Each payment has a receipt the payer keeps. Each month can be sealed, and anyone can check the
			seal without asking us.
		</p>
	</div>
</section>

<!-- 3 · Chapters -->
<section
	class="relative border-t border-border pt-[clamp(56px,8vw,110px)] pb-[clamp(64px,8vw,120px)]"
	aria-labelledby="chapters-title"
	use:foldLine
>
	<div class="container-page">
		<header class="mb-[clamp(40px,6vw,72px)]">
			<h2 id="chapters-title" class="label-mono font-mono">One story, six chapters · lit where it ships</h2>
			<ol class="mt-[18px] grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
				{#each SPINE as item, index (item.n)}
					<li class="grid gap-0.5 rounded-md border border-border px-3.5 py-3 text-sm {SPINE_STYLE[item.state]}" use:reveal={index}>
						<span class="num text-[11px] text-muted-foreground">{item.n}</span>
						<span class="name font-semibold">{item.name}</span>
						<span class="when font-mono text-[10.5px] tracking-[0.12em] text-muted-foreground uppercase">{item.when}</span>
					</li>
				{/each}
			</ol>
		</header>

		<div class="grid gap-[clamp(32px,5vw,80px)] md:grid-cols-[minmax(0,1fr)_minmax(0,0.92fr)]" bind:this={pinned}>
			<div>
				<article class={chapter} id="money-in" data-chapter data-step="1">
					<p class={chapterLabel}><span class={chNum}>01</span> · Money in <Tag tone="today">Today</Tag></p>
					<h3 class="display-2 max-w-[16ch]" use:reveal>Payments arrive as events.</h3>
					<p class={body} use:reveal={1}>
						Tuition, memberships, class packs and bookings come in through Stripe. Each one lands as an event with a time,
						an amount and the Stripe record it came from. Nothing is typed in by hand.
					</p>
					<p class={micro}>214 events · October 2026</p>
					<div class="mt-7 md:hidden" data-agent="skip"><LedgerPanel step={1} /></div>
				</article>

				<article class={chapter} id="books" data-chapter data-step="2">
					<p class={chapterLabel}><span class={chNum}>02</span> · Books <Tag tone="today">Today</Tag></p>
					<h3 class="display-2 max-w-[16ch]" use:reveal>Every event becomes balanced books.</h3>
					<p class={body} use:reveal={1}>
						Each payment posts as a debit and a credit, so the books always balance. Events are append-only: a correction
						is a new event, never an edit. Replay the events and you get the same balances and journals.
					</p>
					<p class={trustLine} use:reveal={2}>
						<span class="font-bold text-proof-text" aria-hidden="true">✓</span>
						<span
							><strong>Durable.</strong> Export in open formats (Parquet, hledger, CSV) any time. Receipts and seals check
							with a free tool, with or without us. The engine's source is public on GitHub.</span
						>
					</p>
					<p class={micro}>Books · balanced · replayable</p>
					<div class="mt-7 md:hidden" data-agent="skip"><LedgerPanel step={2} /></div>
				</article>

				<article class="py-8 md:pt-10 md:pb-18" id="proof" data-chapter data-step="3">
					<p class={chapterLabel}><span class={chNum}>03</span> · Proof <Tag tone="today">Today</Tag></p>
					<h3 class="display-2 max-w-[16ch]" use:reveal>A signed receipt for every payment. A seal on every month.</h3>
					<p class={body} use:reveal={1}>
						Each Stripe payment gets a receipt signed with the school's key. The family keeps it. If the books are changed
						later, the receipt no longer matches. At month end you seal the month, and each seal is chained to the one
						before it.
					</p>
					<p
						class="mt-6 max-w-[30ch] border-l-2 border-seal pl-[18px] font-display text-[clamp(21px,2vw,26px)] leading-[1.35] [font-variation-settings:'opsz'_72,'SOFT'_60]"
						use:reveal={2}
					>
						Change a sealed month and the seal stops matching. Keep your copies and you can show it.
					</p>
					<p class={trustLine} use:reveal={3}>
						<span class="font-bold text-proof-text" aria-hidden="true">✓</span>
						<span
							><strong>Resilient.</strong> Lose the books, keep the events, and replay gives the same balances and journals.
							Retired keys stay in the key list, so old receipts and seals keep verifying after a key rotation.</span
						>
					</p>
					<div class="mt-7 md:hidden" data-agent="skip"><LedgerPanel step={3} /></div>
					<div class="mt-10"><VerifierInline /></div>
					<p class={micro}>214 receipts · 1 seal · 0 changed</p>
				</article>
			</div>
			<aside class="hidden md:block" aria-label="Sample ledger">
				<div class="sticky top-26 pt-10">
					<LedgerPanel {step} />
					<p class="mt-3.5 text-sm text-muted-foreground">
						The sample school's October, as events, as books, then as receipts under a seal.
					</p>
				</div>
			</aside>
		</div>

		<!-- A neutral band, so green (03) and ember (04) never share a viewport. -->
		<div class="mx-auto h-[clamp(64px,10vw,140px)] w-px bg-border" aria-hidden="true"></div>

		<div class="grid gap-[18px] lg:grid-cols-3">
			<article
				class="{card} border border-[color-mix(in_srgb,var(--ember)_40%,transparent)] bg-card bg-[radial-gradient(120%_80%_at_0%_0%,color-mix(in_srgb,var(--ember)_13%,transparent),transparent_60%)] shadow-[0_0_60px_-20px_color-mix(in_srgb,var(--ember)_35%,transparent)]"
				id="close"
				data-chapter
				use:reveal
			>
				<p class="{chapterLabel} mb-0"><span class="text-ember-text">04</span> · Close <Tag tone="next">Next</Tag></p>
				<h3 class="display-3 -mt-1">The month closes itself. Next.</h3>
				<p>
					Today you reconcile against Stripe on demand and seal the month yourself. Next, Rifo reads the books, matches each
					day to its Stripe payout, explains any gap and proposes the close. <strong class="text-foreground"
						>Rifo drafts. You approve. The engine does the math.</strong
					> Every answer cites the events behind it.
				</p>
				<p class={trustLine}>
					<span class="font-bold text-proof-text" aria-hidden="true">✓</span>
					<span><strong>Fast, today.</strong> Rebuild any month's books from its events with one command.</span>
				</p>
				<p class="border-t border-dashed border-line-strong pt-3 text-sm">
					Also next: daily payout matching · Trifold as independent witness to each seal.
				</p>
				<p class="{micro} mt-auto pt-1.5">Next · on the roadmap</p>
			</article>

			<article class="{card} border border-dashed border-fg-dim" id="taxes" data-chapter use:reveal={1}>
				<p class="{chapterLabel} mb-0 text-muted-foreground">05 · Taxes <Tag tone="later">Later</Tag></p>
				<h3 class="display-3 -mt-1 text-muted-foreground">Tax time with nothing to find.</h3>
				<p>
					Today your CPA gets signed receipts and books that export to hledger and Parquet, every number traced to a
					payment. Later: a year-end package built for your CPA, donation acknowledgments, 1099 exports. We prepare the
					records; we don't file your taxes.
				</p>
				<p class="{micro} mt-auto pt-1.5">Later</p>
			</article>

			<article class="{card} border border-dashed border-fg-dim" id="finance" data-chapter use:reveal={2}>
				<p class="{chapterLabel} mb-0 text-muted-foreground">06 · Finance <Tag tone="later">Later</Tag></p>
				<h3 class="display-3 -mt-1 text-muted-foreground">Your numbers, in tables that last.</h3>
				<p>
					Later: your financial history in open tables you can query with SQL. Cash forecasts. Agents for payables and
					receivables. Open formats, no lock-in.
				</p>
				<p class="{micro} mt-auto pt-1.5">Later</p>
			</article>
		</div>
		<p class="mt-7 text-[15px]"><a class="link-arrow text-foreground" href="/roadmap">See the roadmap</a></p>
	</div>
</section>

<!-- 4 · See it live: a screenshot of the demo, linked, never framed (its CSP only allows its own origin). -->
<section class="border-t border-border py-[clamp(72px,10vw,140px)]" aria-labelledby="live-title">
	<div class="container-page">
		<div class="flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
			<div>
				<p class="label-mono">See it live · sample school · no login</p>
				<h2 id="live-title" class="display-2 mt-[18px] max-w-[18ch]" use:reveal>A school's dashboard, computed by the engine.</h2>
				<p class="lede mt-[18px]" use:reveal={1}>
					A year of tuition for a sample school: collected, net income, Stripe fees and payouts, with charts by plan and
					by month.
				</p>
			</div>
			<Button href={DEMO_URL} rel="noopener" target="_blank"
				>Open the live demo ↗<span class="sr-only"> (opens in a new tab)</span></Button
			>
		</div>
		<figure class="mt-10 overflow-hidden rounded-lg border border-border bg-card shadow-card" use:reveal={2}>
			<div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border px-4 py-2.5">
				<span class="label-mono text-[10.5px]">Honeycomb Hill Academy · sample school</span>
				<span class="font-mono text-[10.5px] font-semibold tracking-[0.12em] text-proof-text uppercase"
					><span aria-hidden="true">✓</span> Verified against goldens</span
				>
			</div>
			<DemoShot />
			<figcaption class="border-t border-border px-4 py-3 text-sm text-muted-foreground">
				Honeycomb Hill Academy is a sample school with synthetic data. Every number comes from the engine and is checked
				against its committed goldens.
			</figcaption>
		</figure>
	</div>
</section>

<!-- 5 · Simulate your organization: one engine, one set of checks, a seeded scenario per kind of organization. -->
<section class="border-t border-border py-[clamp(72px,10vw,140px)]" aria-labelledby="simulate-title">
	<div class="container-page">
		<div class="grid items-start gap-[clamp(32px,5vw,72px)] lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
			<div>
				<p class="label-mono">Simulations · invented names · synthetic data</p>
				<h2 id="simulate-title" class="display-2 mt-[18px] max-w-[16ch]" use:reveal>Simulate your organization.</h2>
				<p class="lede mt-[18px]" use:reveal={1}>{UNIFIED_LINE}</p>
				<p class="mt-6 text-[15px]"><a class="link-arrow text-foreground" href="/proof">See the proof</a></p>
			</div>
			<div use:reveal={1}><ThreeWays /></div>
		</div>
		<div class="mt-[clamp(40px,5vw,64px)]"><VerticalGallery /></div>
		<p class="mt-5 text-sm text-muted-foreground">
			Every organization here is invented, and its data is synthetic. See
			<a class="text-muted-foreground underline" href="/proof#simplify">where the simulations simplify</a>.
		</p>
	</div>
</section>

<!-- 6 · Who can check -->
<section class="border-t border-border py-[clamp(72px,10vw,140px)]">
	<div class="container-page grid items-start gap-[clamp(32px,6vw,96px)] md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
		<div>
			<p class="label-mono">Who can check</p>
			<h2 class="display-2 mt-[18px]" use:reveal>Anyone can check. No account.</h2>
			<p class="lede mt-[18px]" use:reveal={1}>The same Verify button, five people.</p>
			<Button href="/verify" variant="outline" class="mt-7">Verify a sample receipt</Button>
		</div>
		<ul class="border-t border-border">
			{#each WHO as [who, what], index (who)}
				<li class="flex items-baseline gap-4 border-b border-border py-5 text-lg text-muted-foreground" use:reveal={index}>
					<span class="size-2 flex-none -translate-y-0.5 rounded-full bg-proof shadow-glow-proof" aria-hidden="true"></span>
					<p><strong class="font-semibold text-foreground">{who}</strong> {what}</p>
				</li>
			{/each}
		</ul>
	</div>
</section>

<!-- 7 · Built for schools first -->
<section class="border-t border-border py-[clamp(72px,10vw,140px)]">
	<div class="container-page grid items-center gap-[clamp(32px,6vw,88px)] md:grid-cols-[minmax(0,1fr)_minmax(0,0.95fr)]">
		<div>
			<p class="label-mono">Built for schools first</p>
			<h2 class="display-2 mt-[18px] max-w-[18ch]" use:reveal>Receipts your families can use. Books your CPA can sign.</h2>
			<p class={body} use:reveal={1}>
				We're starting with microschools and private schools in Idaho and Utah. Families need itemised receipts: the child,
				the hours, the dates, the school's EIN. Owners need a month that closes without a spreadsheet. CPAs need numbers
				that trace to payments. One record does all three.
			</p>
			<p class="my-6 max-w-[58ch] border-l-2 border-line-strong px-4 py-3.5 text-[15px] text-muted-foreground" use:reveal={2}>
				Receipts are designed against each program's published rules and reviewed with CPAs. Until a program confirms, we
				say "designed for", not "accepted by".
			</p>
			<div class="flex flex-wrap items-center gap-4">
				<Button href="/early-access?role=school">Get early access</Button>
				<a class="link-arrow text-foreground" href="/for/schools">For schools</a>
			</div>
			<p class="mt-3.5 text-sm text-muted-foreground">Design partners: founder onboarding, free during the pilot.</p>
			<p class="mt-5 text-sm text-muted-foreground [&_a]:text-muted-foreground [&_a]:underline">
				Also for <a href="/for/churches">churches</a> · <a href="/for/nonprofits">non-profits</a> ·
				<a href="/for/studios">studios and gyms</a> · <a href="/for/saas">SaaS</a> · <a href="/for/creators">creators</a> ·
				<a href="/for/accountants">accountants</a> · <a href="/for/developers">developers</a>. <a href="/for">Who it's for</a>.
			</p>
		</div>
		<div use:reveal={1} data-agent="skip"><ReceiptCard collapsed /></div>
	</div>
</section>

<!-- 8 · People -->
<section class="border-t border-border py-[clamp(48px,6vw,88px)]">
	<div class="container-page">
		<p class="label-mono">Who's behind it</p>
		<h2 class="display-2 mt-[18px]" use:reveal>People first. Then proof.</h2>
		<div class="mt-8 grid gap-[18px] md:grid-cols-2">
			<div class="grid justify-items-start gap-2.5 rounded-lg border border-dashed border-border bg-card p-6">
				<Tag>Placeholder</Tag>
				<p class="font-display text-[22px]">[Founder name], founder</p>
				<p class="text-muted-foreground">[One sentence: why books that show their work.] To be written by the founder.</p>
			</div>
			<div class="grid justify-items-start gap-2.5 rounded-lg border border-dashed border-border bg-card p-6">
				<Tag>Placeholder</Tag>
				<p class="font-display text-[22px]">[Design partners]</p>
				<p class="text-muted-foreground">
					Logos and one quote each, only with written permission. This block stays empty until partners approve.
				</p>
			</div>
		</div>
		<p class="mt-5 text-sm text-muted-foreground">
			Trifold provides tfd, the engine behind it. The code, the receipt and seal formats and the verifier are on GitHub.
		</p>
	</div>
</section>

<!-- 9 · FAQ -->
<section class="py-[clamp(48px,6vw,88px)]">
	<div class="container-page max-w-[760px]"><FaqDetails items={HOME_FAQ} /></div>
</section>

<!-- 10 · Closing -->
<ClosingCta />
