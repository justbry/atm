<script lang="ts">
	/** /verify: paste, drop or choose a receipt file; a `?r=` link prefills and checks it. Nothing is uploaded. */
	import { onMount } from "svelte";
	import { Button } from "#lib/components/ui/button";
	import { Label } from "#lib/components/ui/label";
	import { Textarea } from "#lib/components/ui/textarea";
	import { decodeReceiptParam, encodeReceiptParam } from "#lib/verify/link";
	import { preloadVerifier, SAMPLE_TEXT, VerifierSession } from "#lib/verify/session.svelte";
	import ProofLimits from "./ProofLimits.svelte";
	import VerifierResult from "./VerifierResult.svelte";

	const MAX_FILE_BYTES = 256 * 1024;
	const session = new VerifierSession();
	const area = "mt-2.5";

	let dragging = $state(false);
	let fileError = $state("");

	const shareLink = $derived.by(() => {
		if (!session.text.trim()) return "";
		let compact = session.text.trim();
		try {
			compact = JSON.stringify(JSON.parse(session.text));
		} catch {}
		return `/verify?r=${encodeReceiptParam(compact)}`;
	});

	async function readFile(file: File) {
		fileError = "";
		if (file.size > MAX_FILE_BYTES) {
			fileError = "That file is too large to be a receipt.";
			return;
		}
		session.text = await file.text();
		session.which = "own";
		void session.verify();
	}

	function onDrop(event: DragEvent) {
		event.preventDefault();
		dragging = false;
		const file = event.dataTransfer?.files?.[0];
		if (file) {
			void readFile(file);
			return;
		}
		const dropped = event.dataTransfer?.getData("text/plain");
		if (dropped) {
			session.text = dropped;
			session.which = "own";
			void session.verify();
		}
	}

	function onFileInput(event: Event) {
		const file = (event.currentTarget as HTMLInputElement).files?.[0];
		if (file) void readFile(file);
	}

	onMount(() => {
		void preloadVerifier();
		const param = new URLSearchParams(location.search).get("r");
		if (!param) return;
		const decoded = decodeReceiptParam(param) ?? param;
		session.text = decoded;
		session.which = decoded === JSON.stringify(JSON.parse(SAMPLE_TEXT)) ? "sample" : "own";
		void session.verify(decoded);
	});
</script>

<div class="grid items-start gap-[clamp(24px,4vw,56px)] md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
	<div>
		<div class="mb-4 flex flex-wrap items-center gap-2.5">
			<span class="label-mono mr-1">Try it</span>
			<Button size="sm" variant="outline" onclick={() => session.load("sample")} disabled={session.checking}
				>Load the sample</Button
			>
			<Button size="sm" variant="outline" onclick={() => session.load("tampered")} disabled={session.checking}
				>Load a tampered copy</Button
			>
		</div>

		<div
			class="rounded-lg border border-dashed p-4 transition-colors {dragging
				? 'border-proof bg-[color-mix(in_srgb,var(--proof)_10%,transparent)]'
				: 'border-line-strong bg-card'}"
			role="group"
			aria-label="Receipt input"
			ondragover={(event) => {
				event.preventDefault();
				dragging = true;
			}}
			ondragleave={() => (dragging = false)}
			ondrop={onDrop}
		>
			<Label for="receipt-text"><span class="label-mono">Receipt JSON</span></Label>
			<Textarea
				id="receipt-text"
				class="{area} min-h-[260px]"
				bind:value={session.text}
				spellcheck="false"
				autocomplete="off"
				placeholder={'Paste a receipt here, or drop the file.\n\n{ "receipt": { … }, "key_id": "…", "sig": "…" }'}
				oninput={() => (session.which = "own")}
			/>
			<div class="mt-3 flex justify-between gap-2.5">
				<label
					class="relative inline-flex h-[38px] cursor-pointer items-center overflow-hidden rounded-full border border-line-strong px-4 text-sm font-semibold focus-within:outline-2 focus-within:outline-offset-3 focus-within:outline-ring focus-within:outline-solid hover:border-muted-foreground"
				>
					Choose a file
					<input
						type="file"
						accept="application/json,.json,.txt"
						class="absolute inset-0 cursor-pointer opacity-0"
						onchange={onFileInput}
					/>
				</label>
				<Button size="sm" onclick={() => session.verify()} disabled={session.checking || !session.text.trim()}
					>Verify</Button
				>
			</div>
			{#if fileError}<p class="mt-2 text-sm text-alert-text" role="alert">{fileError}</p>{/if}
		</div>

		<details class="mt-4 rounded-md border border-border px-4 py-3">
			<summary class="cursor-pointer text-[15px] font-semibold">Check against a different public key</summary>
			<p class="mt-2 text-sm text-muted-foreground">
				By default this checks against the sample school's published demo key. Paste a school's key list to check its
				receipts instead.
			</p>
			<Label for="keys-text" class="sr-only">Public keys JSON</Label>
			<Textarea
				id="keys-text"
				class="{area} min-h-[120px]"
				bind:value={session.keysText}
				spellcheck="false"
				placeholder={'{ "key_id": "-----BEGIN PUBLIC KEY-----\\n…\\n-----END PUBLIC KEY-----\\n" }'}
			/>
			{#if session.keysError}<p class="mt-2 text-sm text-alert-text" role="alert">{session.keysError}</p>{/if}
		</details>

		{#if shareLink && session.which === "sample"}
			<p class="mt-3.5 text-sm text-muted-foreground">
				A receipt can carry its own check: <a class="underline" href={shareLink}>open the sample as a verify link</a>.
			</p>
		{/if}
	</div>

	<div>
		<VerifierResult {session} class="mt-0" />
		{#if !session.outcome && !session.checking}
			<p class="rounded-md border border-dashed border-border p-[18px] text-[15px] text-muted-foreground">
				Results appear here. The check runs in this page; nothing is uploaded.
			</p>
		{/if}
		<p class="mt-3.5 mb-5 text-sm text-muted-foreground">Questions about a receipt? Ask your school.</p>
		<ProofLimits />
	</div>
</div>
