import type { JSX } from "preact";

/** The mockup's stroke icons (its `IC` table), by full name. Later slices add the ones their views use. */
const shapes = {
	alert: <path d="M12 4l9 16H3L12 4zM12 10v4M12 17h.01" />,
	ban: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M5.6 5.6l12.8 12.8" />
		</>
	),
	box: <path d="M21 8l-9-5-9 5v8l9 5 9-5V8zM3 8l9 5 9-5M12 13v8" />,
	building: (
		<path d="M4 21V7l8-4 8 4v14M9 21v-6h6v6M8 10h.01M12 10h.01M16 10h.01" />
	),
	calendar: (
		<>
			<rect x="3" y="5" width="18" height="16" rx="2" />
			<path d="M3 10h18M8 3v4M16 3v4" />
		</>
	),
	chart: <path d="M4 20V11M10 20V5M16 20v-6M2 20h20" />,
	check: <path d="M4 12l5 5L20 6" />,
	chevronDown: <path d="M6 9l6 6 6-6" />,
	chevronLeft: <path d="M15 6l-6 6 6 6" />,
	chevronRight: <path d="M9 6l6 6-6 6" />,
	clock: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v5l3 2" />
		</>
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
	dot: <circle cx="12" cy="12" r="2" />,
	edit: <path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" />,
	download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
	eye: (
		<>
			<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
			<circle cx="12" cy="12" r="3" />
		</>
	),
	ext: (
		<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" />
	),
	gear: (
		<>
			<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
			<circle cx="12" cy="12" r="3" />
		</>
	),
	gift: (
		<>
			<rect x="3" y="8" width="18" height="4" />
			<path d="M12 8v13M5 12v9h14v-9M12 8c-2-4-6-3-5 0M12 8c2-4 6-3 5 0" />
		</>
	),
	help: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M9.5 9.5a2.5 2.5 0 114 2c-.9.6-1.5 1-1.5 2M12 17h.01" />
		</>
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
	layers: (
		<>
			<path d="M12 3l9 5-9 5-9-5 9-5z" />
			<path d="M3 12.5l9 5 9-5" />
			<path d="M3 17l9 5 9-5" />
		</>
	),
	list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
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
	monitor: (
		<>
			<rect x="3" y="4" width="18" height="12" rx="2" />
			<path d="M8 20h8M12 16v4" />
		</>
	),
	moon: <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />,
	more: (
		<>
			<circle cx="5" cy="12" r="1.6" class="f" />
			<circle cx="12" cy="12" r="1.6" class="f" />
			<circle cx="19" cy="12" r="1.6" class="f" />
		</>
	),
	plug: <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 01-12 0V8zM12 17v4" />,
	plus: <path d="M12 5v14M5 12h14" />,
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
	sun: (
		<>
			<circle cx="12" cy="12" r="4" />
			<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
		</>
	),
	tag: (
		<>
			<path d="M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0L3 13V3h10l7.6 7.6a2 2 0 010 2.8z" />
			<circle cx="7.5" cy="7.5" r="1.3" />
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
	users: (
		<>
			<circle cx="9" cy="8" r="3.2" />
			<path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
			<circle cx="17" cy="9" r="2.4" />
			<path d="M16 14.2c2.9.3 5 2.6 5 5.8" />
		</>
	),
	xCircle: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M9 9l6 6M15 9l-6 6" />
		</>
	),
} satisfies Record<string, JSX.Element>;

export type IconName = keyof typeof shapes;

/** Decorative: the button or text beside it carries the name. */
export function Icon({ name }: { name: IconName }): JSX.Element {
	return (
		<svg class="i" viewBox="0 0 24 24" aria-hidden="true">
			{shapes[name]}
		</svg>
	);
}
