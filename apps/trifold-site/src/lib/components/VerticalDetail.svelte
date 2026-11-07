<script lang="ts">
	/**
	 * A simulated org in full, for its audience page: what's modelled, every verified preset and the KPIs it produces.
	 * No dashboard and no demo link; the numbers come from the CLI.
	 */
	import { presetView, SCENARIO_ORGS_URL, type Vertical } from "#lib/verticals";
	import PresetStats from "./PresetStats.svelte";
	import Tag from "./Tag.svelte";

	let { vertical }: { vertical: Vertical } = $props();
	const label = "label-mono mb-2 text-[11px]";
</script>

<article
	class="flex flex-col gap-4 rounded-lg border border-border px-6 py-[22px] text-[15px]"
	data-vertical={vertical.slug}
	data-status={vertical.status}
>
	<header class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
		<h3 class="text-[22px] font-[420]">{vertical.name}</h3>
		<Tag>Simulated</Tag>
	</header>
	<p class="-mt-2 text-muted-foreground">{vertical.org}, {vertical.orgKind}.</p>
	<p class="label-mono text-[11px] normal-case tracking-[0.04em]">In their words: {vertical.vocabulary.join(" · ")}</p>
	<div>
		<p class={label}>What's modelled</p>
		<ul class="grid gap-1 text-muted-foreground">
			{#each vertical.simulates as item (item)}
				<li class="flex gap-2"><span class="text-fg-dim" aria-hidden="true">–</span>{item}</li>
			{/each}
		</ul>
	</div>
	{#each vertical.presets as preset (preset.name)}
		<PresetStats
			preset={presetView(vertical, preset)}
			what={preset.what}
			note={preset.payingNote ? `Paying members last month is 0: ${preset.payingNote}.` : undefined}
		/>
	{/each}
	<div>
		<p class={label}>KPIs each preset produces</p>
		<p class="text-[14px] text-muted-foreground">{vertical.kpis.join(" · ")}</p>
	</div>
	<p class="mt-auto pt-1 text-[15px]">
		<a class="font-semibold text-foreground underline" href={SCENARIO_ORGS_URL} rel="noopener" target="_blank"
			>How the orgs are simulated ↗<span class="sr-only"> (opens in a new tab)</span></a
		>
	</p>
</article>
