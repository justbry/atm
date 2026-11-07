<script lang="ts">
	import "../app.css";
	import { onMount, type Snippet } from "svelte";
	import Footer from "#lib/components/Footer.svelte";
	import Header from "#lib/components/Header.svelte";
	import { trackFoil } from "#lib/foil";

	let { children }: { children: Snippet } = $props();

	onMount(() => trackFoil());
</script>

<Header />
<main id="main" tabindex="-1" class="focus:outline-none">
	{@render children()}
</main>
<Footer />
