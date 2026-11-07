<script lang="ts">
	/**
	 * "Same numbers, three ways": one seeded sample year goes through the engine, hledger and DuckDB, and each prints the
	 * same KPI hash (the seed-7 run in src/lib/content/proof.ts). Plain HTML: three columns on desktop, stacked on mobile.
	 */
	import { SEED_7_EVENTS, SEED_7_HASH, SEED_7_HASH_SHORT } from "#lib/content/proof-summary";

	const CHANNELS = [
		{ name: "The engine", how: "Trifold's own fold" },
		{ name: "hledger", how: "plain-text accounting" },
		{ name: "DuckDB", how: "SQL over the events" },
	] as const;
	const line = "bg-line-strong";
	// On desktop, a branch line joins the centres of the outer columns (allowing for the 1.25rem gaps).
	const branch =
		"md:before:absolute md:before:top-0 md:before:h-px md:before:bg-line-strong md:before:left-[calc((100%-2.5rem)/6)] md:before:right-[calc((100%-2.5rem)/6)]";
</script>

<figure class="m-0">
	<div class="mx-auto max-w-[420px] rounded-lg border border-border bg-card px-5 py-4 text-center shadow-card">
		<p class="font-semibold">One sample school year</p>
		<p class="num mt-1 text-[13px] text-muted-foreground">
			growth-12mo · seed 7 · {SEED_7_EVENTS.toLocaleString("en-US")} events
		</p>
	</div>
	<div class="mx-auto h-6 w-px {line}" aria-hidden="true"></div>
	<ol class="relative grid gap-3 md:grid-cols-3 md:gap-5 {branch}">
		{#each CHANNELS as channel (channel.name)}
			<li class="relative md:pt-6">
				<span class="absolute top-0 left-1/2 hidden h-6 w-px md:block {line}" aria-hidden="true"></span>
				<div class="grid h-full content-start justify-items-center gap-1 rounded-lg border border-border bg-card px-4 py-4 text-center">
					<p class="font-semibold">{channel.name}</p>
					<p class="text-sm text-muted-foreground">{channel.how}</p>
					<p class="num mt-2 text-[13px] text-foreground" title={SEED_7_HASH}>
						<span class="sr-only">KPI hash </span>{SEED_7_HASH_SHORT}
					</p>
					<p class="font-mono text-[12px] font-semibold tracking-[0.08em] text-proof-text uppercase">
						<span aria-hidden="true">✓</span> same hash
					</p>
				</div>
			</li>
		{/each}
	</ol>
	<figcaption class="mt-4 text-center text-sm text-muted-foreground">
		One KPI hash per channel. All three match, so the three tools agree on every KPI.
	</figcaption>
</figure>
