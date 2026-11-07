<script lang="ts" module>
	import { type VariantProps, tv } from "tailwind-variants/lite";
	import { cn, type WithElementRef } from "#lib/utils.js";
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";

	/** Trifold's buttons: saffron pill (primary), outline pill (secondary), a code-styled CLI button, and text. */
	export const buttonVariants = tv({
		base: "group/button inline-flex shrink-0 cursor-pointer items-center justify-center gap-2.5 whitespace-nowrap border font-semibold no-underline transition-all duration-300 ease-brand outline-none select-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-3 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
		variants: {
			variant: {
				default: "rounded-full border-transparent bg-primary text-primary-foreground hover:-translate-y-px hover:shadow-glow-seal",
				outline: "rounded-full border-line-strong bg-transparent text-foreground hover:border-muted-foreground hover:bg-foreground/5",
				code: "rounded-md border-line-strong bg-card font-mono font-medium text-foreground before:text-proof-text before:content-['$'] hover:border-proof",
				ghost: "rounded-full border-transparent text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
				subtle: "rounded-full border-border text-muted-foreground hover:border-line-strong hover:text-foreground",
				link: "border-transparent text-foreground underline-offset-4 hover:underline",
			},
			size: {
				default: "h-12 px-[22px] text-[15px]",
				sm: "h-[38px] px-4 text-sm",
				icon: "size-10 rounded-full",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>["variant"];
	export type ButtonSize = VariantProps<typeof buttonVariants>["size"];

	export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
		WithElementRef<HTMLAnchorAttributes> & {
			variant?: ButtonVariant;
			size?: ButtonSize;
		};
</script>

<script lang="ts">
	let {
		class: className,
		variant = "default",
		size = "default",
		ref = $bindable(null),
		href = undefined,
		type = "button",
		disabled,
		children,
		...restProps
	}: ButtonProps = $props();
</script>

{#if href}
	<a
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		href={disabled ? undefined : href}
		aria-disabled={disabled}
		role={disabled ? "link" : undefined}
		tabindex={disabled ? -1 : undefined}
		{...restProps}
	>
		{@render children?.()}
	</a>
{:else}
	<button
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		{type}
		{disabled}
		{...restProps}
	>
		{@render children?.()}
	</button>
{/if}
