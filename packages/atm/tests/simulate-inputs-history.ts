/**
 * Seeded histories through the real reference handler, for the baseline identity of `simulateFromInputs`: the family
 * service of `billing-play.ts` over `handleStripeWebhook` and SQLite, so the inputs are stored by the handler itself.
 */
import { makeRng } from "../fixtures/rng.js";
import { menuCatalogRows } from "../src/billing/grants.js";
import {
	type BillingRow,
	rowChangesFromMutation,
	StaleRevision,
	stateFromRows,
	subjectKey,
} from "../src/billing/rows.js";
import { menuLineItems } from "../src/billing/stripe-menu.js";
import type { Menu } from "../src/billing/types.js";
import { recordEngineCommand } from "../src/ledger/outbox.js";
import { balancesOf } from "../src/ledger/replay.js";
import { runOnState, toCatalog } from "../src/ledger/run.js";
import type { RowChanges, SqlDatabase } from "../src/types.js";
import {
	menu as billingMenu,
	FAMILY as PLAY_FAMILY,
	SCHOOL as PLAY_SCHOOL,
} from "./billing-play.js";
import type { Harness } from "./simulate-inputs-world.js";
import { priceIdOf } from "./stripe-events.js";

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;

/** The family service's revision-checked write of a subject's rows (`schema/storage/rows.v1.sql`). */
export const writeRows = (db: SqlDatabase, changes: RowChanges): void => {
	const { subjectKey: key, expectedRevision, nextRevision } = changes;
	let moved = db.run(
		`UPDATE atm_subjects SET revision = ? WHERE subject_key = ? AND revision = ?`,
		[nextRevision, key, expectedRevision],
	).changes;
	if (moved === 0 && expectedRevision === 0)
		moved = db.run(
			`INSERT INTO atm_subjects (subject_key, revision) VALUES (?, ?) ON CONFLICT (subject_key) DO NOTHING`,
			[key, nextRevision],
		).changes;
	if (moved === 0) throw new StaleRevision(expectedRevision, 0, key);
	for (const upsert of changes.upserts)
		db.run(
			`INSERT INTO atm_rows (subject_key, table_name, row_id, data) VALUES (?, ?, ?, ?) ON CONFLICT (subject_key, table_name, row_id) DO UPDATE SET data = excluded.data`,
			[key, upsert.table, upsert.id, JSON.stringify(upsert.data)],
		);
	for (const removed of changes.deletes)
		db.run(
			`DELETE FROM atm_rows WHERE subject_key = ? AND table_name = ? AND row_id = ?`,
			[key, removed.table, removed.id],
		);
};

export const loadRows = (db: SqlDatabase, key: string) => {
	const [subject] = db.all<{ revision: number }>(
		`SELECT revision FROM atm_subjects WHERE subject_key = ?`,
		[key],
	);
	const rows = db
		.all<{ table_name: string; row_id: string; data: string }>(
			`SELECT table_name, row_id, data FROM atm_rows WHERE subject_key = ? ORDER BY table_name, row_id`,
			[key],
		)
		.map((row) => ({
			table: row.table_name,
			id: row.row_id,
			data: JSON.parse(row.data),
		})) as BillingRow[];
	return { rows, revision: subject?.revision ?? 0 };
};

export type HistoryStyle = "plain" | "mixed";

export type HistoryStore = {
	handle: (event: unknown, at: number) => { refused: null };
	spend: (
		n: number,
		at: number,
		kind?: "hold" | "spend",
		options?: { log?: boolean },
	) => void;
	avail: (at: number, feature?: string) => number;
	readonly rows: BillingRow[];
	/** Delivers what was held back, retrying until nothing waits. */
	flush: () => void;
	counts: Record<string, number>;
};

const feeOf = (raw: unknown): number => {
	const paidAmount = (raw as { data: { object: { amount_paid?: number } } })
		.data.object.amount_paid;
	return Math.max(0, Math.min(300, paidAmount ?? 0));
};

const bump = (counts: Record<string, number>, name: string) => {
	counts[name] = (counts[name] ?? 0) + 1;
};

/**
 * With style `mixed` the deliveries are what Stripe does: some held back and retried after a 409, some sent twice, some
 * failing once in the handler (a fee lookup that throws) and retried, and an invoice refused (422) under a menu that does
 * not know its price first and applied under the menu that does. Spends and holds are the family service's own engine
 * commands, rows and `recordEngineCommand` in one transaction. `bumpVersion` gives the broken menu another version label.
 */
export const historyStore = (
	h: Harness,
	{
		seed,
		style,
		bumpVersion = false,
	}: { seed: number; style: HistoryStyle; bumpVersion?: boolean },
): HistoryStore => {
	const rng = makeRng(`history-${seed}`);
	const identity = {
		orgId: PLAY_SCHOOL,
		env: "live",
		customerId: `family:${PLAY_FAMILY}`,
		entityId: null,
	};
	const key = subjectKey(identity);
	const catalog = toCatalog(
		menuCatalogRows({ menu: billingMenu, school: PLAY_SCHOOL }),
	);
	const counts: Record<string, number> = {};
	const failOnce = new Set<string>();
	h.deps.claimStaleAfterMs = 1;
	h.deps.paymentRefs = (raw) => {
		const id = (raw as { data: { object: { id: string } } }).data.object.id;
		return [`pi_${id}`, `ch_${id}`];
	};
	h.deps.paymentFee = (raw) => {
		const id = (raw as { data: { object: { id: string } } }).data.object.id;
		if (failOnce.delete(id)) throw new Error("Stripe is down");
		return feeOf(raw);
	};
	const goodContext = h.deps.context;
	const brokenMenu: Menu = {
		...billingMenu,
		tiers: billingMenu.tiers.map((tier) => ({
			...tier,
			prices: tier.prices.map((price) => ({
				...price,
				amount: price.amount + 1,
			})),
		})),
	};
	const brokenContext = () => ({
		...(goodContext(PLAY_SCHOOL) as NonNullable<
			ReturnType<typeof goodContext>
		>),
		menu: brokenMenu,
		menuVersion: bumpVersion ? 4 : 3,
		catalog: menuCatalogRows({ menu: brokenMenu, school: PLAY_SCHOOL }),
		priceIds: Object.fromEntries(
			[...menuLineItems(PLAY_SCHOOL, brokenMenu).keys()].map((k) => [
				k,
				priceIdOf(k),
			]),
		),
	});
	const waiting: { event: unknown; at: number; due: number }[] = [];
	let sent = 0;
	let commands = 0;
	let last = 0;

	const deliver = (event: unknown, at: number): number => {
		last = Math.max(last, at);
		try {
			return h.deliver(event as never, at).status;
		} catch {
			bump(counts, "failed");
			return 500;
		}
	};
	const settleWaiting = (force: boolean) => {
		for (let pass = 0; pass < 8; pass += 1) {
			let progress = false;
			for (const item of [...waiting]) {
				if (!force && item.due > sent) continue;
				const status = deliver(item.event, Math.max(item.at, last) + 1000);
				if (status === 409 || status === 500) {
					item.due = sent + 1;
					continue;
				}
				waiting.splice(waiting.indexOf(item), 1);
				progress = true;
			}
			if (!force || !progress) return;
		}
	};
	const handle = (event: unknown, at: number) => {
		sent += 1;
		settleWaiting(false);
		const type = (event as { type: string }).type;
		const id = (event as { data: { object: { id: string } } }).data.object.id;
		const roll = style === "plain" ? 0.5 : rng.next();
		const shuffled = style === "mixed";
		if (shuffled && roll < 0.15) {
			bump(counts, "deferred");
			waiting.push({ event, at, due: sent + rng.int(1, 3) });
			return { refused: null } as const;
		}
		if (shuffled && type === "invoice.paid" && roll < 0.27) {
			bump(counts, "refused");
			h.deps.context = brokenContext;
			deliver(event, at);
			h.deps.context = goodContext;
			deliver(event, at + 1000);
			return { refused: null } as const;
		}
		if (shuffled && type === "invoice.paid" && roll < 0.4) {
			failOnce.add(id);
			deliver(event, at);
			failOnce.delete(id);
			deliver(event, at + 400_000);
			return { refused: null } as const;
		}
		const status = deliver(event, at);
		if (status === 409) waiting.push({ event, at, due: sent + 1 });
		if (shuffled && roll > 0.85) {
			bump(counts, "duplicated");
			deliver(event, at + 500);
		}
		return { refused: null } as const;
	};
	const stateNow = () => {
		const { rows, revision } = loadRows(h.db, key);
		return {
			rows,
			revision,
			state: stateFromRows({ identity, revision, rows }),
		};
	};
	const command = (
		type: string,
		at: number,
		fields: Record<string, unknown>,
		context: Record<string, unknown> = {},
		record = true,
	) => {
		commands += 1;
		return h.db.transaction(() => {
			const { rows, revision, state } = stateNow();
			const { mutation } = runOnState({
				state,
				catalog,
				command: {
					schemaVersion: 1,
					type,
					org: { config: {} },
					commandId: `${type}_${commands}`,
					requestId: `${type}_${commands}`,
					identity,
					occurredAt: at,
					...fields,
				},
			});
			if (!mutation) return null;
			if (record)
				recordEngineCommand({
					db: h.db,
					mutation: mutation as never,
					before: state as never,
					context: {
						tz: billingMenu.timeZone,
						feature: "visit",
						reason: "visit taken",
						...context,
					} as never,
					logsEveryCommand: true,
				});
			writeRows(
				h.db,
				rowChangesFromMutation({ mutation: mutation as never, rows, revision }),
			);
			return mutation;
		});
	};
	const spend = (
		n: number,
		at: number,
		kind?: "hold" | "spend",
		options: { log?: boolean } = {},
	) => {
		settleWaiting(true);
		const hold =
			kind === undefined
				? style === "mixed" && rng.next() < 0.4
				: kind === "hold";
		if (hold) {
			bump(counts, "holds");
			const lockId = `bk_${commands + 1}`;
			const held = command("track", at, {
				featureId: "visit",
				internalFeatureId: "feat_visit",
				value: n,
				overageBehavior: "reject",
				properties: null,
				usageEvent: null,
				lock: {
					id: `lock_${lockId}`,
					lockId,
					expiresAt: at + WEEK,
					expiryAction: "confirm",
				},
			});
			const lock = (
				held?.changes as
					| { table: string; op: string; row?: unknown }[]
					| undefined
			)?.find((c) => c.table === "locks" && c.op === "insert")?.row;
			if (lock)
				command(
					"finalize",
					at + HOUR,
					{
						featureId: "visit",
						internalFeatureId: "feat_visit",
						lock,
						finalValue: n,
						properties: null,
					},
					{ service: "massage-90", settleAs: "spent" },
				);
			return;
		}
		bump(counts, "spends");
		command(
			"updateBalance",
			at,
			{
				featureId: "visit",
				internalFeatureId: "feat_visit",
				addToBalance: -n,
			},
			{},
			options.log !== false,
		);
	};
	return {
		handle,
		spend,
		avail: (at, feature = "visit") => {
			settleWaiting(true);
			const { state } = stateNow();
			if (!state) return 0;
			return (
				balancesOf({
					states: { [`family:${PLAY_FAMILY}`]: state as never },
					holds: {},
					catalog,
					asOfMs: at,
				}).find((b) => b.feature === feature)?.avail ?? 0
			);
		},
		get rows() {
			return loadRows(h.db, key).rows;
		},
		flush: () => settleWaiting(true),
		counts,
	};
};
