<script lang="ts">
	import Seo from "#lib/components/Seo.svelte";
	import VerifierFull from "#lib/components/VerifierFull.svelte";
</script>

<Seo
	title="Verify a receipt"
	description="Check a Trifold receipt in your browser: the signature, the books and the seal. No account, nothing uploaded."
/>

<section class="pt-[clamp(48px,7vw,96px)] pb-[clamp(48px,6vw,80px)]">
	<div class="container-page">
		<p class="label-mono">Verify · no account · nothing uploaded</p>
		<h1 class="display-2 mt-4">Check a receipt.</h1>
		<p class="lede mt-[18px]">
			Paste a receipt, drop the file, or try the sample. The check runs entirely in this page: the signature first, then
			the school's books and seal when they're available.
		</p>
		<div class="mt-10"><VerifierFull /></div>
	</div>
</section>

<section class="border-t border-border py-[clamp(48px,6vw,88px)]">
	<div class="container-page grid gap-10 md:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)]">
		<h2 class="display-3">What this page checks</h2>
		<ol class="grid list-decimal gap-3.5 pl-[1.2em] text-muted-foreground [&_strong]:text-foreground">
			<li><strong>The shape.</strong> The receipt has exactly the fields of a version-1 Trifold receipt, nothing missing, nothing added.</li>
			<li><strong>The key.</strong> The key id the receipt names is one the school has published.</li>
			<li>
				<strong>The signature.</strong> An Ed25519 signature over the receipt's exact bytes (JSON with sorted keys). Change one
				character and it fails.
			</li>
			<li>
				<strong>The books and the seal.</strong> When the verifier holds the school's books (here, the sample school's), it makes
				the receipt again from the event in the books and compares, then checks the month's seal.
			</li>
		</ol>
	</div>
	<div class="container-page mt-14">
		<p class="text-muted-foreground">
			Run a school on books like these? <a class="link-arrow text-foreground" href="/early-access">Get early access</a>
		</p>
	</div>
</section>
