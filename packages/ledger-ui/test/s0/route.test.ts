import { expect, test } from "bun:test";
import {
	formatRoute,
	parseRoute,
	themeOf,
	withQuery,
} from "../../src/app/route.ts";

const schoolIds = ["vol", "b4u", "map", "nw"];

test("a known route formats back to the same hash, query untouched", () => {
	const hash = "#/b4u/ledger?month=2026-10&theme=dark&viewer=finance";
	const route = parseRoute(hash, schoolIds);
	expect(route.schoolId).toBe("b4u");
	expect(route.tab).toBe("ledger");
	expect(formatRoute(route)).toBe(hash);
});

test("an unknown school opens the first school, an unknown tab opens Plans", () => {
	expect(formatRoute(parseRoute("", schoolIds))).toBe("#/vol/plans");
	expect(formatRoute(parseRoute("#/nowhere/members", schoolIds))).toBe(
		"#/vol/members",
	);
	expect(formatRoute(parseRoute("#/map/nothing?theme=light", schoolIds))).toBe(
		"#/map/plans?theme=light",
	);
});

test("All schools has only its own tab", () => {
	expect(formatRoute(parseRoute("#/all/members", schoolIds))).toBe("#/all/all");
	expect(formatRoute(parseRoute("", []))).toBe("#/all/all");
});

test("withQuery sets and removes one parameter without touching the route", () => {
	const route = parseRoute("#/vol/plans?theme=light", schoolIds);
	expect(formatRoute(withQuery(route, "month", "2026-10"))).toBe(
		"#/vol/plans?theme=light&month=2026-10",
	);
	expect(formatRoute(withQuery(route, "theme", null))).toBe("#/vol/plans");
	expect(formatRoute(route)).toBe("#/vol/plans?theme=light");
});

test("themeOf reads light and dark; anything else is system", () => {
	expect(themeOf(new URLSearchParams("theme=dark"))).toBe("dark");
	expect(themeOf(new URLSearchParams("theme=light"))).toBe("light");
	expect(themeOf(new URLSearchParams("theme=sepia"))).toBe("system");
	expect(themeOf(new URLSearchParams(""))).toBe("system");
});
