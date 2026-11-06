import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "../src/ledger/files.js";
import { readEventsFromStore } from "../src/ledger/read.js";
import {
	buildViews,
	contributionsKey,
	manifestKey,
	memberIndexKey,
	memberViewKey,
	memberViewName,
	monthViewKey,
	readViewsFromStore,
	type Views,
	type ViewsReader,
	writeViews,
} from "../src/ledger/views.js";
import { FolderStore } from "../src/store/folder-store.js";
import { sha256Hex, utf8 } from "../src/store/store.js";
import type { AtmCatalogRow, AtmEvent, Store } from "../src/types.js";
import { handBuiltLog, catalog as handCatalog } from "./ledger-read-log.js";

const FIXTURES = join(import.meta.dir, "../fixtures");
/** After the last event of vibes-multi (2027-03-01T07:30:00Z): these tests are about the whole log. */
const AS_OF = new Date("2027-03-02T00:00:00Z");
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

	test("the month view holds no money: the books are the finance month view's", async () => {
		const views = await build();
		for (const month of Object.values(views.months))
			expect(Object.keys(month).sort()).toEqual([
				"activeHolders",
				"counts",
				"credits",
			]);
	});

	test("finance money is the month's payments in cents: gross less refunds and fees is net", async () => {
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
		const money = Object.values(views.finance.months).map(
			(month) => month.money,
		);
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
			// the months, the members, the member index, the finance months and members, the contributions and the manifest
			expect(first.created.length).toBe(
				Object.keys(views.months).length +
					Object.keys(views.members).length +
					Object.keys(views.finance.months).length +
					Object.keys(views.finance.members).length +
					Object.keys(views.contributions).length +
					2,
			);
			expect(first.stale).toBe(false);
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
			expect(stored).toEqual({ school: "sch_multi", ...(summary as object) });
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
			// the manifest lists the changed month's new hash, so it is rewritten with it (and last)
			expect(result.replaced).toEqual([
				monthViewKey("sch_multi", month as string),
				manifestKey("sch_multi"),
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

const textOf = async (store: Store, key: string) =>
	new TextDecoder().decode((await store.get(key)).body);

/** A store that passes every call through and lets a test watch or break the writes. */
const watched = (
	inner: Store,
	hooks: {
		beforePutIfMatch?: (key: string) => Promise<void>;
		beforeWrite?: (key: string, writes: number) => void;
	} = {},
) => {
	const writes: string[] = [];
	const store: Store = {
		get: (key, range) => inner.get(key, range),
		head: (key) => inner.head(key),
		list: (options) => inner.list(options),
		delete: (key, sha) => inner.delete(key, sha),
		presign: (key, options) => inner.presign(key, options),
		async putIfAbsent(key, body) {
			hooks.beforeWrite?.(key, writes.length);
			writes.push(key);
			return inner.putIfAbsent(key, body);
		},
		async putIfMatch(key, body, etag) {
			hooks.beforeWrite?.(key, writes.length);
			await hooks.beforePutIfMatch?.(key);
			writes.push(key);
			return inner.putIfMatch(key, body, etag);
		},
	};
	return { store, writes };
};

describe("writeViews: objects are content only, the manifest is the generation", () => {
	const { events, at } = handBuiltLog();
	const viewsAt = (asOf: number): Views => {
		const result = buildViews(events, {
			school: "sch_hand",
			asOf: new Date(asOf),
			catalog: handCatalog,
		});
		if (!result.ok) throw new Error(JSON.stringify(result.error));
		return result.views;
	};
	const withStore = async (run: (store: FolderStore) => Promise<void>) => {
		const root = await mkdtemp(join(tmpdir(), "atm-views-"));
		try {
			await run(new FolderStore({ root }));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	};
	/** The one month of the hand-built log. */
	const HAND_MONTH = Object.keys(
		viewsAt(at.refunded + 1000).months,
	)[0] as string;
	const first = at.secondSpent + 1000;
	const later = at.refunded + 1000;
	const manifestOf = async (store: Store) =>
		JSON.parse(await textOf(store, manifestKey("sch_hand")));
	const openReader = async (store: Store): Promise<ViewsReader> => {
		const reader = await readViewsFromStore(store, "sch_hand");
		if (!reader.ok) throw new Error(JSON.stringify(reader));
		return reader;
	};
	/** Reads every object the manifest lists; the first one that does not verify, or `{ ok: true }`. */
	const allObjectsOk = async (reader: ViewsReader) => {
		const reads = [
			await reader.membersIndex(),
			await reader.month(HAND_MONTH),
			await reader.member("family:fam_hand"),
		];
		return reads.find((read) => !read.ok) ?? { ok: true };
	};

	test("no month, member or index object holds asOf; the manifest records the run", async () => {
		await withStore(async (store) => {
			const views = viewsAt(later);
			const result = await writeViews(store, "sch_hand", views);
			const manifest = manifestKey("sch_hand");
			for (const key of result.created) {
				const text = await textOf(store, key);
				if (key === manifest) continue;
				expect(text).not.toContain("asOf");
			}
			expect(await manifestOf(store)).toEqual({
				asOf: views.asOf,
				generatedFrom: {
					lastEventId: [...events].sort((a, b) => (a.id < b.id ? -1 : 1)).at(-1)
						?.id,
					eventCount: events.length,
				},
				// one month, one member, the index, one finance month, one finance member, one contributions month
				objectCount: 6,
				objects: Object.fromEntries(
					await Promise.all(
						result.created
							.filter((key) => key !== manifest)
							.map(async (key) => [
								key,
								sha256Hex(utf8(await textOf(store, key))),
							]),
					),
				),
			});
			expect(views.generatedFrom.eventCount).toBe(events.length);
		});
	});

	test("the manifest is written last", async () => {
		await withStore(async (inner) => {
			const { store, writes } = watched(inner);
			await writeViews(store, "sch_hand", viewsAt(later));
			expect(writes.at(-1)).toBe(manifestKey("sch_hand"));
			expect(writes.length).toBe(7);
		});
	});

	test("the member index lists each member's object name with its key and lastEventAt", async () => {
		await withStore(async (store) => {
			const views = viewsAt(later);
			await writeViews(store, "sch_hand", views);
			expect(
				JSON.parse(await textOf(store, memberIndexKey("sch_hand"))),
			).toEqual({
				school: "sch_hand",
				members: Object.values(views.members).map((member) => ({
					name: memberViewName("sch_hand", member.key),
					key: member.key,
					lastEventAt: member.lastEventAt,
				})),
			});
			expect(Object.values(views.members).length).toBe(1);
		});
	});

	test("a second run with the same asOf writes nothing", async () => {
		await withStore(async (inner) => {
			await writeViews(inner, "sch_hand", viewsAt(later));
			const { store, writes } = watched(inner);
			const second = await writeViews(store, "sch_hand", viewsAt(later));
			expect(writes).toEqual([]);
			expect(second.created).toEqual([]);
			expect(second.replaced).toEqual([]);
			expect(second.unchanged.length).toBe(7);
		});
	});

	test("a later asOf over an unchanged log rewrites only the manifest", async () => {
		await withStore(async (inner) => {
			await writeViews(inner, "sch_hand", viewsAt(later));
			const next = viewsAt(later + 86_400_000);
			const { store, writes } = watched(inner);
			const second = await writeViews(store, "sch_hand", next);
			expect(second.replaced).toEqual([manifestKey("sch_hand")]);
			expect(second.created).toEqual([]);
			expect(writes).toEqual([manifestKey("sch_hand")]);
			expect((await manifestOf(inner)).asOf).toBe(next.asOf);
		});
	});

	test("a stale writer (an earlier asOf than the stored manifest's) writes nothing and does not win", async () => {
		await withStore(async (inner) => {
			await writeViews(inner, "sch_hand", viewsAt(later));
			const member = memberViewKey("sch_hand", `family:fam_hand`);
			const before = await textOf(inner, member);
			const manifest = await textOf(inner, manifestKey("sch_hand"));
			const { store, writes } = watched(inner);
			// asOf before the refund: the member and month objects would differ if it wrote
			const stale = await writeViews(store, "sch_hand", viewsAt(first));
			expect(stale.stale).toBe(true);
			expect(writes).toEqual([]);
			expect(await textOf(inner, member)).toBe(before);
			expect(await textOf(inner, manifestKey("sch_hand"))).toBe(manifest);
		});
	});

	test("a newer run that lands between the read and the put wins over this run's manifest", async () => {
		await withStore(async (inner) => {
			await writeViews(inner, "sch_hand", viewsAt(first));
			const newest = viewsAt(later + 86_400_000);
			let raced = false;
			const { store } = watched(inner, {
				beforePutIfMatch: async (key) => {
					if (key !== manifestKey("sch_hand") || raced) return;
					raced = true;
					await writeViews(inner, "sch_hand", newest);
				},
			});
			const result = await writeViews(store, "sch_hand", viewsAt(later));
			expect(raced).toBe(true);
			expect(result.stale).toBe(true);
			expect((await manifestOf(inner)).asOf).toBe(newest.asOf);
			// contents, not only counts: every object holds what the newest run alone writes
			await withStore(async (alone) => {
				await writeViews(alone, "sch_hand", newest);
				const listed = await alone.list({ prefix: "schools/sch_hand/views/" });
				expect(listed.objects.length).toBe(7);
				for (const { key } of listed.objects)
					expect(await textOf(inner, key)).toBe(await textOf(alone, key));
			});
			const reader = await openReader(inner);
			expect(await allObjectsOk(reader)).toEqual({ ok: true });
		});
	});

	test("a failure partway leaves the old manifest in place, and the reader flags the one object that changed", async () => {
		await withStore(async (inner) => {
			const old = viewsAt(first);
			await writeViews(inner, "sch_hand", old);
			const manifestBefore = await textOf(inner, manifestKey("sch_hand"));
			// the one object between the two runs that changes and sorts first: the month's contributions
			const landedKey = contributionsKey("sch_hand", HAND_MONTH);
			const landedBefore = await textOf(inner, landedKey);
			let failures = 0;
			const { store, writes } = watched(inner, {
				beforeWrite: (_key, written) => {
					// the second object write fails, after the first landed
					if (written === 1) {
						failures += 1;
						throw new Error("store went away");
					}
				},
			});
			await expect(
				writeViews(store, "sch_hand", viewsAt(later)),
			).rejects.toThrow(/store went away/);
			expect(failures).toBe(1);
			expect(writes).toEqual([landedKey]);
			expect(await textOf(inner, manifestKey("sch_hand"))).toBe(manifestBefore);
			expect((await manifestOf(inner)).asOf).toBe(old.asOf);
			// the object that landed is newer than the manifest: not rolled back, and a reader sees it
			expect(await textOf(inner, landedKey)).not.toBe(landedBefore);
			const reader = await openReader(inner);
			expect(await reader.contributions(HAND_MONTH)).toEqual({
				ok: false,
				error: "view-mismatch",
				key: landedKey,
			});
			// the objects the run never reached still match the old manifest
			expect((await reader.month(HAND_MONTH)).ok).toBe(true);
			expect((await reader.membersIndex()).ok).toBe(true);
			expect((await reader.member("family:fam_hand")).ok).toBe(true);
		});
	});

	test("an older run whose writes land after a newer run's manifest is detected, object by object", async () => {
		await withStore(async (inner) => {
			const older = viewsAt(first);
			const newer = viewsAt(later);
			let raced = false;
			// the older run passed the stale check on an empty store; the newer run then publishes completely
			const { store } = watched(inner, {
				beforeWrite: () => {},
			});
			const lagging: Store = {
				...store,
				async putIfAbsent(key, body) {
					if (!raced) {
						raced = true;
						await writeViews(inner, "sch_hand", newer);
					}
					return store.putIfAbsent(key, body);
				},
			};
			const result = await writeViews(lagging, "sch_hand", older);
			expect(raced).toBe(true);
			expect(result.stale).toBe(true);
			const manifest = await manifestOf(inner);
			expect(manifest.asOf).toBe(newer.asOf);
			// the older run's objects are now under the newer manifest
			const reader = await openReader(inner);
			const memberKey = memberViewKey("sch_hand", "family:fam_hand");
			const monthKey = monthViewKey("sch_hand", HAND_MONTH);
			expect(await reader.member("family:fam_hand")).toEqual({
				ok: false,
				error: "view-mismatch",
				key: memberKey,
			});
			expect(await reader.month(HAND_MONTH)).toEqual({
				ok: false,
				error: "view-mismatch",
				key: monthKey,
			});
			// a rerun of the newer asOf heals them: nothing is left mismatched
			await writeViews(inner, "sch_hand", newer);
			expect(await allObjectsOk(await openReader(inner))).toEqual({ ok: true });
		});
	});

	test("a complete run verifies clean, and the reader returns the objects' contents", async () => {
		await withStore(async (store) => {
			const views = viewsAt(later);
			await writeViews(store, "sch_hand", views);
			const reader = await openReader(store);
			expect(reader.manifest.asOf).toBe(views.asOf);
			expect(await allObjectsOk(reader)).toEqual({ ok: true });
			const member = Object.values(
				views.members,
			)[0] as Views["members"][string];
			expect(await reader.member(member.key)).toEqual({
				ok: true,
				value: { school: "sch_hand", ...member },
			});
			const [month] = Object.keys(views.months) as [string];
			expect(await reader.month(month)).toEqual({
				ok: true,
				value: {
					school: "sch_hand",
					month,
					...(views.months[month] as Views["months"][string]),
				},
			});
			// not in this generation: a not-found, not a mismatch
			expect(await reader.month("1999-01")).toEqual({
				ok: false,
				error: "not-in-manifest",
				key: monthViewKey("sch_hand", "1999-01"),
			});
			expect(await reader.member("family:nobody")).toMatchObject({
				ok: false,
				error: "not-in-manifest",
			});
		});
	});

	test("no manifest, and a manifest in an older format, are errors of their own", async () => {
		await withStore(async (store) => {
			expect(await readViewsFromStore(store, "sch_hand")).toEqual({
				ok: false,
				error: "no-manifest",
			});
			await store.putIfAbsent(
				manifestKey("sch_hand"),
				utf8('{"asOf":"2026-01-01T00:00:00.000Z"}\n'),
			);
			expect(await readViewsFromStore(store, "sch_hand")).toEqual({
				ok: false,
				error: "bad-manifest",
			});
		});
	});
});

describe("buildViews asOf cuts the log", () => {
	test("months, members and generatedFrom of an asOf in the middle equal those of only the earlier events", async () => {
		const events = await loadEvents();
		const asOf = new Date("2027-01-15T00:00:00Z");
		const earlier = events.filter(
			(e) => Date.parse(e.event_time) <= asOf.getTime(),
		);
		expect(earlier.length).toBeGreaterThan(10);
		expect(earlier.length).toBeLessThan(events.length);
		const cut = buildViews(events, { school: "sch_multi", asOf, catalog });
		const only = buildViews(earlier, { school: "sch_multi", asOf, catalog });
		expect(cut.ok && cut.views).toEqual(only.ok && only.views);
		if (!cut.ok) return;
		expect(cut.views.generatedFrom.eventCount).toBe(earlier.length);
		const lastMonth = Object.keys(cut.views.months).at(-1) as string;
		expect(lastMonth).toBe("2027-01");
		const total = Object.values(cut.views.months).reduce(
			(sum, month) =>
				sum + Object.values(month.counts).reduce((a, b) => a + b, 0),
			0,
		);
		expect(total).toBe(earlier.length);
	});
});
