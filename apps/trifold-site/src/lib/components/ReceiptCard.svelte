<script lang="ts">
	import type { Snippet } from "svelte";
	import receipt from "#lib/samples/receipt.json";
	import { formatAmount, monthName, SAMPLE_INVOICE, SAMPLE_SCHOOL, shortId } from "#lib/samples/sample";

	let {
		collapsed = false,
		sweeping = false,
		state = "idle",
		amountCents,
		actions,
	}: {
		/** Only the itemised layer (the schools section). */
		collapsed?: boolean;
		/** Run the proof sweep across the card (verification running). */
		sweeping?: boolean;
		state?: "idle" | "pass" | "fail";
		/** Show an edited amount (the tampered copy). */
		amountCents?: number;
		actions?: Snippet;
	} = $props();

	const r = receipt.receipt;
	const month = r.date.slice(0, 7);
	const edited = $derived(amountCents !== undefined && amountCents !== r.amount);
	const tone = $derived(
		state === "pass"
			? "border-[color-mix(in_srgb,var(--proof)_55%,transparent)] shadow-[var(--card-shadow),var(--glow-proof)]"
			: state === "fail"
				? "border-[color-mix(in_srgb,var(--alert)_60%,transparent)]"
				: "border-border",
	);
	const row = "grid grid-cols-[80px_1fr] gap-2 sm:grid-cols-[96px_1fr] sm:gap-3";
</script>

{#snippet line(term: string, value: string, mono = false)}
	<div class={row}>
		<dt class="text-[13px] text-muted-foreground {mono ? 'font-mono text-[12.5px]' : ''}">{term}</dt>
		<dd class="m-0 [overflow-wrap:anywhere] {mono ? 'num text-[12.5px]' : ''}">{value}</dd>
	</div>
{/snippet}

<article
	class="relative overflow-hidden rounded-lg border bg-card px-4 py-[18px] text-[14.5px] shadow-card transition-[border-color,box-shadow] duration-500 sm:px-6 sm:pt-6 sm:pb-5 {tone}"
	aria-label="Sample receipt from {SAMPLE_SCHOOL.name}"
>
	<header class="flex flex-col-reverse justify-between gap-4 border-b border-dashed border-line-strong pb-4 sm:flex-row">
		<div>
			<p class="font-mono text-[13px] font-semibold tracking-[0.08em]">{SAMPLE_SCHOOL.name.toUpperCase()}</p>
			<p class="text-[13px] leading-normal text-muted-foreground">{SAMPLE_SCHOOL.address}</p>
			<p class="text-[13px] leading-normal text-muted-foreground">EIN {SAMPLE_SCHOOL.ein}</p>
		</div>
		<p class="label-mono text-[10.5px] whitespace-nowrap">Receipt · Sample</p>
	</header>

	<dl class="mt-3.5 grid gap-[7px]">
		{@render line("Paid by", SAMPLE_INVOICE.paidBy)}
		{@render line("Student", SAMPLE_INVOICE.student)}
		{@render line("For", SAMPLE_INVOICE.description)}
		<div class={row}>
			<dt class="text-[13px] text-muted-foreground">Amount</dt>
			<dd class="num m-0 font-semibold">
				{#if edited && amountCents !== undefined}
					<span class="text-alert-text underline decoration-wavy underline-offset-4"
						>{formatAmount(amountCents, r.currency)} {r.currency.toUpperCase()}</span
					>
					<span class="ml-2 font-mono text-[10.5px] font-medium tracking-[0.1em] text-alert-text uppercase"
						>edited after signing</span
					>
				{:else}
					{formatAmount(r.amount, r.currency)} {r.currency.toUpperCase()}
				{/if}
			</dd>
		</div>
		{@render line("Paid", `${r.date} · ${SAMPLE_INVOICE.paidWith}`)}
		{@render line("Stripe", r.stripe_id)}
	</dl>
	<p class="mt-2.5 text-[12.5px] text-muted-foreground">Itemised lines from the school's Stripe invoice.</p>

	{#if !collapsed}
		<div class="mt-[18px] rounded-md border border-border bg-sunk p-4">
			<p class="label-mono text-[10.5px] text-proof-text">Signed record</p>
			<dl class="mt-2.5 grid gap-[7px]">
				{@render line("event", r.event_id, true)}
				{@render line("event hash", shortId(r.event_hash, 8, 8), true)}
				{@render line("signed by", `${SAMPLE_SCHOOL.name} · key ${receipt.key_id}`, true)}
				{@render line("sealed in", `${monthName(month)} · seal ${month}`, true)}
				{@render line("sig", `${shortId(receipt.sig, 8, 4)} (Ed25519)`, true)}
			</dl>
			<p class="mt-2.5 text-[12.5px] text-muted-foreground">
				The signature covers this record: no names, no email, just the payment and a hash of the event in the books.
			</p>
		</div>
	{/if}

	{#if actions}
		<div class="mt-[18px] flex flex-wrap gap-2.5">{@render actions()}</div>
	{/if}
	<span
		class="pointer-events-none absolute inset-y-0 left-0 w-2/5 -translate-x-[120%] bg-[linear-gradient(90deg,transparent,color-mix(in_srgb,var(--proof)_18%,transparent),transparent)] opacity-0 [mix-blend-mode:var(--proof-blend)] {sweeping
			? 'animate-[sweep_1.2s_cubic-bezier(0.16,1,0.3,1)_1]'
			: ''}"
		aria-hidden="true"
	></span>
</article>
