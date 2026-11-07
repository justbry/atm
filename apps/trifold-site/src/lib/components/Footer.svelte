<script lang="ts">
	import { COMPARE_LINKS } from "#lib/compare/links";
	import { FOOTER, GITHUB_URL } from "#lib/config";
	import AgentNote from "./AgentNote.svelte";
	import Wordmark from "./Wordmark.svelte";

	/** The Compare column follows "For": one link per comparison (src/lib/compare/competitors.ts), then the index. */
	const columns: (typeof FOOTER)[number][] = FOOTER.flatMap((column) =>
		column.title === "For"
			? [column, { title: "Compare", items: [...COMPARE_LINKS, { href: "/compare", label: "All comparisons" }] }]
			: [column],
	);
</script>

<footer class="border-t border-border pt-16 pb-10">
	<div class="container-page">
		<AgentNote />
		<div class="grid gap-12 md:grid-cols-[minmax(220px,1fr)_2.4fr]">
			<div>
				<Wordmark />
				<p class="mt-3.5 font-display text-[19px] text-muted-foreground">Three sides of every dollar.</p>
				<a class="link-arrow mt-4 inline-block text-[15px] text-foreground" href="/verify">Verify a receipt</a>
			</div>
			<nav class="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5" aria-label="Footer">
				{#each columns as column (column.title)}
					<div>
						<h2 class="label-mono mb-3.5 font-mono text-[11.5px] tracking-[0.12em]">{column.title}</h2>
						<ul class="grid gap-2.5">
							{#each column.items as item (item.href)}
								<li>
									{#if item.external}
										<a
											class="text-[15px] text-muted-foreground no-underline hover:text-foreground"
											href={item.href}
											rel="noopener"
											target="_blank">{item.label}<span class="sr-only"> (opens in a new tab)</span></a
										>
									{:else}
										<a class="text-[15px] text-muted-foreground no-underline hover:text-foreground" href={item.href}
											>{item.label}</a
										>
									{/if}
								</li>
							{/each}
						</ul>
					</div>
				{/each}
			</nav>
		</div>
		<div
			class="mt-14 flex flex-wrap justify-between gap-3 border-t border-border pt-6 text-sm text-muted-foreground"
		>
			<p>
				Trifold provides <a class="text-muted-foreground underline" href={GITHUB_URL} rel="noopener" target="_blank"
					>tfd</a
				>, the engine behind it. Source-available on GitHub; each release becomes Apache-2.0 after two years.
			</p>
			<p class="num">© 2026 Trifold · Sample data on this site is invented.</p>
		</div>
	</div>
</footer>
