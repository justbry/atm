<script lang="ts">
	import Mark from "./Mark.svelte";
	let { size = 26, class: className = "" }: { size?: number; class?: string } = $props();
</script>

<span class="inline-flex items-center gap-2.5 {className}">
	<Mark {size} />
	<span
		class="font-display text-[23px] leading-none font-[450] tracking-[-0.015em] text-foreground [font-variation-settings:'opsz'_72,'SOFT'_80]"
		>Trifold</span
	>
</span>
