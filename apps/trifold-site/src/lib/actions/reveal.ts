import type { Action } from "svelte/action";

let observer: IntersectionObserver | undefined;

const shared = (): IntersectionObserver => {
	observer ??= new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				entry.target.classList.add("is-in");
				observer?.unobserve(entry.target);
			}
		},
		{ rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
	);
	return observer;
};

/**
 * Fades an element up 16px when it scrolls into view (brand guide §7: opacity and translate only). `index` staggers
 * siblings by 60ms. The hidden state lives in CSS under `.js`, so the page reads without script.
 */
export const reveal: Action<HTMLElement, number | undefined> = (
	node,
	index = 0,
) => {
	node.dataset.reveal = "";
	node.style.setProperty("--i", String(index));
	if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
		node.classList.add("is-in");
		return;
	}
	shared().observe(node);
	return {
		destroy() {
			observer?.unobserve(node);
		},
	};
};
