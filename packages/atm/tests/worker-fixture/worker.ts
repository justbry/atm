/**
 * The test Worker: what an admin UI does with `atm/worker`. Reads a school's events from the R2 binding, summarizes the
 * members, builds the views and writes them back. Bundled for workerd by `ledger-read-workerd.test.ts`.
 */
import { readEventsFromStore } from "../../src/ledger/read.js";
import { membersOf } from "../../src/ledger/summary.js";
import {
	buildViews,
	readViewsFromStore,
	type Views,
	writeViews,
} from "../../src/ledger/views.js";
import {
	R2BindingStore,
	type R2BucketBinding,
} from "../../src/store/r2-binding-store.js";
import type { AtmCatalogRow } from "../../src/types.js";

type Env = { BUCKET: R2BucketBinding };

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

/** Reads every object of the generation `views` describes through `readViewsFromStore`; what did not verify, by key. */
const verifyViews = async (
	store: R2BindingStore,
	school: string,
	views: Views,
) => {
	const reader = await readViewsFromStore(store, school);
	if (!reader.ok) return { opened: false as const, error: reader.error };
	const reads = [
		await reader.membersIndex(),
		...(await Promise.all(
			Object.keys(views.months).map((m) => reader.month(m)),
		)),
		...(await Promise.all(
			Object.keys(views.members).map((k) => reader.member(k)),
		)),
	];
	return {
		opened: true as const,
		asOf: reader.manifest.asOf,
		objectCount: reader.manifest.objectCount,
		checked: reads.length,
		failures: reads.filter((read) => !read.ok),
	};
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const school = url.searchParams.get("school") ?? "";
		const asOf = new Date(url.searchParams.get("asOf") ?? "");
		const store = new R2BindingStore(env.BUCKET);
		try {
			const catalogObject = await store.get("catalog.json");
			const catalog = JSON.parse(
				new TextDecoder().decode(catalogObject.body),
			) as AtmCatalogRow[];
			const events = await readEventsFromStore(store, school);
			const members = membersOf(events, asOf, { catalog });
			const built = buildViews(events, { school, asOf, catalog });
			if (!built.ok) return json({ eventCount: events.length, members, built });
			if (url.pathname === "/verify")
				return json(await verifyViews(store, school, built.views));
			const written = await writeViews(store, school, built.views);
			const rewritten = await writeViews(store, school, built.views);
			return json({
				eventCount: events.length,
				members,
				views: built.views,
				written,
				rewritten,
				verified: await verifyViews(store, school, built.views),
				timeZone: process.env.TZ ?? null,
			});
		} catch (error) {
			return json(
				{ error: error instanceof Error ? error.message : String(error) },
				500,
			);
		}
	},
};
