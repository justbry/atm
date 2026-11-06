import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "../src/ledger/files.js";
import { readEventsFromStore } from "../src/ledger/read.js";
import {
	buildViews,
	memberViewKey,
	monthViewKey,
	writeViews,
} from "../src/ledger/views.js";
import { FolderStore } from "../src/store/folder-store.js";
import { sha256Hex, utf8 } from "../src/store/store.js";
import type { AtmCatalogRow, AtmEvent } from "../src/types.js";

const FIXTURES = join(import.meta.dir, "../fixtures");
const AS_OF = new Date("2027-03-01T00:00:00Z");
const catalog = JSON.parse(
	readFileSync(join(FIXTURES, "vibes-multi/catalog.json"), "utf8"),
) as AtmCatalogRow[];

const loadEvents = async (): Promise<AtmEvent[]> =>
	(await readEvents(join(FIXTURES, "vibes-multi"), "sch_multi")).events;

const build = async () => {
	const result = buildViews(await loadEvents(), {
		school: "sch_multi",
		asOf: AS_OF,
		catalog,
	});
	if (!result.ok) throw new Error(JSON.stringify(result.error));
	return result.views;
};

describe("buildViews", () => {
	test("months count events by type and by the events' own dates, ascending", async () => {
		const events = await loadEvents();
		const views = await build();
		const months = Object.keys(views.months);
		expect(months).toEqual([...months].sort());
		const total = Object.values(views.months).reduce(
			(sum, month) =>
				sum + Object.values(month.counts).reduce((a, b) => a + b, 0),
			0,
		);
		expect(total).toBe(events.length);
		const some = events[0] as AtmEvent;
		expect(
			views.months[some.date.slice(0, 7)]?.counts[some.event_type],
		).toBeGreaterThan(0);
	});

	test("money is the month's payments in cents: gross less refunds and fees is net", async () => {
		const events = await loadEvents();
		const views = await build();
		const gross = events
			.filter((e) => e.event_type === "payment.succeeded")
			.reduce(
				(sum, e) =>
					sum -
					e.postings
						.filter((p) => p.account.startsWith("income:billing:"))
						.reduce((s, p) => s + Math.round(Number(p.amount) * 100), 0),
				0,
			);
		const money = Object.values(views.months)
			.map((month) => month.money)
			.filter((m) => m !== undefined);
		expect(money.reduce((s, m) => s + m.grossCents, 0)).toBe(gross);
		for (const m of money)
			expect(m.netCents).toBe(m.grossCents - m.refundedCents - m.feeCents);
	});

	test("credits by commodity add up to the log's postings, and holders are counted once a month", async () => {
		const events = await loadEvents();
		const views = await build();
		const spent = events
			.flatMap((e) => e.postings)
			.filter((p) => p.account.startsWith("credits:spent:"))
			.reduce((s, p) => s + Number(p.amount), 0);
		expect(
			Object.values(views.months).reduce(
				(s, month) => s + (month.credits.VISIT?.spent ?? 0),
				0,
			),
		).toBe(spent);
		for (const [month, view] of Object.entries(views.months)) {
			const keys = new Set(
				events
					.filter(
						(e) =>
							e.date.startsWith(month) &&
							[
								"credit.held",
								"credit.released",
								"credit.spent",
								"credit.forfeited",
								"credit.refunded",
							].includes(e.event_type),
					)
					.map((e) => e.key),
			);
			expect(view.activeHolders).toBe(keys.size);
		}
	});

	test("the views are plain JSON: they survive a round trip unchanged", async () => {
		const views = await build();
		expect(JSON.parse(JSON.stringify(views))).toEqual(views);
	});

	test("a log that cannot be replayed gives the reason and no views", async () => {
		const result = buildViews(await loadEvents(), {
			school: "sch_multi",
			asOf: AS_OF,
		});
		expect(result).toMatchObject({ ok: false, error: { kind: "no-catalog" } });
	});
});

describe("object names", () => {
	test("a member's name is the SHA-256 of school and key, which Web Crypto computes the same, and holds no raw id", async () => {
		const key = "family:fam_th6z";
		const path = memberViewKey("sch_multi", key);
		expect(path).toMatch(
			/^schools\/sch_multi\/views\/members\/[0-9a-f]{64}\.json$/,
		);
		expect(path).not.toContain("fam_th6z");
		const digest = await crypto.subtle.digest(
			"SHA-256",
			utf8(`sch_multi\u0000${key}`),
		);
		const hex = [...new Uint8Array(digest)]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		expect(path).toBe(`schools/sch_multi/views/members/${hex}.json`);
		expect(hex).toBe(sha256Hex(utf8(`sch_multi\u0000${key}`)));
		expect(memberViewKey("sch_other", key)).not.toBe(path);
		expect(monthViewKey("sch_multi", "2026-11")).toBe(
			"schools/sch_multi/views/months/2026-11.json",
		);
	});
});

describe("writeViews", () => {
	const withStore = async (
		run: (store: FolderStore, root: string) => Promise<void>,
	) => {
		const root = await mkdtemp(join(tmpdir(), "atm-views-"));
		try {
			await run(new FolderStore({ root }), root);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	};

	test("writes a month object and a hashed member object, none twice, and reads them back", async () => {
		await withStore(async (store) => {
			const views = await build();
			const first = await writeViews(store, "sch_multi", views);
			expect(first.created.length).toBe(
				Object.keys(views.months).length + Object.keys(views.members).length,
			);
			expect(first.replaced).toEqual([]);
			expect(first.unchanged).toEqual([]);
			const second = await writeViews(store, "sch_multi", views);
			expect(second.created).toEqual([]);
			expect(second.replaced).toEqual([]);
			expect(second.unchanged).toEqual(first.created);

			const [key, summary] = Object.entries(views.members)[0] as [
				string,
				unknown,
			];
			const stored = JSON.parse(
				new TextDecoder().decode(
					(await store.get(memberViewKey("sch_multi", key))).body,
				),
			);
			expect(stored).toEqual({
				school: "sch_multi",
				asOf: views.asOf,
				...(summary as object),
			});
			const listed = await store.list({
				prefix: "schools/sch_multi/views/members/",
			});
			for (const object of listed.objects)
				expect(object.key).not.toContain("family:");
		});
	});

	test("changed views replace the objects, only those that changed", async () => {
		await withStore(async (store) => {
			const views = await build();
			await writeViews(store, "sch_multi", views);
			const [month] = Object.keys(views.months);
			const changed = {
				...views,
				months: {
					...views.months,
					[month as string]: {
						...(views.months[month as string] as (typeof views.months)[string]),
						activeHolders: 999,
					},
				},
			};
			const result = await writeViews(store, "sch_multi", changed);
			expect(result.replaced).toEqual([
				monthViewKey("sch_multi", month as string),
			]);
			expect(result.created).toEqual([]);
		});
	});

	test("what the store reader reads, buildViews builds from: the same views as from the disk reader", async () => {
		const root = join(FIXTURES, "vibes-multi");
		const fromStore = await readEventsFromStore(
			new FolderStore({ root }),
			"sch_multi",
		);
		const expected = await build();
		const result = buildViews(fromStore, {
			school: "sch_multi",
			asOf: AS_OF,
			catalog,
		});
		expect(result.ok && result.views).toEqual(expected);
	});
});
