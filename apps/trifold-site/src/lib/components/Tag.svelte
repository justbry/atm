<script lang="ts">
	/** Today / Next / Later (and "soon", "placeholder") tags: staging said in text, not only by color. */
	import type { Snippet } from "svelte";
	let { tone = "plain", children }: { tone?: "today" | "next" | "later" | "plain"; children: Snippet } = $props();
	const tones = {
		today: "text-proof-text border-[color-mix(in_srgb,var(--proof)_45%,transparent)]",
		next: "text-ember-text border-[color-mix(in_srgb,var(--ember)_50%,transparent)]",
		later: "text-muted-foreground border-dashed border-line-strong",
		plain: "text-muted-foreground border-line-strong",
	};
</script>

<span
	class="inline-flex items-center gap-1.5 rounded-full border px-2 py-1 align-middle font-mono text-[11px] leading-none font-semibold tracking-[0.1em] uppercase {tones[
		tone
	]}">{@render children()}</span
>
