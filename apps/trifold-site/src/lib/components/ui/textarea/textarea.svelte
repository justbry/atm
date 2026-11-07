<script lang="ts">
	import { cn, type WithElementRef, type WithoutChildren } from "#lib/utils.js";
	import type { HTMLTextareaAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		"data-slot": dataSlot = "textarea",
		...restProps
	}: WithoutChildren<WithElementRef<HTMLTextareaAttributes>> = $props();
</script>

<textarea
	bind:this={ref}
	data-slot={dataSlot}
	class={cn(
		"border-border aria-invalid:border-destructive rounded-md border bg-sunk px-3.5 py-3 font-mono text-[13px] leading-[1.55] text-foreground transition-[color,box-shadow] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-ring flex w-full resize-y outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
		className
	)}
	bind:value
	{...restProps}></textarea>
