import "../theme.css";
import { type JSX, render } from "preact";
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import type { Reader } from "../data/reader.ts";
import type { Clock, School } from "../data/types.ts";
import type { Writer } from "../data/writer.ts";
import { formatRoute, parseRoute, type Route, themeOf } from "./route.ts";
import { Shell } from "./shell.tsx";

const navigate = (route: Route): void => {
	window.location.hash = formatRoute(route);
};

/** Follows `location.hash`; once the schools are loaded, rewrites a hash naming an unknown school or tab to the
 * route it shows, then records the rendered hash in `root.dataset.route` (protocol §3). */
function App({
	root,
	reader,
	writer,
	clock,
}: {
	root: HTMLElement;
	reader: Reader;
	writer: Writer;
	clock: Clock;
}): JSX.Element | null {
	const [hash, setHash] = useState(window.location.hash);
	const [schools, setSchools] = useState<School[] | null>(null);
	useLayoutEffect(() => {
		const onHashChange = (): void => setHash(window.location.hash);
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);
	useEffect(() => {
		reader.schools().then(setSchools);
	}, [reader]);

	/** Before the schools load the route's school is a placeholder; only its query (the theme) is used then. */
	const route = parseRoute(hash, schools?.map((school) => school.id) ?? []);
	const canonical = schools ? formatRoute(route) : null;
	const theme = themeOf(route.query);
	/** The Dashboard, Bookings, Plans and Members record their own render, once their data is on screen. */
	const reportsItself =
		route.tab === "dashboard" ||
		route.tab === "bookings" ||
		route.tab === "plans" ||
		route.tab === "members";
	useLayoutEffect(() => {
		root.classList.toggle("light", theme === "light");
		root.classList.toggle("dark", theme === "dark");
	}, [root, theme]);
	useLayoutEffect(() => {
		if (canonical === null) return;
		if (canonical === hash) {
			if (!reportsItself) root.dataset.route = hash;
			return;
		}
		window.history.replaceState(null, "", canonical);
		setHash(canonical);
	}, [root, hash, canonical, reportsItself]);

	if (!schools) return null;
	return (
		<Shell
			route={route}
			schools={schools}
			clock={clock}
			reader={reader}
			writer={writer}
			navigate={navigate}
			onRendered={() => {
				root.dataset.route = hash;
			}}
		/>
	);
}

/** Mounts the ledger UI on `root` (protocol §3). `theme=light|dark` puts that class on `root`, as the mockup puts it on
 * `.app`. */
export function mountApp(
	root: HTMLElement,
	options: { reader: Reader; writer: Writer; clock: Clock },
): { unmount(): void } {
	root.classList.add("app");
	render(
		<App
			root={root}
			reader={options.reader}
			writer={options.writer}
			clock={options.clock}
		/>,
		root,
	);
	return {
		unmount() {
			render(null, root);
			root.classList.remove("app", "light", "dark");
			root.removeAttribute("data-route");
		},
	};
}
