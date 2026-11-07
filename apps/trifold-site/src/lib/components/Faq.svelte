<script lang="ts" module>
	export type FaqItem = { q: string; a: string };
</script>

<script lang="ts">
	/** FAQ on shadcn-svelte's Accordion (bits-ui): keyboard-operable, aria-expanded, one heading level per question. */
	import * as Accordion from "#lib/components/ui/accordion";

	let { items, title = "Questions", id = "faq" }: { items: FaqItem[]; title?: string; id?: string } = $props();
</script>

<section aria-labelledby="{id}-title">
	<h2 id="{id}-title" class="display-3">{title}</h2>
	<Accordion.Root type="multiple" class="mt-7 border-t border-border">
		{#each items as item, index (item.q)}
			<Accordion.Item value="{id}-{index}">
				<Accordion.Trigger>{item.q}</Accordion.Trigger>
				<Accordion.Content>
					<p class="max-w-[70ch]">{item.a}</p>
				</Accordion.Content>
			</Accordion.Item>
		{/each}
	</Accordion.Root>
</section>
