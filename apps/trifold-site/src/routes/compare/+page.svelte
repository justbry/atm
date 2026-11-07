<script lang="ts">
	import ClosingCta from "#lib/components/ClosingCta.svelte";
	import PageHero from "#lib/components/PageHero.svelte";
	import Seo from "#lib/components/Seo.svelte";
	import {
		COMPETITORS,
		compareHref,
		LAST_CHECKED,
		type Mark,
		SUMMARY_COLUMNS,
		TRIFOLD_SUMMARY,
	} from "#lib/compare/competitors";
	import { CONTACT_EMAIL } from "#lib/config";

	const rows = [
		{ name: "Trifold", href: "", summary: TRIFOLD_SUMMARY },
		...COMPETITORS.map((competitor) => ({
			name: competitor.name,
			href: compareHref(competitor.slug),
			summary: competitor.summary,
		})),
	];
	const cell = "border-b border-border px-3.5 py-3 align-top";
	/** The card shows the meta description without its "Trifold vs X:" lead, which the card's heading already says. */
	const LEAD = /^Trifold vs [^:]+: /;
	const blurb = (oneLine: string) => {
		const text = oneLine.replace(LEAD, "");
		return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
	};
</script>

<Seo
	title="Trifold compared"
	description="How Trifold compares with other ways to keep the books: price, free plan, AI, who can check a receipt, export and self-hosting. Fair, sourced, and dated."
/>

<PageHero
	eyebrow="Compare"
	title="Trifold compared"
	lede="How Trifold sits beside the tools you might use instead. Each comparison starts with where the other product is strongest, every claim about it comes from its own public pages, and Trifold's side says what's shipped and what's next."
/>

{#snippet mark(value: Mark)}
	{#if value === true}
		<span class="text-[15px] font-extrabold text-proof-text" aria-hidden="true">✓</span><span class="sr-only">Yes</span>
	{:else if value === false}
		<span class="font-bold text-fg-dim" aria-hidden="true">✗</span><span class="sr-only">No</span>
	{:else}
		{value}
	{/if}
{/snippet}

<section class="border-t border-border py-[clamp(48px,6vw,88px)]" aria-labelledby="summary-title">
	<div class="container-page">
		<h2 id="summary-title" class="display-3">At a glance</h2>
		<p class="mt-2.5 mb-6 max-w-[760px] text-muted-foreground">
			Trifold's hosted service is early access, so its prices and free plan are planned. "Not stated" means the other
			product's public pages don't say; it doesn't mean the feature is missing.
		</p>
		<div class="overflow-x-auto rounded-lg border border-border bg-card">
			<table class="w-full min-w-[980px] border-separate border-spacing-0 text-[13.5px]">
				<caption class="sr-only">Trifold and each compared product, side by side</caption>
				<thead>
					<tr>
						<th scope="col" class="label-mono sticky left-0 z-10 border-b border-line-strong bg-card px-3.5 py-3 text-left align-bottom text-[11px]"
							>Product</th
						>
						{#each SUMMARY_COLUMNS as column (column.key)}
							<th scope="col" class="label-mono border-b border-line-strong px-3.5 py-3 text-left align-bottom text-[11px]"
								>{column.label}</th
							>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each rows as row (row.name)}
						<tr class={row.href ? "" : "bg-[color-mix(in_srgb,var(--seal)_8%,transparent)]"}>
							<th
								scope="row"
								class="{cell} sticky left-0 z-10 text-left font-display text-[17px] font-[450] {row.href
									? 'bg-card'
									: 'bg-[color-mix(in_srgb,var(--seal)_8%,var(--card))]'}"
							>
								{#if row.href}<a class="underline decoration-line-strong hover:decoration-current" href={row.href}>{row.name}</a
									>{:else}{row.name}{/if}
							</th>
							{#each SUMMARY_COLUMNS as column (column.key)}
								<td class={cell}>{@render mark(row.summary[column.key])}</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
</section>

<section class="border-t border-border py-[clamp(48px,6vw,88px)]" aria-labelledby="one-on-one-title">
	<div class="container-page">
		<h2 id="one-on-one-title" class="display-3">One on one</h2>
		<ul class="mt-7 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
			{#each COMPETITORS as competitor (competitor.slug)}
				<!-- The heading's link covers the card (after:inset-0), so the card is one link without nesting everything in it. -->
				<li
					class="relative flex h-full flex-col gap-3 rounded-lg border border-border bg-card p-6 shadow-card transition-transform duration-300 ease-brand focus-within:-translate-y-0.5 hover:-translate-y-0.5"
				>
					<p class="label-mono">Trifold vs</p>
					<h3 class="text-[28px] leading-none font-[420]">
						<a class="no-underline after:absolute after:inset-0 after:rounded-lg" href={compareHref(competitor.slug)}>{competitor.name}</a>
					</h3>
					{#if competitor.tagline}<p class="text-sm text-muted-foreground italic">“{competitor.tagline}”</p>{/if}
					<p class="text-[15px] text-muted-foreground">{blurb(competitor.oneLine)}</p>
					<span class="link-arrow mt-auto self-start pt-2 text-[15px] text-foreground" aria-hidden="true" data-agent="skip"
						>Read the comparison</span
					>
				</li>
			{/each}
		</ul>
		<p class="mt-10 border-t border-border pt-4 text-[13px] text-muted-foreground">
			Checked against public pages as of <span class="num">{LAST_CHECKED}</span>. Spotted something wrong or out of date?
			Corrections: <a class="text-foreground underline" href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a>.
		</p>
	</div>
</section>

<ClosingCta />
