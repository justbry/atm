<script lang="ts">
	/**
	 * A screenshot of the live demo's dashboard, dark and light, swapped by the theme class (CSS only, no script). The
	 * hidden one isn't fetched: lazy images that aren't rendered don't load. The light copy is skipped in the .md
	 * mirrors, so they show the dashboard once.
	 *
	 * The shots are cropped to start at the KPI tiles, so the school's name and the demo's "verified" badge aren't in
	 * them; whoever places this component carries both in a caption.
	 * TODO: retake with ?theme=dark|light once buzz-school #1352 is deployed (school name in header).
	 */
	const WIDTH = 1600;
	const HEIGHT = 817;
	const ALT =
		"The sample school's dashboard: tiles for collected, net income, Stripe fees and payouts, then charts of collected by plan, net income, payouts and the Stripe balance.";
	const SIZES = "(min-width: 1200px) 1120px, 100vw";

	const source = (theme: "dark" | "light", width: 800 | 1600) => `/demo/honeycomb-${theme}-${width}.webp ${width}w`;
</script>

<picture class="hidden dark:block">
	<source type="image/webp" srcset="{source('dark', 800)}, {source('dark', 1600)}" sizes={SIZES} />
	<img
		class="block h-auto w-full"
		src="/demo/honeycomb-dark-1600.jpg"
		alt={ALT}
		width={WIDTH}
		height={HEIGHT}
		loading="lazy"
		decoding="async"
	/>
</picture>
<picture class="block dark:hidden" data-agent="skip">
	<source type="image/webp" srcset="{source('light', 800)}, {source('light', 1600)}" sizes={SIZES} />
	<img
		class="block h-auto w-full"
		src="/demo/honeycomb-light-1600.jpg"
		alt={ALT}
		width={WIDTH}
		height={HEIGHT}
		loading="lazy"
		decoding="async"
	/>
</picture>
