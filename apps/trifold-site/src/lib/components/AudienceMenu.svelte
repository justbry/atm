<script lang="ts">
	/**
	 * "Who it's for" in the header: the label links to the /for hub (so it works without JS); the chevron is a disclosure
	 * button that opens the grouped audience menu. Esc closes it and returns focus to the button; a click outside or a
	 * route change closes it. The panel is in the static HTML (hidden), and skipped in the .md mirrors.
	 */
	import { afterNavigate } from "$app/navigation";
	import { AUDIENCE_GROUPS } from "#lib/config";

	let { label, current = false }: { label: string; current?: boolean } = $props();

	let open = $state(false);
	let root = $state<HTMLElement>();
	let button = $state<HTMLButtonElement>();

	afterNavigate(() => {
		open = false;
	});

	function onKeydown(event: KeyboardEvent) {
		if (open && event.key === "Escape") {
			open = false;
			button?.focus();
		}
	}
	function onPointerdown(event: PointerEvent) {
		if (open && root && !root.contains(event.target as Node)) open = false;
	}
</script>

<svelte:window onkeydown={onKeydown} onpointerdown={onPointerdown} />

<div class="relative flex items-center gap-1" bind:this={root}>
	<a
		href="/for"
		aria-current={current ? "page" : undefined}
		class="label-mono py-1.5 no-underline transition-colors hover:text-foreground aria-[current=page]:text-foreground aria-[current=page]:shadow-[0_1px_0_var(--seal)]"
		>{label}</a
	>
	<button
		bind:this={button}
		type="button"
		class="grid size-7 cursor-pointer place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground aria-expanded:text-foreground"
		aria-expanded={open}
		aria-controls="audience-menu"
		onclick={() => (open = !open)}
	>
		<span class="sr-only">Show who it's for</span>
		<svg viewBox="0 0 12 12" class="size-3 transition-transform duration-300 {open ? 'rotate-180' : ''}" aria-hidden="true">
			<path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
		</svg>
	</button>
	<div
		id="audience-menu"
		hidden={!open}
		data-agent="skip"
		class="absolute top-full left-1/2 z-50 mt-3 w-[min(760px,calc(100vw-48px))] -translate-x-1/2 rounded-lg border border-border bg-popover p-5 shadow-card"
	>
		<div class="grid grid-cols-3 gap-x-5 gap-y-4">
			{#each AUDIENCE_GROUPS as group, index (group.title)}
				<!-- Everyone runs across the top; the three groups sit below it in columns. -->
				<div class={index === 0 ? "col-span-3 border-b border-border pb-3" : ""}>
					{#if index > 0}<p class="label-mono mb-2 px-2.5 text-[10.5px]">{group.title}</p>{/if}
					<ul class="grid gap-0.5">
						{#each group.items as item (item.href)}
							<li>
								<a
									href={item.href}
									class="block rounded-md px-2.5 py-2 no-underline transition-colors hover:bg-foreground/5 focus-visible:bg-foreground/5"
								>
									<span class="block text-[15px] font-semibold text-foreground">{item.label}</span>
									<span class="block text-[13px] text-muted-foreground">{item.description}</span>
								</a>
							</li>
						{/each}
					</ul>
				</div>
			{/each}
		</div>
	</div>
</div>
