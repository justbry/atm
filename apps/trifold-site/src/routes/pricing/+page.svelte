<script lang="ts">
	import PageHero from "#lib/components/PageHero.svelte";
	import Pricing from "#lib/components/Pricing.svelte";
	import Seo from "#lib/components/Seo.svelte";
</script>

<Seo
	title="Pricing"
	description="Planned Trifold pricing: monthly or annual, for-profit or non-profit, with a full comparison. No per-seat fees, no per-transaction fees. Design partners are free during the pilot."
/>

<PageHero
	eyebrow="Pricing · planned"
	title="Priced so anyone can start."
	lede="The engine's source is public on GitHub. Pay when you want Trifold to host it, automate it and, once the witness ships, stand behind it as an independent witness."
/>

<section class="pb-[clamp(72px,10vw,140px)]">
	<div class="container-page">
		<Pricing />
		<p class="mt-6 text-[15px]"><a class="link-arrow text-foreground" href="/compare">How Trifold compares</a></p>
	</div>
</section>
