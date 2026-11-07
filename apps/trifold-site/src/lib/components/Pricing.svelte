<script lang="ts">
	import { onMount } from "svelte";
	import { Button } from "#lib/components/ui/button";
	import * as ToggleGroup from "#lib/components/ui/toggle-group";
	import {
		ADDONS,
		ANNUAL_MONTHS_CHARGED,
		type Cell,
		COLUMNS,
		CREDITS,
		type Feature,
		MATRIX,
		NEVER,
		type Org,
		PLANS,
		PRICING_FAQ,
		PROMISE,
		SIDE_PLANS,
	} from "#lib/pricing/data";
	import Faq from "./Faq.svelte";

	let period = $state<"monthly" | "annual">("monthly");
	let org = $state<Org>("std");

	onMount(() => {
		if (new URLSearchParams(location.search).get("org") === "np") org = "np";
	});

	const dollars = (amount: number) => `$${Math.round(amount).toLocaleString("en-US")}`;

	function priceFor(price: Record<Org, number>) {
		const standard = price.std;
		const monthly = price[org];
		if (standard === 0) return { amount: "$0", per: "", struck: "", billing: "Free, planned" };
		const annual = period === "annual";
		const effective = annual ? (monthly * ANNUAL_MONTHS_CHARGED) / 12 : monthly;
		return {
			amount: dollars(effective),
			per: "/mo",
			struck: Math.round(effective) < standard ? dollars(standard) : "",
			billing: annual ? `Billed ${dollars(monthly * ANNUAL_MONTHS_CHARGED)} a year` : "Billed monthly",
		};
	}

	const feature = (item: Feature) => (typeof item === "string" ? { text: item } : item);

	function resolve(raw: Cell): { value: boolean | string; soon: boolean } {
		let cell: Cell = raw;
		if (typeof cell === "object" && cell !== null && "std" in cell) cell = cell[org];
		if (typeof cell === "object" && cell !== null && "soon" in cell) return { value: cell.value, soon: true };
		return { value: cell as boolean | string, soon: false };
	}

	function columnPrice(column: (typeof COLUMNS)[number]) {
		if (column.custom) return "Custom";
		if (column.self) return "$0 · self-hosted";
		const price = priceFor(column.price as Record<Org, number>);
		return price.per ? `${price.amount}${price.per}` : price.amount;
	}

	const pill =
		"rounded-full bg-[color-mix(in_srgb,var(--proof)_12%,transparent)] px-1.5 py-1 font-mono text-[10.5px] leading-none font-bold tracking-[0.04em] text-proof-text";
	const soon =
		"ml-1.5 inline-block rounded border border-[color-mix(in_srgb,var(--ember)_45%,transparent)] px-[5px] py-[3px] align-[2px] font-mono text-[9.5px] leading-none font-bold tracking-[0.06em] text-ember-text uppercase";
	const sectionTitle = "display-3";
	const sectionLede = "mt-2.5 mb-5 max-w-[760px] text-muted-foreground";
</script>

<div>
	<div
		class="flex items-center gap-3 rounded-md border border-[color-mix(in_srgb,var(--seal)_45%,transparent)] bg-[color-mix(in_srgb,var(--seal)_14%,transparent)] px-[18px] py-3.5 text-[15px]"
		role="note"
	>
		<span class="size-2 flex-none rounded-full bg-seal shadow-glow-seal" aria-hidden="true"></span>
		<p><strong>Planned prices, subject to change.</strong> Design partners: free during the pilot.</p>
	</div>

	<div class="mt-9 mb-2.5 flex flex-wrap justify-center gap-x-5 gap-y-3" data-agent="skip">
		<ToggleGroup.Root
			type="single"
			aria-label="Billing period"
			value={period}
			onValueChange={(value) => {
				if (value) period = value as typeof period;
			}}
		>
			<ToggleGroup.Item value="monthly">Monthly</ToggleGroup.Item>
			<ToggleGroup.Item value="annual">Annually <span class={pill}>2 months free</span></ToggleGroup.Item>
		</ToggleGroup.Root>
		<ToggleGroup.Root
			type="single"
			aria-label="Organization type"
			value={org}
			onValueChange={(value) => {
				if (value) org = value as Org;
			}}
		>
			<ToggleGroup.Item value="std">For-profit</ToggleGroup.Item>
			<ToggleGroup.Item value="np">Non-profit &amp; co-op <span class={pill}>~50% off</span></ToggleGroup.Item>
		</ToggleGroup.Root>
	</div>
	<p class="text-center text-[15px] font-semibold">{PROMISE}</p>
	<p class="mx-auto mt-1.5 min-h-[22px] max-w-[720px] text-center text-sm text-muted-foreground" aria-live="polite">
		{#if org === "np"}
			<strong class="text-foreground">Non-profit &amp; co-op pricing</strong> for verified 501(c) organizations and cooperatives.
			Under $50K a year? The plan is Witnessed free on the Free plan, once the witness ships.
		{/if}
	</p>

	<!-- pricing.md lists every toggle state at once (src/lib/pricing/markdown.ts), in place of the cards. -->
	<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-agent-md="plans">
		{#each PLANS as plan (plan.id)}
			{@const price = priceFor(plan.price)}
			<article
				class="relative flex flex-col gap-3 rounded-lg border bg-card px-5 pt-[26px] pb-[22px] shadow-card {plan.witness
					? 'border-[color-mix(in_srgb,var(--seal)_60%,transparent)]'
					: plan.featured
						? 'border-muted-foreground'
						: 'border-border'}"
				aria-labelledby="plan-{plan.id}"
			>
				{#if plan.badge}
					<span
						class="absolute -top-[11px] left-[18px] rounded-full px-[9px] py-1.5 font-mono text-[10.5px] leading-none font-bold tracking-[0.08em] uppercase {plan.witness
							? 'bg-seal text-seal-ink'
							: 'bg-foreground text-background'}">{plan.badge}</span
					>
				{/if}
				<h3 id="plan-{plan.id}" class="text-2xl font-[450]">{plan.name}</h3>
				<p class="-mt-1 min-h-[42px] text-sm text-muted-foreground">{plan.tagline}</p>
				<div class="flex min-h-12 flex-wrap items-baseline gap-1.5">
					{#if price.struck}<s class="text-[15px] text-muted-foreground">{price.struck}</s>{/if}
					<span class="font-display text-[42px] leading-none font-normal [font-variation-settings:'opsz'_144]"
						>{price.amount}</span
					>
					<span class="text-[15px] text-muted-foreground">{price.per}</span>
				</div>
				<div class="-mt-2 text-[13px] text-muted-foreground">{price.billing}</div>
				<div class="num rounded-md border border-border bg-sunk px-2.5 py-2 text-xs">{plan.families}</div>
				<Button href={plan.cta.href} variant={plan.featured || plan.witness ? "default" : "outline"} class="w-full"
					>{plan.cta.label}</Button
				>
				<ul class="mt-1 grid gap-2 text-sm">
					{#each plan.features as raw (feature(raw).text)}
						{@const item = feature(raw)}
						{#if !item.np || org === "np"}
							<li
								class="relative pl-[22px] text-foreground/85 before:absolute before:left-0 before:font-bold {item.plus
									? "before:text-ember-text before:content-['+'] dark:before:text-seal"
									: "before:text-proof-text before:content-['✓']"}"
							>
								{item.text}{#if item.soon}<span class={soon}>soon</span>{/if}
							</li>
						{/if}
					{/each}
				</ul>
			</article>
		{/each}
	</div>

	<div class="mt-4 grid gap-4 md:grid-cols-2" data-agent="skip">
		{#each SIDE_PLANS as plan (plan.id)}
			<div
				class="flex flex-col items-start justify-between gap-4 rounded-lg border border-dashed border-line-strong px-5 py-[18px] sm:flex-row sm:items-center"
			>
				<div>
					<h3 class="text-xl font-[450]">{plan.name}</h3>
					<p class="mt-1 text-sm text-muted-foreground">{plan.body}</p>
				</div>
				{#if plan.cta.external}
					<Button variant="code" size="sm" href={plan.cta.href} rel="noopener" target="_blank">{plan.cta.label}</Button>
				{:else}
					<Button variant="outline" size="sm" href={plan.cta.href}>{plan.cta.label}</Button>
				{/if}
			</div>
		{/each}
	</div>

	<section id="compare" class="mt-18" aria-labelledby="compare-title">
		<h2 id="compare-title" class={sectionTitle}>Compare every plan</h2>
		<p class={sectionLede}>
			Every plan keeps the same books and the same open receipt format. Higher plans add automation, AI, a team, and, once
			it ships, Trifold as witness. Events, credits and seats live here, not on the cards.
		</p>
		<div class="max-h-[760px] overflow-auto rounded-lg border border-border bg-card">
			<table class="w-full min-w-[900px] border-separate border-spacing-0 text-[13.5px]">
				<thead>
					<tr>
						<th
							scope="col"
							class="sticky top-0 left-0 z-30 min-w-[250px] border-b border-line-strong bg-card px-3 py-2.5 text-left align-bottom font-medium"
							>Feature</th
						>
						{#each COLUMNS as column (column.id)}
							<th scope="col" class="sticky top-0 z-20 border-b border-line-strong bg-card px-3 py-2.5 text-center align-bottom">
								<span
									class="block font-display text-[17px] font-[450] {column.id === 'witnessed'
										? 'text-ember-text dark:text-seal'
										: ''}">{column.name}</span
								> <span class="num mt-0.5 block text-xs text-muted-foreground">{columnPrice(column)}</span>
							</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each MATRIX as [group, rows] (group)}
						<tr>
							<th
								colspan={COLUMNS.length + 1}
								scope="colgroup"
								class="label-mono sticky left-0 border-b border-border bg-sunk px-3 py-3 text-left text-[11px] font-semibold"
								>{group}</th
							>
						</tr>
						{#each rows as [label, hint, cells] (label)}
							<tr>
								<th
									scope="row"
									class="sticky left-0 z-10 min-w-[250px] border-b border-border bg-card px-3 py-2.5 text-left font-medium"
									>{label}{#if hint}{" "}<span class="mt-0.5 block text-xs font-normal text-muted-foreground">{hint}</span>{/if}</th
								>
								{#each cells as raw, index (index)}
									{@const cell = resolve(raw)}
									<td
										class="border-b border-border px-3 py-2.5 text-center align-middle {COLUMNS[index]?.id === 'witnessed'
											? 'bg-[color-mix(in_srgb,var(--seal)_10%,transparent)]'
											: COLUMNS[index]?.id === 'pro'
												? 'bg-foreground/[0.03]'
												: ''}"
									>
										{#if cell.value === true}
											<span class="text-[15px] font-extrabold text-proof-text" aria-label="Included">✓</span>
										{:else if cell.value === false}
											<span class="font-bold text-fg-dim" aria-label="Not included">—</span>
										{:else}
											<span class="text-[12.5px]">{cell.value}</span>
										{/if}
										{#if cell.soon}<span class={soon}>soon</span>{/if}
									</td>
								{/each}
							</tr>
						{/each}
					{/each}
				</tbody>
			</table>
		</div>
		<div class="mt-3 flex flex-wrap gap-[18px] text-[13px] text-muted-foreground">
			<span><span class="font-extrabold text-proof-text">✓</span> Included</span>
			<span><span class="font-bold text-fg-dim">—</span> Not included</span>
			<span><span class={soon}>soon</span> On the roadmap, not yet shipped</span>
			<span>Pack = paid add-on below</span>
		</div>
	</section>

	<section class="mt-18" aria-labelledby="addons-title">
		<h2 id="addons-title" class={sectionTitle}>Add-ons</h2>
		<p class={sectionLede}>Bolt on what your organization needs. None of these are required to keep your books.</p>
		<div class="grid gap-4 md:grid-cols-3" data-agent-md="addons">
			{#each ADDONS as addon (addon.name)}
				{#if !addon.npOnly || org === "np"}
					<div class="rounded-lg border border-border bg-card px-5 py-[18px]">
						<h3 class="text-[19px] font-[450]">{addon.name}</h3>
						<div class="num my-2 text-[14.5px] font-semibold">{addon.price[org]}</div>
						<p class="text-sm text-muted-foreground">{addon.body}</p>
					</div>
				{/if}
			{/each}
		</div>
	</section>

	<section class="mt-18" aria-labelledby="credits-title">
		<h2 id="credits-title" class={sectionTitle}>What credits pay for</h2>
		<p class={sectionLede}>
			One credit is one cent. Every plan includes a monthly allowance; unused credits roll over one month. Running out
			never stops your books: payments still book and receipts are still signed. Only Rifo and new witness signatures
			pause until credits return.
		</p>
		<div class="overflow-x-auto">
			<table class="w-full border-collapse border border-border bg-card text-[14.5px]">
				<thead>
					<tr>
						{#each ["Action", "Credits", "Why"] as heading (heading)}
							<th scope="col" class="label-mono border-b border-border px-3.5 py-3 text-left text-[11px]">{heading}</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each CREDITS as [action, credits, why] (action)}
						<tr>
							<td class="border-b border-border px-3.5 py-3">{action}</td>
							<td class="num border-b border-border px-3.5 py-3 whitespace-nowrap">{credits}</td>
							<td class="border-b border-border px-3.5 py-3">{why}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>

	<section class="mt-18" aria-labelledby="never-title">
		<h2 id="never-title" class={sectionTitle}>Never behind a paywall</h2>
		<p class={sectionLede}>On every plan, including self-hosted, forever.</p>
		<div class="grid grid-cols-2 gap-3 lg:grid-cols-5">
			{#each NEVER as [title, body] (title)}
				<div class="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
					<b class="mb-1 block font-display text-[17px] font-[450] text-foreground">{title}</b>{body}
				</div>
			{/each}
		</div>
	</section>

	<section class="mt-18"><Faq items={PRICING_FAQ} id="pricing-faq" /></section>

	<p class="mt-12 border-t border-border pt-4 text-[13px] text-muted-foreground">
		Planned pricing, 2026-11-06. Prices in USD, before any sales tax. Features marked "soon" aren't available yet.
		Non-profit and co-op pricing will require verification. Donation acknowledgments, once they ship, will be written to
		meet IRS written-acknowledgment requirements; Trifold doesn't guarantee any donor's deduction.
	</p>
</div>
