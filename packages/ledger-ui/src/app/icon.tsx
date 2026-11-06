import type { JSX } from "preact";
import { type CoreIconName, coreShapes } from "./core-icon.tsx";

/** The mockup's stroke icons (its `IC` table) that only the panes and popovers loaded on demand draw; the ones the
 * first page load draws are in `core-icon.tsx`. Later slices add the ones their views use. */
const lateShapes = {
	ban: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M5.6 5.6l12.8 12.8" />
		</>
	),
	bank: <path d="M3 10l9-6 9 6M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18" />,
	box: <path d="M21 8l-9-5-9 5v8l9 5 9-5V8zM3 8l9 5 9-5M12 13v8" />,
	card: (
		<>
			<rect x="3" y="5" width="18" height="14" rx="2" />
			<path d="M3 10h18M7 15h3" />
		</>
	),
	check: <path d="M4 12l5 5L20 6" />,
	chevronLeft: <path d="M15 6l-6 6 6 6" />,
	chevronRight: <path d="M9 6l6 6-6 6" />,
	clock: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v5l3 2" />
		</>
	),
	cloud: (
		<path d="M7 18a4 4 0 01-.5-7.9A5.5 5.5 0 0117 9a4.5 4.5 0 01.5 9H7z" />
	),
	code: <path d="M8 8l-5 4 5 4M16 8l5 4-5 4M14 4l-4 16" />,
	coin: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M14.5 9.2c-.5-.8-1.4-1.2-2.5-1.2-1.5 0-2.5.8-2.5 1.8 0 2.6 5 1.4 5 4 0 1-1 1.9-2.5 1.9-1.2 0-2.2-.5-2.7-1.4M12 6v2M12 16v2" />
		</>
	),
	copy: (
		<>
			<rect x="9" y="9" width="11" height="11" rx="2" />
			<path d="M5 15V5a2 2 0 012-2h8" />
		</>
	),
	db: (
		<>
			<ellipse cx="12" cy="5" rx="8" ry="3" />
			<path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
		</>
	),
	dot: <circle cx="12" cy="12" r="2" />,
	download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
	edit: <path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" />,
	ext: (
		<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" />
	),
	gift: (
		<>
			<rect x="3" y="8" width="18" height="4" />
			<path d="M12 8v13M5 12v9h14v-9M12 8c-2-4-6-3-5 0M12 8c2-4 6-3 5 0" />
		</>
	),
	heart: (
		<path d="M12 20s-8-5-8-11a4.5 4.5 0 018-2.8A4.5 4.5 0 0120 9c0 6-8 11-8 11z" />
	),
	info: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 11v5M12 8h.01" />
		</>
	),
	key: (
		<>
			<circle cx="8" cy="15" r="4" />
			<path d="M11 12l9-9M16 7l3 3" />
		</>
	),
	lock: (
		<>
			<rect x="5" y="11" width="14" height="9" rx="2" />
			<path d="M8 11V8a4 4 0 018 0v3" />
		</>
	),
	mail: (
		<>
			<rect x="3" y="5" width="18" height="14" rx="2" />
			<path d="M3 7l9 6 9-6" />
		</>
	),
	more: (
		<>
			<circle cx="5" cy="12" r="1.6" class="f" />
			<circle cx="12" cy="12" r="1.6" class="f" />
			<circle cx="19" cy="12" r="1.6" class="f" />
		</>
	),
	plug: <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 01-12 0V8zM12 17v4" />,
	plus: <path d="M12 5v14M5 12h14" />,
	receipt: <path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2V3zM9 8h6M9 12h6" />,
	scale: (
		<path d="M12 3v18M5 21h14M5 7h14M5 7l-3 7a3 3 0 006 0L5 7zM19 7l-3 7a3 3 0 006 0l-3-7z" />
	),
	search: (
		<>
			<circle cx="11" cy="11" r="7" />
			<path d="M21 21l-4.3-4.3" />
		</>
	),
	sliders: (
		<>
			<path d="M4 6h8M16 6h4M4 12h2M10 12h10M4 18h10M18 18h2" />
			<circle cx="14" cy="6" r="2" />
			<circle cx="8" cy="12" r="2" />
			<circle cx="16" cy="18" r="2" />
		</>
	),
	ticket: (
		<path d="M3 9a2 2 0 002-2V6h14v1a2 2 0 002 2v6a2 2 0 00-2 2v1H5v-1a2 2 0 00-2-2V9z" />
	),
	trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
	undo: (
		<>
			<path d="M9 14L4 9l5-5" />
			<path d="M4 9h10a6 6 0 010 12h-3" />
		</>
	),
	unlock: (
		<>
			<rect x="5" y="11" width="14" height="9" rx="2" />
			<path d="M8 11V8a4 4 0 017.5-2" />
		</>
	),
	upload: <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />,
	user: (
		<>
			<circle cx="12" cy="8" r="3.5" />
			<path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7" />
		</>
	),
	xCircle: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M9 9l6 6M15 9l-6 6" />
		</>
	),
} satisfies Record<string, JSX.Element>;

const shapes: Record<CoreIconName | keyof typeof lateShapes, JSX.Element> = {
	...coreShapes,
	...lateShapes,
};

export type IconName = keyof typeof shapes;

/** Decorative: the button or text beside it carries the name. */
export function Icon({ name }: { name: IconName }): JSX.Element {
	return (
		<svg class="i" viewBox="0 0 24 24" aria-hidden="true">
			{shapes[name]}
		</svg>
	);
}
