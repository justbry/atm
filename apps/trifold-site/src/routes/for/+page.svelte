<script lang="ts">
	import ClosingCta from "#lib/components/ClosingCta.svelte";
	import PageHero from "#lib/components/PageHero.svelte";
	import Seo from "#lib/components/Seo.svelte";
	import Tag from "#lib/components/Tag.svelte";
	import { AUDIENCE_GROUPS } from "#lib/config";
	import { UNIFIED_LINE } from "#lib/content/proof-summary";
	import { VERTICALS } from "#lib/verticals";

	/** The /for hub: every audience, grouped as in the header's menu, in its own words where a vertical has them. */
	const GROUPS = AUDIENCE_GROUPS.filter((group) => group.title !== "Everyone");
	const verticalFor = (href: string) => VERTICALS.find((vertical) => vertical.forPage === href);
</script>

<Seo
	title="Who it's for"
	description="Schools, churches, non-profits, studios, SaaS products and creators: the same engine and the same proof for every organization that takes payments through Stripe."
/>

<PageHero
	eyebrow="Who it's for · everyone paid through Stripe"
	title="Books that show their work, whoever pays you."
	lede="Every payment through Stripe becomes balanced books and a signed receipt anyone can check, and every month can be sealed. The same engine and the same proof, for every organization. What changes is the words, not the checks."
/>

<section class="border-t border-border py-[clamp(48px,6vw,88px)]" aria-label="Audiences">
	<div class="container-page grid gap-[clamp(40px,5vw,64px)]">
		{#each GROUPS as group (group.title)}
			<div>
				<h2 class="label-mono font-mono">{group.title}</h2>
				<ul class="mt-4 grid gap-4 md:grid-cols-3">
					{#each group.items as item (item.href)}
						{@const vertical = verticalFor(item.href)}
						<li>
							<a
								href={item.href}
								class="flex h-full flex-col gap-3 rounded-lg border border-border bg-card px-6 py-5 text-foreground no-underline shadow-card transition-transform duration-300 ease-brand hover:-translate-y-0.5"
							>
								<span class="flex flex-wrap items-center justify-between gap-2">
									<span class="text-[21px] font-[420] [font-family:var(--font-display)]">{item.label}</span>
									{#if vertical?.status === "dashboard"}<Tag tone="today">Live dashboard</Tag>{:else if vertical}<Tag
											>Simulated</Tag
										>{/if}
								</span>
								<span class="text-muted-foreground">{item.description}.</span>
								{#if vertical}
									<span class="label-mono text-[11px] normal-case tracking-[0.04em]"
										>In their words: {vertical.vocabulary.join(" · ")}</span
									>
									<span class="text-sm text-muted-foreground">{vertical.org}, {vertical.orgKind}.</span>
								{/if}
								<span class="link-arrow mt-auto self-start text-[15px]">{item.label}</span>
							</a>
						</li>
					{/each}
				</ul>
			</div>
		{/each}
	</div>
</section>

<section class="border-t border-border py-[clamp(48px,6vw,88px)]">
	<div class="container-page grid gap-6 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] md:items-end">
		<div>
			<p class="label-mono">The same proof</p>
			<p class="display-3 mt-4 max-w-[30ch]">{UNIFIED_LINE}</p>
			<p class="mt-5 max-w-[60ch] text-muted-foreground">
				Every organization named on this site is invented, and its data is synthetic.
				<a class="text-foreground underline" href="/proof#simulations">See every simulated preset</a>.
			</p>
		</div>
		<p class="text-[15px] md:justify-self-end"><a class="link-arrow text-foreground" href="/proof">See the proof</a></p>
	</div>
</section>

<ClosingCta />
