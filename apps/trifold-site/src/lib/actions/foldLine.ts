import type { Action } from "svelte/action";

/**
 * The fold line (brand guide §6): a thin saffron hairline down the left margin of the chapters that draws as you scroll
 * and creases with a small chevron at each chapter (`[data-chapter]` children). Under 2px and unglowing, so it is exempt
 * from "one glow color per viewport". Reduced motion shows it fully drawn.
 */
export const foldLine: Action<HTMLElement> = (node) => {
	const track = document.createElement("div");
	track.className = "fold-track";
	track.setAttribute("aria-hidden", "true");
	const line = document.createElement("div");
	line.className = "fold-fill";
	track.append(line);
	node.prepend(track);

	const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
	let creases: { el: HTMLElement; at: number }[] = [];

	const layout = () => {
		for (const crease of creases) crease.el.remove();
		const height = node.offsetHeight;
		creases = [...node.querySelectorAll<HTMLElement>("[data-chapter]")].map(
			(chapter) => {
				const el = document.createElement("span");
				el.className = "fold-crease";
				const top = chapter.offsetTop + 6;
				el.style.top = `${top}px`;
				track.append(el);
				return { el, at: top / height };
			},
		);
	};

	let frame = 0;
	const update = () => {
		frame = 0;
		const box = node.getBoundingClientRect();
		const progress = reduced
			? 1
			: Math.min(
					1,
					Math.max(0, (window.innerHeight * 0.55 - box.top) / box.height),
				);
		line.style.transform = `scaleY(${progress.toFixed(4)})`;
		for (const crease of creases)
			crease.el.classList.toggle("lit", progress >= crease.at);
	};
	const schedule = () => {
		if (!frame) frame = requestAnimationFrame(update);
	};

	layout();
	update();
	const resize = new ResizeObserver(() => {
		layout();
		update();
	});
	resize.observe(node);
	window.addEventListener("scroll", schedule, { passive: true });

	return {
		destroy() {
			resize.disconnect();
			window.removeEventListener("scroll", schedule);
			cancelAnimationFrame(frame);
			track.remove();
		},
	};
};
