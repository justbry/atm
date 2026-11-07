<script lang="ts">
	/**
	 * The homepage FAQ as native <details>: the browser gives keyboard support and expanded state for free, and it costs
	 * no JavaScript, which keeps the homepage inside its budget. Styled to match the Accordion used on other pages.
	 */
	import type { FaqItem } from "./Faq.svelte";

	let { items, title = "Questions", id = "faq" }: { items: FaqItem[]; title?: string; id?: string } = $props();
</script>

<section aria-labelledby="{id}-title">
	<h2 id="{id}-title" class="display-3">{title}</h2>
	<div class="mt-7 border-t border-border">
		{#each items as item (item.q)}
			<details class="group border-b border-border">
				<summary
					class="flex cursor-pointer list-none items-center justify-between gap-5 py-5 text-lg font-[550] [&::-webkit-details-marker]:hidden"
				>
					<span>{item.q}</span>
					<span
						class="relative size-3.5 flex-none before:absolute before:inset-x-0 before:top-1/2 before:h-[1.5px] before:bg-muted-foreground after:absolute after:inset-x-0 after:top-1/2 after:h-[1.5px] after:rotate-90 after:bg-muted-foreground after:transition-transform after:duration-300 group-open:after:rotate-0"
						aria-hidden="true"
					></span>
				</summary>
				<p class="max-w-[70ch] pb-5 text-base text-muted-foreground">{item.a}</p>
			</details>
		{/each}
	</div>
</section>
