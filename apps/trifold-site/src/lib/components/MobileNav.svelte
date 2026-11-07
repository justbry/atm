<script lang="ts">
	/** The mobile menu: shadcn-svelte's Sheet (a bits-ui dialog, focus-trapped, Esc to close). Loaded on first open. */
	import { page } from "$app/state";
	import { AUDIENCE_GROUPS, NAV } from "#lib/config";
	import * as Sheet from "#lib/components/ui/sheet";
	import { Button } from "#lib/components/ui/button";

	let { open = $bindable(false) }: { open?: boolean } = $props();
	const isCurrent = (href: string) => page.url.pathname === href || page.url.pathname.startsWith(`${href}/`);
</script>

<Sheet.Root bind:open>
	<Sheet.Content side="right">
		<Sheet.Header>
			<Sheet.Title><span class="label-mono">Menu</span></Sheet.Title>
		</Sheet.Header>
		<nav aria-label="Main, mobile" class="mt-4">
			<ul class="grid">
				{#each NAV as item (item.href)}
					<li>
						{#if item.menu}
							<!-- Native disclosure: the same groups as the header's menu. -->
							<details class="group border-b border-border">
								<summary
									class="label-mono flex cursor-pointer list-none items-center justify-between py-4 text-[13px] [&::-webkit-details-marker]:hidden"
									>{item.label}<span class="transition-transform group-open:rotate-180" aria-hidden="true">▾</span></summary
								>
								<div class="grid gap-4 pb-4">
									{#each AUDIENCE_GROUPS as group (group.title)}
										<div>
											<p class="label-mono mb-1 text-[10.5px]">{group.title}</p>
											<ul class="grid">
												{#each group.items as audience (audience.href)}
													<li>
														<a
															href={audience.href}
															onclick={() => (open = false)}
															aria-current={page.url.pathname === audience.href ? "page" : undefined}
															class="block py-1.5 text-[15px] text-foreground no-underline aria-[current=page]:font-semibold"
															>{audience.label}</a
														>
													</li>
												{/each}
											</ul>
										</div>
									{/each}
								</div>
							</details>
						{:else}
						<a
							href={item.href}
							onclick={() => (open = false)}
							aria-current={isCurrent(item.href) ? "page" : undefined}
							class="label-mono block border-b border-border py-4 text-[13px] no-underline aria-[current=page]:text-foreground"
							>{item.label}</a
						>
						{/if}
					</li>
				{/each}
			</ul>
			<Button href="/early-access" class="mt-6 w-full" onclick={() => (open = false)}>Get early access</Button>
		</nav>
	</Sheet.Content>
</Sheet.Root>
