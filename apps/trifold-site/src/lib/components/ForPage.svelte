<script lang="ts">
	import type { Component, Snippet } from "svelte";
	import { reveal } from "#lib/actions/reveal";
	import { Button } from "#lib/components/ui/button";
	import ClosingCta from "./ClosingCta.svelte";
	import Faq, { type FaqItem } from "./Faq.svelte";
	import Seo from "./Seo.svelte";

	type Cta = { href: string; label: string; external?: boolean; code?: boolean };

	let {
		eyebrow,
		title,
		seoTitle,
		description,
		subhead,
		points,
		cta,
		secondary,
		body,
		faq = [],
		aside,
		closingTitle,
		closingNote,
	}: {
		eyebrow: string;
		title: string;
		seoTitle: string;
		description: string;
		subhead: string;
		/** Plain text; a trailing staging note goes in `note` (shown as a Next/Later tag). */
		points: { text: string; note?: string }[];
		cta: Cta;
		secondary?: Cta;
		body?: Component;
		faq?: FaqItem[];
		aside?: Snippet;
		closingTitle?: string;
		closingNote?: string;
	} = $props();
</script>

<Seo title={seoTitle} {description} />

<section class="pt-[clamp(64px,9vw,120px)] pb-[clamp(48px,6vw,80px)]">
	<div class="container-page grid items-end gap-[clamp(32px,6vw,88px)] lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
		<div>
			<p class="label-mono">{eyebrow}</p>
			<h1 class="display-2 mt-5 max-w-[18ch]">{title}</h1>
			<p class="lede mt-5">{subhead}</p>
			<div class="mt-8 flex flex-wrap items-center gap-5">
				{#if cta.code}
					<Button variant="code" href={cta.href} rel="noopener" target="_blank">{cta.label}</Button>
				{:else}
					<Button href={cta.href}>{cta.label}</Button>
				{/if}
				{#if secondary}<a class="link-arrow text-foreground" href={secondary.href}>{secondary.label}</a>{/if}
			</div>
		</div>
		<ul class="border-t border-border">
			{#each points as point, index (point.text)}
				<li class="flex gap-3.5 border-b border-border py-[18px] text-muted-foreground" use:reveal={index}>
					<span class="font-bold text-proof-text" aria-hidden="true">✓</span>
					<span
						>{point.text}{#if point.note}
							<span class="ml-1 font-mono text-xs tracking-[0.1em] text-ember-text uppercase">{point.note}</span>{/if}</span
					>
				</li>
			{/each}
		</ul>
	</div>
</section>

{#if aside}
	<section class="border-t border-border py-[clamp(48px,6vw,88px)]">
		<div class="container-page">{@render aside()}</div>
	</section>
{/if}

{#if body}
	{@const Body = body}
	<section class="border-t border-border py-[clamp(48px,6vw,88px)]">
		<div class="container-page"><div class="prose"><Body /></div></div>
	</section>
{/if}

{#if faq.length}
	<section class="py-[clamp(48px,6vw,88px)]">
		<div class="container-page max-w-[760px]"><Faq items={faq} /></div>
	</section>
{/if}

<ClosingCta
	title={closingTitle}
	primary={cta.code ? { href: cta.href, label: cta.label, external: true } : cta}
	secondary={{ href: "/verify", label: "Verify a sample receipt" }}
	note={closingNote}
/>
