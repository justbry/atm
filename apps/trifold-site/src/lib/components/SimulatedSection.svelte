<script lang="ts">
	/** The "Simulated" block on an audience page: its demo org's card from src/lib/verticals.ts, with every preset. */
	import { verticalBySlug } from "#lib/verticals";
	import VerticalDetail from "./VerticalDetail.svelte";

	/** `lede` replaces the default paragraph, for a page citing another org's simulation (non-profits cite the church). */
	let { slug, title, lede }: { slug: string; title: string; lede?: string } = $props();
	const vertical = $derived(verticalBySlug(slug));
</script>

<div class="grid items-start gap-[clamp(32px,5vw,72px)] md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] [&>*]:min-w-0">
	<div>
		<p class="label-mono">Simulated · invented names · synthetic data</p>
		<h2 class="display-3 mt-3.5 mb-4">{title}</h2>
		<p class="text-muted-foreground [&_a]:underline">
			{lede ??
				`${vertical.org} is invented. A seeded scenario runs its year through the engine, hledger and DuckDB, and all three give the same KPI hash. Run it yourself with the command on the card.`}
			See <a href="/proof#simulations">every preset</a> and <a href="/proof#simplify">where the simulations simplify</a>.
		</p>
	</div>
	<VerticalDetail {vertical} />
</div>
