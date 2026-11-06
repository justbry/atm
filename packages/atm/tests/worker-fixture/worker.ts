/**
 * The test Worker: what an admin UI does with `atm/worker`. Reads a school's events from the R2 binding, summarizes the
 * members, runs the views (read, build, write: what a cron-triggered Worker does), reads every object back verified, and
 * answers an income statement and a ledger page from them. Bundled for workerd by `ledger-read-workerd.test.ts`.
 */
import { financeMonthsFor, incomeStatement } from "../../src/ledger/finance.js";
import { ledgerRows } from "../../src/ledger/ledger-rows.js";
import { readEventsFromStore } from "../../src/ledger/read.js";
import { runViews } from "../../src/ledger/run-views.js";
import { membersOf } from "../../src/ledger/summary.js";
import {
	buildViews,
	readViewsFromStore,
	type Views,
} from "../../src/ledger/views.js";
import {
	R2BindingStore,
	type R2BucketBinding,
} from "../../src/store/r2-binding-store.js";
import type { AtmCatalogRow } from "../../src/types.js";
import { LEDGER_FILTER, LEDGER_PAGE } from "./range.js";

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
		...(await Promise.all(
			Object.keys(views.finance.months).map((m) => reader.financeMonth(m)),
		)),
		...(await Promise.all(
			Object.keys(views.finance.members).map((k) => reader.financeMember(k)),
		)),
		...(await Promise.all(
			Object.keys(views.contributions).map((m) => reader.contributions(m)),
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

/** The income statement over `LEDGER_FILTER`'s range with the previous period, from the finance objects read back. */
const statementFrom = async (
	store: R2BindingStore,
	school: string,
	views: Views,
) => {
	const reader = await readViewsFromStore(store, school);
	if (!reader.ok) return null;
	const range = { ...LEDGER_FILTER, compare: true };
	const months = [];
	for (const month of financeMonthsFor(range.from, range.to, range.compare)) {
		if (!Object.hasOwn(views.finance.months, month)) continue;
		const read = await reader.financeMonth(month);
		if (read.ok) months.push(read.value);
	}
	return incomeStatement(months, range);
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
			const run = await runViews(store, school, asOf, { catalog });
			const rerun = await runViews(store, school, asOf, { catalog });
			if (!(run.ok && rerun.ok)) return json({ run, rerun });
			return json({
				eventCount: events.length,
				members,
				views: built.views,
				written: run.written,
				rewritten: rerun.written,
				verified: await verifyViews(store, school, built.views),
				statement: await statementFrom(store, school, built.views),
				ledger: ledgerRows(events, LEDGER_FILTER, null, LEDGER_PAGE),
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
