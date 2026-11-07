<script lang="ts">
	import ClosingCta from "#lib/components/ClosingCta.svelte";
	import PageHero from "#lib/components/PageHero.svelte";
	import Seo from "#lib/components/Seo.svelte";
	import Content from "../../content/about.md";
</script>

<Seo
	title="About"
	description="Why Trifold exists, the principles behind it, and how Trifold relates to tfd, the engine whose source is public on GitHub."
/>

<PageHero eyebrow="About" title="Books should show their work." lede="Why Trifold exists, what we hold to, and who's behind it." />

<section class="border-t border-border py-[clamp(48px,6vw,88px)]">
	<div class="container-page"><div class="prose"><Content /></div></div>
</section>

<ClosingCta />
