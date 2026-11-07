<script lang="ts">
	import { onMount } from "svelte";
	import { Button } from "#lib/components/ui/button";

	const STORAGE_KEY = "trifold-theme";
	let dark = $state(true);

	onMount(() => {
		dark = document.documentElement.classList.contains("dark");
		// Follow the system until the visitor picks a mode.
		const media = matchMedia("(prefers-color-scheme: dark)");
		const onChange = () => {
			let stored: string | null = null;
			try {
				stored = localStorage.getItem(STORAGE_KEY);
			} catch {}
			if (stored !== "dark" && stored !== "light") apply(media.matches);
		};
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	});

	function apply(next: boolean) {
		dark = next;
		document.documentElement.classList.toggle("dark", next);
	}

	function toggle() {
		apply(!dark);
		try {
			localStorage.setItem(STORAGE_KEY, dark ? "dark" : "light");
		} catch {}
	}
</script>

<Button
	variant="subtle"
	size="icon"
	onclick={toggle}
	aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
	title={dark ? "Light mode" : "Dark mode"}
>
	<svg viewBox="0 0 24 24" class="size-[18px]" aria-hidden="true">
		{#if dark}
			<circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.6" />
			<path
				d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"
				stroke="currentColor"
				stroke-width="1.6"
				stroke-linecap="round"
			/>
		{:else}
			<path
				d="M20 14.5A8.2 8.2 0 0 1 9.5 4a8.2 8.2 0 1 0 10.5 10.5Z"
				fill="none"
				stroke="currentColor"
				stroke-width="1.6"
				stroke-linejoin="round"
			/>
		{/if}
	</svg>
</Button>
