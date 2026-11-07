<script lang="ts">
	/** One verified preset run on a card: the run, three headline numbers with their KPI names, and its describe command. */
	import type { PresetView } from "#lib/verticals";

	let { preset, what, note }: { preset: PresetView; what?: string; note?: string } = $props();
</script>

<div class="grid gap-3 border-t border-border pt-4" data-preset={preset.name}>
	<p class="num text-[12px] text-muted-foreground">{preset.name} · seed {preset.seed} · {preset.months}</p>
	{#if what}<p class="-mt-1.5 text-[14px] text-muted-foreground">{what}</p>{/if}
	<dl class="grid gap-2">
		{#each preset.stats as stat (stat.kpi)}
			<div class="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-x-4">
				<dt class="col-start-2 row-start-1 text-[14px] leading-snug text-muted-foreground">
					{stat.label} <span class="num block text-[10.5px] text-fg-dim">{stat.kpi}</span>
				</dt>
				<dd class="num col-start-1 row-start-1 text-[19px] text-foreground">{stat.value}</dd>
			</div>
		{/each}
	</dl>
	{#if note}<p class="text-[13px] text-muted-foreground">{note}</p>{/if}
	<p class="num overflow-x-auto text-[12px] whitespace-nowrap text-muted-foreground">
		<span class="text-proof-text" aria-hidden="true">$</span> scenarios describe {preset.name}
	</p>
</div>
