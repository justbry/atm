<script lang="ts">
	/**
	 * A compact gallery card (src/lib/gallery.ts). The school's links its live dashboard; a simulated org's shows its
	 * headline preset's numbers and the command that describes it: no dashboard, no demo link.
	 */
	import type { GalleryCard } from "#lib/verticals";
	import PresetStats from "./PresetStats.svelte";
	import Tag from "./Tag.svelte";

	let { card, class: className = "" }: { card: GalleryCard; class?: string } = $props();

	const FOR_LABEL: Record<string, string> = {
		"/for/schools": "For schools",
		"/for/churches": "For churches",
		"/for/studios": "For studios and gyms",
		"/for/saas": "For SaaS",
		"/for/creators": "For creators",
	};
	const dashboard = $derived(card.status === "dashboard");
	const label = "label-mono mb-2 text-[11px]";
</script>

<article
	class="flex flex-col gap-4 rounded-lg border border-border px-6 py-[22px] text-[15px] {dashboard
		? 'bg-card shadow-card'
		: ''} {className}"
	data-vertical={card.slug}
	data-status={card.status}
>
	<header class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
		<h3 class="text-[22px] font-[420]">{card.name}</h3>
		{#if dashboard}<Tag tone="today">Live dashboard</Tag>{:else}<Tag>Simulated</Tag>{/if}
	</header>
	<p class="-mt-2 text-muted-foreground">{card.org}, {card.orgKind}.</p>
	{#if card.vocabulary}
		<p class="label-mono text-[11px] normal-case tracking-[0.04em]">In their words: {card.vocabulary.join(" · ")}</p>
	{/if}
	{#if card.simulates}
		<div>
			<p class={label}>Simulates</p>
			<ul class="grid gap-1 text-muted-foreground">
				{#each card.simulates as item (item)}
					<li class="flex gap-2"><span class="text-fg-dim" aria-hidden="true">–</span>{item}</li>
				{/each}
			</ul>
		</div>
	{/if}
	{#if card.kpis}
		<div>
			<p class={label}>The dashboard shows</p>
			<p class="text-muted-foreground">{card.kpis.join(" · ")}</p>
		</div>
	{/if}
	{#if card.preset}<PresetStats preset={card.preset} />{/if}
	<p class="mt-auto flex flex-wrap gap-x-5 gap-y-2 pt-1 text-[15px]">
		{#if card.demoUrl}
			<a class="font-semibold text-foreground underline" href={card.demoUrl} rel="noopener" target="_blank"
				>Open the live demo ↗<span class="sr-only"> (opens in a new tab)</span></a
			>
		{/if}
		{#if card.forPage}<a class="link-arrow text-foreground" href={card.forPage}>{FOR_LABEL[card.forPage] ?? "Read more"}</a>{/if}
		{#if !dashboard}<a class="link-arrow text-foreground" href="/proof#simulations">Every preset</a>{/if}
	</p>
</article>
