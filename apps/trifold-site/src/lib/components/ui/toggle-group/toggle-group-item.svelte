<script lang="ts">
	import { ToggleGroup as ToggleGroupPrimitive } from "bits-ui";
	import type { ToggleVariants } from "#lib/components/ui/toggle/index.js";
	import { cn } from "#lib/utils.js";
	import { getToggleGroupCtx } from "./toggle-group.svelte";

	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		size,
		variant,
		...restProps
	}: ToggleGroupPrimitive.ItemProps & ToggleVariants = $props();

	const ctx = getToggleGroupCtx();
</script>

<ToggleGroupPrimitive.Item
	bind:ref
	data-slot="toggle-group-item"
	data-variant={ctx.variant || variant}
	data-size={ctx.size || size}
	data-spacing={ctx.spacing}
	class={cn(
		"inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-full px-4 py-2.5 text-sm font-semibold text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring data-[state=on]:bg-foreground data-[state=on]:text-background",
		className
	)}
	{value}
	{...restProps}
/>
