/** The hash route is the whole UI state (protocol §3):
 * `#/<schoolId>/<tab>?view=&month=&viewer=&preset=&grain=&member=&theme=`. The query passes through untouched;
 * each part of the UI reads the parameters it owns. */
export const schoolTabs = [
	"plans",
	"dashboard",
	"members",
	"bookings",
	"promos",
	"ledger",
	"reports",
] as const;
export type SchoolTab = (typeof schoolTabs)[number];

/** The switcher's "All schools" row: both its school id and its only tab. */
export const allSchools = "all";

export type Route = {
	schoolId: string;
	tab: SchoolTab | typeof allSchools;
	query: URLSearchParams;
};

export type Theme = "light" | "dark" | "system";

/** An unknown school opens the first one; an unknown tab opens Plans. */
export function parseRoute(hash: string, schoolIds: string[]): Route {
	const [path = "", search = ""] = hash.replace(/^#\/?/, "").split("?", 2);
	const [schoolSegment = "", tabSegment = ""] = path.split("/");
	const query = new URLSearchParams(search);
	const schoolId =
		schoolSegment === allSchools || schoolIds.includes(schoolSegment)
			? schoolSegment
			: (schoolIds[0] ?? allSchools);
	if (schoolId === allSchools) return { schoolId, tab: allSchools, query };
	const tab = schoolTabs.find((name) => name === tabSegment) ?? "plans";
	return { schoolId, tab, query };
}

export function formatRoute({ schoolId, tab, query }: Route): string {
	const search = query.toString();
	return `#/${schoolId}/${tab}${search ? `?${search}` : ""}`;
}

/** The route with one query parameter set, or removed when `value` is null. */
export function withQuery(
	route: Route,
	name: string,
	value: string | null,
): Route {
	const query = new URLSearchParams(route.query);
	if (value === null) query.delete(name);
	else query.set(name, value);
	return { ...route, query };
}

/** `theme=light|dark`; anything else follows the system. */
export function themeOf(query: URLSearchParams): Theme {
	const theme = query.get("theme");
	return theme === "light" || theme === "dark" ? theme : "system";
}
