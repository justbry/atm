<script lang="ts">
	import { Button } from "#lib/components/ui/button";
	import Mark from "./Mark.svelte";
	import ThreeChecks from "./ThreeChecks.svelte";

	type Link = { href: string; label: string; external?: boolean };
	let {
		title = "Every dollar, three ways. Every month, sealed.",
		primary = { href: "/early-access", label: "Get early access" },
		secondary = { href: "/verify", label: "Verify a sample receipt" },
		note = "Design partners: founder onboarding, free during the pilot.",
	}: { title?: string; primary?: Link; secondary?: Link | null; note?: string } = $props();
</script>

<section class="border-t border-border py-[clamp(88px,12vw,160px)] text-center">
	<div class="container-page grid justify-items-center gap-6">
		<div class="seal-surface mb-2"><Mark size={64} /></div>
		<h2 class="display-2 max-w-[18ch]">{title}</h2>
		<ThreeChecks />
		<div class="flex flex-wrap items-center justify-center gap-5">
			{#if primary.external}
				<Button href={primary.href} rel="noopener" target="_blank">{primary.label}</Button>
			{:else}
				<Button href={primary.href}>{primary.label}</Button>
			{/if}
			{#if secondary}<a class="link-arrow text-foreground" href={secondary.href}>{secondary.label}</a>{/if}
		</div>
		{#if note}<p class="-mt-1.5 text-sm text-muted-foreground">{note}</p>{/if}
	</div>
</section>
