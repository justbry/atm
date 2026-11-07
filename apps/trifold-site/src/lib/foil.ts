/** The light-mode foil catches the light as you scroll: its gradient angle follows scroll, clamped to ±15° (30° range). */
const BASE_ANGLE = 115;
const RANGE = 15;
const PIXELS_PER_CYCLE = 1400;

export const trackFoil = (): (() => void) => {
	const root = document.documentElement;
	if (matchMedia("(prefers-reduced-motion: reduce)").matches) return () => {};
	let frame = 0;
	const update = () => {
		frame = 0;
		if (root.classList.contains("dark")) return;
		const phase = Math.sin((window.scrollY / PIXELS_PER_CYCLE) * Math.PI * 2);
		root.style.setProperty(
			"--foil-angle",
			`${(BASE_ANGLE + phase * RANGE).toFixed(1)}deg`,
		);
	};
	const onScroll = () => {
		if (!frame) frame = requestAnimationFrame(update);
	};
	window.addEventListener("scroll", onScroll, { passive: true });
	update();
	return () => {
		window.removeEventListener("scroll", onScroll);
		cancelAnimationFrame(frame);
	};
};
