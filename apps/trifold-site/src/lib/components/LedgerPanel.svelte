<script lang="ts">
	/**
	 * The pinned ledger panel of chapters 01–03: the sample school's October as events (01), as balanced books (02) and as
	 * signed receipts under a seal (03). Real rows from the sample ledger (scripts/make-samples.ts).
	 */
	import { roll } from "#lib/actions/roll";
	import panel from "#lib/samples/panel.json";
	import { monthName, SAMPLE_SCHOOL, shortId } from "#lib/samples/sample";

	let { step = 1 }: { step?: 1 | 2 | 3 } = $props();

	const money = (cents: number) =>
		(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	const month = monthName(panel.month);
	const caption = $derived(
		[
			"",
			`Sample ledger: ${panel.payments} Stripe payment events for ${month}.`,
			`Sample ledger: every event posted as a debit and a credit; debits and credits both total $${money(panel.total_cents)}.`,
			`Sample ledger: ${panel.payments} signed receipts, ${month} sealed, nothing changed.`,
		][step],
	);
	const grid = "grid grid-cols-[42px_minmax(0,1fr)_70px] items-center gap-2 sm:grid-cols-[52px_minmax(0,1fr)_84px] sm:gap-3";
	// Each layer shows in its own step; rows stagger by 50ms.
	const layer =
		"absolute inset-0 flex translate-y-1.5 items-center gap-2 overflow-hidden whitespace-nowrap text-ellipsis opacity-0 transition-[opacity,transform] duration-600 ease-brand delay-[calc(var(--row)*50ms)]";
	const foot =
		"label-mono absolute inset-0 flex flex-wrap items-center gap-4 px-[18px] text-[11px] text-foreground opacity-0 transition-opacity duration-600";
</script>

<figure
	class="group relative m-0 overflow-hidden rounded-lg border border-border bg-card px-[18px] pt-[18px] text-[13px] shadow-card"
	data-step={step}
	aria-label={caption}
>
	<header class="flex items-center justify-between pb-3.5">
		<span class="label-mono text-[11px]">Ledger · {SAMPLE_SCHOOL.name}</span>
		<span
			class="rounded-full border border-line-strong px-2 py-1 font-mono text-[11px] leading-none font-semibold tracking-[0.1em] text-muted-foreground uppercase"
			>Sample</span
		>
	</header>

	<div class="label-mono {grid} border-y border-border py-2 text-[10.5px]" aria-hidden="true">
		<span>Date</span>
		<span>{step === 1 ? "Event" : step === 2 ? "Debit · Credit" : "Receipt"}</span>
		<span class="text-right">Amount</span>
	</div>

	<ol aria-hidden="true">
		{#each panel.rows as row, index (row.event_id)}
			<li class="{grid} h-[38px] border-b border-border" style="--row: {index}">
				<span class="num text-muted-foreground">{row.date.slice(5)}</span>
				<span class="relative block h-full">
					<span class="num {layer} text-muted-foreground group-data-[step=1]:translate-y-0 group-data-[step=1]:opacity-100"
						>payment.succeeded · {shortId(row.stripe_id, 7, 4)}</span
					>
					<span class="num {layer} group-data-[step=2]:translate-y-0 group-data-[step=2]:opacity-100">
						<span class="truncate text-[11.5px] text-muted-foreground"
							><b class="font-semibold">Dr</b> <span class="hidden sm:inline">stripe</span>
							{money(row.amount_cents - row.fee_cents)} + {money(row.fee_cents)}<span class="hidden sm:inline"> fee</span
							></span
						>
						<span class="h-px flex-[0_0_18px] bg-fg-dim"></span>
						<span class="truncate text-[11.5px]"
							><b class="font-semibold text-muted-foreground">Cr</b> <span class="hidden sm:inline">tuition</span>
							{money(row.amount_cents)}</span
						>
					</span>
					<span class="num {layer} group-data-[step=3]:translate-y-0 group-data-[step=3]:opacity-100">
						<span class="text-proof-text group-data-[step=3]:[text-shadow:var(--glow-proof)]">✓</span> signed · {shortId(
							row.event_id,
							6,
							4,
						)}
					</span>
				</span>
				<span class="num text-right font-medium">${money(row.amount_cents)}</span>
			</li>
		{/each}
		<li class="{grid} num h-[38px] text-xs text-muted-foreground">
			<span></span><span>+ {panel.payments - panel.rows.length} more</span><span></span>
		</li>
	</ol>

	<footer class="relative -mx-[18px] h-[52px] border-t border-border bg-sunk">
		<div class="{foot} group-data-[step=1]:opacity-100">
			<span><span use:roll={{ to: panel.payments }}>{panel.payments}</span> events · {month}</span>
		</div>
		<div class="{foot} group-data-[step=2]:opacity-100">
			<span>Debits {money(panel.total_cents)}</span>
			<span>Credits {money(panel.total_cents)}</span>
			<span class="text-proof-text">Balanced ✓</span>
		</div>
		<div class="{foot} group-data-[step=3]:opacity-100">
			<span>{panel.payments} receipts · 1 seal · 0 changed</span>
		</div>
	</footer>

	<div
		class="pointer-events-none absolute right-[18px] bottom-2.5 scale-125 -rotate-8 opacity-0 transition-[opacity,transform] delay-250 duration-700 ease-brand group-data-[step=3]:scale-100 group-data-[step=3]:opacity-100"
		aria-hidden="true"
	>
		<span class="seal-surface block">
			<span
				class="seal-foil grid size-[88px] content-center place-items-center gap-0.5 rounded-full bg-seal text-center text-seal-ink shadow-[0_0_0_4px_var(--card),0_0_0_5px_color-mix(in_srgb,var(--seal)_60%,transparent)] sm:size-[104px]"
			>
				<span class="font-mono text-[10px] tracking-[0.12em] uppercase">{month}</span>
				<span class="font-display text-2xl leading-none font-medium [font-variation-settings:'opsz'_48,'SOFT'_100]"
					>Sealed</span
				>
			</span>
		</span>
	</div>
	<figcaption class="sr-only">{caption}</figcaption>
</figure>
