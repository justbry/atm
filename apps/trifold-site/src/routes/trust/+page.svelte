<script lang="ts">
	import ClosingCta from "#lib/components/ClosingCta.svelte";
	import PageHero from "#lib/components/PageHero.svelte";
	import Seo from "#lib/components/Seo.svelte";
	import Tag from "#lib/components/Tag.svelte";
	import Content from "../../content/trust.md";

	/** "Security, honestly": what exists today and what's planned. No invented certifications or hosting details. */
	const EXISTS = [
		"Ed25519 signatures on every receipt and seal; the verifier runs in your browser and sends nothing",
		"Stripe's webhook signature checked before any event is accepted",
		"Append-only events; corrections are new events",
		"Personal fields kept apart from the books, so personal data can be erased without breaking them",
		"Key rotation that keeps old receipts and seals verifying",
		"Engine source public on GitHub, so the checks can be read",
	];
	const PLANNED = [
		["Data region and encryption at rest", "Published before the hosted service opens"],
		["Where signing keys live in the hosted service", "Published before the hosted service opens"],
		["SOC 2", "Target date to be announced"],
		["Independent penetration test", "Target date to be announced"],
		["Trifold as independent witness, public transparency log", "Next; no date promised"],
		["Status page and incident history", "When the hosted service opens"],
	] as const;
</script>

<Seo
	title="Trust"
	description="Provable, durable, resilient and fast: what Trifold claims today, what it doesn't yet, security in plain words, and how to verify us yourself."
/>

<PageHero
	eyebrow="Trust"
	title="Don't take our word for it."
	lede="What we claim, what we don't yet, and how to check every part of it yourself."
/>

<section class="border-t border-border py-[clamp(48px,6vw,88px)]">
	<div class="container-page"><div class="prose"><Content /></div></div>
</section>

<section class="border-t border-border py-[clamp(48px,6vw,88px)]" aria-labelledby="security-title">
	<div class="container-page">
		<p class="label-mono">Security, honestly</p>
		<h2 id="security-title" class="display-3 mt-4 max-w-[24ch]">What exists today, and what's planned.</h2>
		<p class="lede mt-4">
			The hosted service isn't open yet, so we don't claim certifications or hosting details we don't have. Data region
			and encryption details will be published before Cloud launches.
		</p>
		<div class="mt-8 grid gap-4 md:grid-cols-2">
			<div class="rounded-lg border border-border bg-card p-6">
				<p class="flex items-center gap-2.5"><Tag tone="today">Today</Tag><span class="font-semibold">Exists</span></p>
				<ul class="mt-4 grid gap-2.5 text-[15px] text-muted-foreground">
					{#each EXISTS as item (item)}
						<li class="flex gap-2.5"><span class="font-bold text-proof-text" aria-hidden="true">✓</span>{item}</li>
					{/each}
				</ul>
			</div>
			<div class="rounded-lg border border-dashed border-fg-dim p-6">
				<p class="flex items-center gap-2.5"><Tag tone="next">Planned</Tag><span class="font-semibold">Not yet</span></p>
				<dl class="mt-4 grid gap-3 text-[15px]">
					{#each PLANNED as [what, when] (what)}
						<div class="grid gap-0.5 border-b border-border pb-3 last:border-0">
							<dt>{what}</dt>
							<dd class="font-mono text-xs tracking-[0.06em] text-muted-foreground uppercase">{when}</dd>
						</div>
					{/each}
				</dl>
			</div>
		</div>
	</div>
</section>

<ClosingCta />
