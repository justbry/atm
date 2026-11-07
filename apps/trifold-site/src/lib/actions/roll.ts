import type { Action } from "svelte/action";

const DURATION_MS = 1400;

/**
 * Counts a number up once when it comes into view, in tabular mono (brand guide §7, "Number roll"). The element's text
 * is the final value from the start, so it reads without script and under reduced motion.
 */
export const roll: Action<HTMLElement, { to: number; decimals?: number }> = (
	node,
	{ to, decimals = 0 },
) => {
	const format = (value: number) =>
		value.toLocaleString("en-US", {
			minimumFractionDigits: decimals,
			maximumFractionDigits: decimals,
		});
	node.textContent = format(to);
	if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
	let frame = 0;
	const run = () => {
		const start = performance.now();
		const tick = (now: number) => {
			const t = Math.min(1, (now - start) / DURATION_MS);
			const eased = 1 - (1 - t) ** 4;
			node.textContent = format(to * eased);
			if (t < 1) frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
	};
	const observer = new IntersectionObserver(
		(entries) => {
			if (!entries.some((entry) => entry.isIntersecting)) return;
			observer.disconnect();
			run();
		},
		{ threshold: 0.6 },
	);
	observer.observe(node);
	return {
		destroy() {
			observer.disconnect();
			cancelAnimationFrame(frame);
		},
	};
};
