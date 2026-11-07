<script lang="ts">
	/** The verticals as compact cards (src/lib/gallery.ts): the school first and wide, then two by two. */
	import { GALLERY } from "#lib/gallery";
	import VerticalCard from "./VerticalCard.svelte";

	// sm: 1 wide + 2 + 2; lg: 3 + 3 on the first row, then 2 + 2 + 2.
	const span = (index: number) => (index === 0 ? "sm:col-span-2 lg:col-span-3" : index === 1 ? "lg:col-span-3" : "lg:col-span-2");
</script>

<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
	{#each GALLERY as card, index (card.slug)}
		<VerticalCard {card} class={span(index)} />
	{/each}
</div>
