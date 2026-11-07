<script lang="ts">
	import { page } from "$app/state";
	import { reveal } from "#lib/actions/reveal";
	import ClosingCta from "#lib/components/ClosingCta.svelte";
	import PageHero from "#lib/components/PageHero.svelte";
	import Seo from "#lib/components/Seo.svelte";
	import Tag from "#lib/components/Tag.svelte";
	import { COMPETITORS, type Competitor } from "#lib/compare/competitors";
	import { CONTACT_EMAIL } from "#lib/config";

	// entries() in +page.ts prerenders exactly the slugs in COMPETITORS, so the find always succeeds.
	const competitor = $derived(COMPETITORS.find((entry) => entry.slug === page.params.slug) as Competitor);

	/** Chapter lighting from the roadmap: shipped is lit, next glows ember. */
	const DIFFERS = {
		shipped: "bg-card",
		next: "border-[color-mix(in_srgb,var(--ember)_40%,transparent)] bg-card bg-[radial-gradient(120%_80%_at_0%_0%,color-mix(in_srgb,var(--ember)_12%,transparent),transparent_60%)]",
	};
	const section = "border-t border-border py-[clamp(48px,6vw,88px)]";
	const lede = "mt-2.5 max-w-[760px] text-muted-foreground";
</script>

<Seo title="Trifold vs {competitor.name}" description={competitor.oneLine} />

<PageHero eyebrow="Compare · Trifold vs {competitor.name}" title="Trifold vs {competitor.name}" lede={competitor.intro}>
	{#if competitor.tagline}
		<p class="text-[15px] text-muted-foreground">
			{competitor.name}, in its own words: <span class="text-foreground italic">“{competitor.tagline}”</span>
		</p>
	{/if}
</PageHero>

<section class={section} aria-labelledby="strongest-title">
	<div class="container-page">
		<h2 id="strongest-title" class="display-3">Where {competitor.name} is strongest</h2>
		<p class={lede}>Honest first. If these matter most to you, {competitor.name} is likely the better fit.</p>
		<div class="mt-7 grid gap-4 md:grid-cols-3">
			{#each competitor.theyAreStrongest as point, index (point.title)}
				<article class="rounded-lg border border-border bg-card p-6" use:reveal={index}>
					<h3 class="text-[22px] font-[450]">{point.title}</h3>
					<p class="mt-3 text-[15px] text-muted-foreground">{point.body}</p>
				</article>
			{/each}
		</div>
	</div>
</section>

<section class={section} aria-labelledby="differs-title">
	<div class="container-page">
		<h2 id="differs-title" class="display-3">Where Trifold differs</h2>
		<p class={lede}>Shipped means it works today in the engine. Next means it's on the roadmap and not built yet.</p>
		<div class="mt-7 grid gap-4 md:grid-cols-3">
			{#each competitor.trifoldDiffers as point, index (point.title)}
				<article class="rounded-lg border border-border p-6 {DIFFERS[point.status]}" use:reveal={index}>
					<Tag tone={point.status === "shipped" ? "today" : "next"}>{point.status === "shipped" ? "Shipped" : "Next"}</Tag>
					<h3 class="mt-4 text-[22px] font-[450]">{point.title}</h3>
					<p class="mt-3 text-[15px] text-muted-foreground">{point.body}</p>
				</article>
			{/each}
		</div>
	</div>
</section>

<section class={section} aria-labelledby="facts-title">
	<div class="container-page">
		<h2 id="facts-title" class="display-3">Side by side</h2>
		<p class={lede}>
			The companies and products, fact by fact. Trifold's prices are planned; the hosted service is early access.
			{#if competitor.sources.length}"Not stated" means {competitor.name}'s public pages don't say; it doesn't mean the
				feature is missing.{/if}
		</p>
		<!-- Phones get the facts stacked, one card per fact; the .md mirror reads the table only. -->
		<dl class="mt-7 grid gap-3 md:hidden" data-agent="skip">
			{#each competitor.facts as fact (fact.label)}
				<div class="rounded-lg border border-border bg-card px-4 py-3.5 text-[14.5px]">
					<dt class="label-mono text-[11px]">{fact.label}</dt>
					<dd class="mt-2 grid grid-cols-[76px_1fr] gap-x-3 gap-y-1.5">
						<span class="font-semibold">Trifold</span><span>{fact.trifold}</span>
						<span class="font-semibold">{competitor.name}</span><span class="text-muted-foreground">{fact.them}</span>
					</dd>
				</div>
			{/each}
		</dl>
		<div class="mt-7 hidden overflow-x-auto rounded-lg border border-border bg-card md:block">
			<table class="w-full min-w-[620px] border-collapse text-[14.5px]">
				<caption class="sr-only">Trifold and {competitor.name}, fact by fact</caption>
				<thead>
					<tr>
						<th scope="col" class="label-mono w-[18%] border-b border-line-strong px-4 py-3 text-left text-[11px]"
							><span class="sr-only">Fact</span></th
						>
						<th scope="col" class="label-mono w-[41%] border-b border-line-strong px-4 py-3 text-left text-[11px] text-foreground"
							>Trifold</th
						>
						<th scope="col" class="label-mono w-[41%] border-b border-line-strong px-4 py-3 text-left text-[11px] text-foreground"
							>{competitor.name}</th
						>
					</tr>
				</thead>
				<tbody>
					{#each competitor.facts as fact (fact.label)}
						<tr>
							<th scope="row" class="border-b border-border px-4 py-3 text-left align-top text-[13.5px] font-semibold"
								>{fact.label}</th
							>
							<td class="border-b border-border px-4 py-3 align-top">{fact.trifold}</td>
							<td class="border-b border-border px-4 py-3 align-top text-muted-foreground">{fact.them}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
</section>

<section class={section} aria-labelledby="fits-title">
	<div class="container-page">
		<h2 id="fits-title" class="display-3">Which one fits</h2>
		<div class="mt-7 grid gap-4 md:grid-cols-2">
			<article class="rounded-lg border border-border bg-card p-6">
				<h3 class="text-[22px] font-[450]">Choose {competitor.name} if…</h3>
				<p class="mt-3 text-muted-foreground">{competitor.chooseThem}</p>
			</article>
			<article class="rounded-lg border border-[color-mix(in_srgb,var(--seal)_50%,transparent)] bg-card p-6">
				<h3 class="text-[22px] font-[450]">Choose Trifold if…</h3>
				<p class="mt-3 text-muted-foreground">{competitor.chooseTrifold}</p>
			</article>
		</div>

		<div class="mt-12 border-t border-border pt-5 text-[13px] text-muted-foreground">
			<h2 class="label-mono text-[11px]">{competitor.sources.length ? "Sources" : "Basis"}</h2>
			{#if competitor.basis}<p class="mt-3">{competitor.basis}</p>{/if}
			<ul class="mt-3 grid gap-1.5 empty:hidden">
				{#each competitor.sources as source (source.url)}
					<li>
						{source.label}:
						<a class="text-foreground underline" href={source.url} rel="noopener" target="_blank"
							>{source.url}<span class="sr-only"> (opens in a new tab)</span></a
						>
					</li>
				{/each}
			</ul>
			<p class="mt-3">
				{#if competitor.sources.length}Facts about {competitor.name} checked against its public pages as of
					<span class="num">{competitor.checked}</span>. Prices and features change; check theirs before you decide.
				{:else}Written <span class="num">{competitor.checked}</span>.{/if}
				Corrections:
				<a class="text-foreground underline" href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a>.
				<a class="text-foreground underline" href="/compare">All comparisons</a>.
			</p>
		</div>
	</div>
</section>

<ClosingCta />
