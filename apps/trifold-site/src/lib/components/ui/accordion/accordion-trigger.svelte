<script lang="ts">
	import { Accordion as AccordionPrimitive } from "bits-ui";
	import { cn, type WithoutChild } from "#lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		level = 3,
		children,
		...restProps
	}: WithoutChild<AccordionPrimitive.TriggerProps> & {
		level?: AccordionPrimitive.HeaderProps["level"];
	} = $props();
</script>

<AccordionPrimitive.Header {level} class="flex">
	<AccordionPrimitive.Trigger
		data-slot="accordion-trigger"
		bind:ref
		class={cn(
			"group/accordion-trigger relative flex flex-1 items-center justify-between gap-5 py-5 text-left text-lg font-[550] transition-all outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50",
			className
		)}
		{...restProps}
	>
		{@render children?.()}
		<span
			class="relative size-3.5 flex-none before:absolute before:inset-x-0 before:top-1/2 before:h-[1.5px] before:bg-muted-foreground after:absolute after:inset-x-0 after:top-1/2 after:h-[1.5px] after:rotate-90 after:bg-muted-foreground after:transition-transform after:duration-300 group-aria-expanded/accordion-trigger:after:rotate-0"
			aria-hidden="true"
		></span>
	</AccordionPrimitive.Trigger>
</AccordionPrimitive.Header>
