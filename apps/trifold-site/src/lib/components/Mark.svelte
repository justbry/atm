<script lang="ts">
	/** The Trifold mark: three panels folding into a triangle (a receipt folded in thirds; the three records). */
	let { size = 28, title = "" }: { size?: number; title?: string } = $props();
</script>

<svg
	class="flex-none"
	width={size}
	height={size}
	viewBox="0 0 100 100"
	role={title ? "img" : undefined}
	aria-hidden={title ? undefined : "true"}
	aria-label={title || undefined}
>
	<g stroke="var(--background)" stroke-width="3" stroke-linejoin="round">
		<path d="M50 58.7 L50 10 L10 83 Z" fill="var(--mark-a, var(--seal))" />
		<path d="M50 58.7 L10 83 L90 83 Z" fill="var(--mark-b, color-mix(in srgb, var(--seal) 72%, var(--background)))" />
		<path d="M50 58.7 L90 83 L50 10 Z" fill="var(--mark-c, color-mix(in srgb, var(--seal) 50%, var(--background)))" />
	</g>
</svg>
