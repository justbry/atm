<script lang="ts">
	import { formatAmount, monthName, SCHOOL_NAMES, shortId } from "#lib/samples/sample";
	import type { VerifierSession } from "#lib/verify/session.svelte";

	let { session, class: className = "mt-4" }: { session: VerifierSession; class?: string } = $props();
	const schoolName = (id: string) => SCHOOL_NAMES[id] ?? id;
	const box = "grid gap-1 rounded-md border px-[18px] py-4 text-[15px] animate-[rise_0.5s_cubic-bezier(0.16,1,0.3,1)_both]";
	const pass = `${box} border-[color-mix(in_srgb,var(--proof)_45%,transparent)] bg-[color-mix(in_srgb,var(--proof)_11%,transparent)]`;
	const warn = `${box} border-[color-mix(in_srgb,var(--ember)_45%,transparent)] bg-[color-mix(in_srgb,var(--ember)_10%,transparent)]`;
	const fail = `${box} border-[color-mix(in_srgb,var(--alert)_50%,transparent)] bg-[color-mix(in_srgb,var(--alert)_12%,transparent)]`;
	const title = "mb-1 font-display text-[22px] [font-variation-settings:'opsz'_48,'SOFT'_60]";
	const code = "rounded bg-foreground/[0.06] px-[5px] py-px font-mono text-[0.85em] [overflow-wrap:anywhere]";
</script>

<div class={className}>
	<p
		data-agent="skip"
		class="label-mono flex flex-wrap gap-2 text-[11px] text-proof-text transition-opacity {session.checking
			? 'mb-2.5 opacity-100'
			: 'h-0 overflow-hidden opacity-0'}"
		aria-hidden={!session.checking}
	>
		<span>Checking signature</span><span class="text-fg-dim">·</span><span>Checking books</span><span
			class="text-fg-dim">·</span
		><span>Checking seal</span>
	</p>
	<div role="status" aria-live="polite" aria-busy={session.checking}>
		{#if session.outcome}
			{@const outcome = session.outcome}
			{#if outcome.kind === "signed"}
				{@const r = outcome.signed.receipt}
				{@const month = r.date.slice(0, 7)}
				{#if outcome.books === "ok" || outcome.books === null}
					<div class={pass}>
						<p class={title}><span class="text-proof-text" aria-hidden="true">✓</span> Verifies.</p>
						<p>Signed by {schoolName(r.school)}, key <code class={code}>{outcome.signed.key_id}</code>.</p>
						<p class="num">
							{formatAmount(r.amount, r.currency)} · {r.date} · event <code class={code}>{shortId(r.event_id)}</code>
						</p>
						{#if outcome.books === null}
							<p class="mt-1 text-sm text-muted-foreground">
								This verifier doesn't hold this school's books, so it checked the signature only. Ask the school for its
								sealed month to check the rest.
							</p>
						{:else if outcome.seal?.verdict === "ok" && outcome.seal.covers}
							<p>Found in the school's books, unchanged. Sealed in {monthName(month)}.</p>
						{:else if outcome.seal?.verdict === "ok"}
							<p>Found in the school's books, unchanged. Not yet in a sealed month.</p>
						{:else if outcome.seal}
							<p class="text-ember-text">⚠ Found in the school's books, but the {monthName(month)} seal doesn't match them.</p>
						{:else}
							<p>Found in the school's books, unchanged. {monthName(month)} isn't sealed yet.</p>
						{/if}
					</div>
				{:else}
					<div class={warn}>
						<p class={title}><span class="text-ember-text" aria-hidden="true">⚠</span> Signature valid, but…</p>
						{#if outcome.books === "missing_event"}
							<p>The school's books have no event <code class={code}>{shortId(r.event_id)}</code>.</p>
						{:else if outcome.books === "event_changed"}
							<p>The event in the school's books differs from this receipt.</p>
						{:else}
							<p>This event type doesn't get a receipt.</p>
						{/if}
					</div>
				{/if}
			{:else if outcome.kind === "bad_signature"}
				<div class={fail}>
					<p class={title}><span class="text-alert-text" aria-hidden="true">✗</span> Does not verify.</p>
					<p>
						The signature doesn't match this receipt. It was changed after it was signed, or it was never signed with
						this key.
					</p>
					<p>Nothing in it can be trusted as issued.</p>
				</div>
			{:else if outcome.kind === "unknown_key"}
				<div class={fail}>
					<p class={title}>
						<span class="text-alert-text" aria-hidden="true">✗</span> Unknown key <code class={code}>{outcome.keyId}</code>.
					</p>
					<p>The receipt names a key this school hasn't published.</p>
				</div>
			{:else}
				<div class={fail}>
					<p class={title}><span class="text-alert-text" aria-hidden="true">✗</span> This isn't a Trifold receipt.</p>
					<p>The file is missing fields or isn't valid JSON.</p>
				</div>
			{/if}
		{/if}
	</div>
</div>
