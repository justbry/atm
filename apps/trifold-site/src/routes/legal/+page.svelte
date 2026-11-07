<script lang="ts">
	import PageHero from "#lib/components/PageHero.svelte";
	import Seo from "#lib/components/Seo.svelte";
	import Content from "../../content/legal.md";
</script>

<Seo title="Legal (draft)" description="Draft placeholders for Trifold's terms, privacy and trademark policies." noindex />

<PageHero eyebrow="Legal · draft" title="Terms, privacy and trademarks." lede="Placeholders until a lawyer drafts the real ones.">
	<nav class="flex flex-wrap gap-[18px] [&_a]:label-mono" aria-label="On this page">
		<a href="#terms">Terms</a><a href="#privacy">Privacy</a><a href="#trademark">Trademark</a><a href="#notices">Notices</a>
	</nav>
</PageHero>

<section class="border-t border-border pt-[clamp(48px,6vw,88px)] pb-[clamp(72px,10vw,140px)]">
	<div class="container-page"><div class="prose"><Content /></div></div>
</section>
