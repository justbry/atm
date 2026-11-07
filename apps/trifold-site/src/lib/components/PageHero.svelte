<script lang="ts">
	import type { Snippet } from "svelte";
	let { eyebrow, title, lede, children }: { eyebrow: string; title: string; lede?: string; children?: Snippet } =
		$props();
</script>

<section class="relative overflow-hidden pt-[clamp(64px,9vw,120px)] pb-[clamp(40px,5vw,64px)]">
	<div
		class="pointer-events-none absolute -top-[40%] right-[30%] -left-[10%] -z-10 hidden h-[120%] bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--seal)_8%,transparent),transparent)] dark:block"
		aria-hidden="true"
	></div>
	<div class="container-page">
		<p class="label-mono mb-5">{eyebrow}</p>
		<h1 class="display-2 max-w-[20ch]">{title}</h1>
		{#if lede}<p class="lede mt-5">{lede}</p>{/if}
		{#if children}<div class="mt-8">{@render children()}</div>{/if}
	</div>
</section>
