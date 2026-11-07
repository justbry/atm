<script lang="ts">
	import { page } from "$app/state";
	import Mark from "#lib/components/Mark.svelte";
	import Seo from "#lib/components/Seo.svelte";
	import { Button } from "#lib/components/ui/button";

	const missing = $derived(page.status === 404);
</script>

<Seo title={missing ? "Page not found" : "Something went wrong"} noindex markdown={false} />

<section class="py-[clamp(96px,14vw,180px)]">
	<div class="container-page grid max-w-[760px] justify-items-start gap-5">
		<div class="seal-surface"><Mark size={56} /></div>
		<p class="label-mono">{page.status} · {missing ? "Not in the books" : "Error"}</p>
		<h1 class="display-2">{missing ? "There's no entry for this page." : "Something went wrong."}</h1>
		<p class="lede">
			{missing
				? "The link may be old, or the address mistyped. Every other number on this site still checks out."
				: "Please try again in a moment."}
		</p>
		<div class="flex flex-wrap gap-3">
			<Button href="/">Go home</Button>
			<Button href="/verify" variant="outline">Verify a receipt</Button>
		</div>
	</div>
</section>
