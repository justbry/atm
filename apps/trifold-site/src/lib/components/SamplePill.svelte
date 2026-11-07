<script lang="ts">
	/** `● SAMPLE LEDGER · 214 PAYMENTS · OCTOBER SEALED`. Never implies a live service; opens the sample. */
	let { active = false, href = "#proof" }: { active?: boolean; href?: string } = $props();
</script>

<a
	{href}
	class="inline-flex flex-wrap items-center gap-2 rounded-full border border-line-strong bg-card/70 px-4 py-2 font-mono text-[11.5px] tracking-[0.14em] text-muted-foreground uppercase no-underline transition-colors hover:border-muted-foreground hover:text-foreground"
>
	<span
		class="size-[7px] rounded-full bg-proof shadow-glow-proof {active ? 'animate-[pulse-dot_0.32s_ease-out_infinite]' : ''}"
		aria-hidden="true"
	></span>
	<span>Sample ledger</span><span class="text-fg-dim" aria-hidden="true">·</span><span>214 payments</span><span
		class="text-fg-dim"
		aria-hidden="true">·</span
	><span>October sealed</span>
</a>
