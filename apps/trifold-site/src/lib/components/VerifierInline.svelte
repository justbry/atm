<script lang="ts">
	/** Chapter 03's verifier: the sample card, two buttons, the result. Nothing leaves the browser. */
	import { Button } from "#lib/components/ui/button";
	import { TAMPERED_CENTS, VerifierSession } from "#lib/verify/session.svelte";
	import ProofLimits from "./ProofLimits.svelte";
	import ReceiptCard from "./ReceiptCard.svelte";
	import VerifierResult from "./VerifierResult.svelte";

	const session = new VerifierSession();
</script>

<div class="max-w-[620px]">
	<ReceiptCard
		sweeping={session.checking}
		state={session.cardState}
		amountCents={session.which === "tampered" ? TAMPERED_CENTS : undefined}
	>
		{#snippet actions()}
			<Button size="sm" onclick={() => session.load("sample")} disabled={session.checking}>Verify this receipt</Button>
			<Button size="sm" variant="outline" onclick={() => session.load("tampered")} disabled={session.checking}
				>Try a tampered copy</Button
			>
		{/snippet}
	</ReceiptCard>
	<p class="mt-3 text-[13px] text-muted-foreground">
		Sample data. Names and amounts are invented. The signature is real and verifies against the sample's demo key, right
		here in your browser. Nothing is sent anywhere.
	</p>
	<VerifierResult {session} />
	<details class="mt-4">
		<summary class="mb-3 cursor-pointer text-[15px] font-semibold">What a pass proves, and what it doesn't</summary>
		<ProofLimits />
	</details>
	<p class="mt-4 text-[15px]"><a class="link-arrow text-foreground" href="/verify">Check your own receipt</a></p>
</div>
