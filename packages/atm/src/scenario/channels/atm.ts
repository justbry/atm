/** The atm channel: the KPI spec folded over the events in TypeScript, the way `balancesOf` folds them for a replay. */
import { decimalToUnits } from "../../ledger/util.js";
import type { AtmEvent } from "../../types.js";
import {
	type BaseKpi,
	type BaseValues,
	isBase,
	type KpiChannel,
} from "../kpi-evaluate.js";

const USD = "USD";

const dimensionOf = (
	by: NonNullable<BaseKpi["compute"]["by"]>,
	text: string | undefined,
): string | null => {
	if (text === undefined) return null;
	const found = new RegExp(by.pattern).exec(text);
	return found?.[1] ?? null;
};

const matchesEvent = (event: AtmEvent, where: BaseKpi["compute"]["where"]) => {
	if (where.eventType && !where.eventType.includes(event.event_type))
		return false;
	if (where.label) {
		const value = event.labels[where.label.name];
		if (value === undefined || !new RegExp(where.label.pattern).test(value))
			return false;
	}
	return true;
};

/** Synchronous: the fold needs no engine, so a Worker can run it inside a pure function (`satisfies`, not `: KpiChannel`, keeps the return type `BaseValues`). */
export const atmChannel = {
	name: "atm",
	base: ({ events, spec, periods }) => {
		const known = new Set(periods);
		const out: BaseValues = {};
		for (const kpi of spec.kpis) {
			if (!isBase(kpi)) continue;
			const c = kpi.compute;
			const local: BaseValues = {};
			const add = (id: string, period: string, n: number) => {
				const values = local[id] ?? {};
				local[id] = values;
				values[period] = (values[period] ?? 0) + n;
			};
			const account = c.where.account ? new RegExp(c.where.account) : null;
			const seenHolders = new Map<string, string>();
			const distinctSeen = new Set<string>();
			const ordered = [...events].sort((a, b) =>
				a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
			);
			for (const event of ordered) {
				const period = event.date.slice(0, 7);
				// a cumulative sum needs every earlier event; the others only the periods asked for
				const wanted =
					c.op === "sum" && c.cumulative
						? period <= (periods.at(-1) as string)
						: known.has(period);
				if (!wanted || !matchesEvent(event, c.where)) continue;
				if (c.op === "sum") {
					for (const p of event.postings) {
						if ((p.commodity === USD) !== (c.commodity === "usd")) continue;
						if (account && !account.test(p.account)) continue;
						const dim = c.by
							? dimensionOf(
									c.by,
									c.by.from === "account"
										? p.account
										: event.labels[c.by.from.slice("label:".length)],
								)
							: undefined;
						if (dim === null) continue;
						const units = Number(
							decimalToUnits(p.amount, c.commodity === "usd" ? 2 : 0),
						);
						add(
							dim === undefined ? kpi.id : `${kpi.id}:${dim}`,
							period,
							c.sign * units,
						);
					}
					continue;
				}
				if (account && !event.postings.some((p) => account.test(p.account)))
					continue;
				const dim = c.by
					? dimensionOf(
							c.by,
							c.by.from === "account"
								? undefined
								: event.labels[c.by.from.slice("label:".length)],
						)
					: undefined;
				if (dim === null) continue;
				const id = dim === undefined ? kpi.id : `${kpi.id}:${dim}`;
				if (c.op === "count") add(id, period, 1);
				else {
					const holder = `${id}\u0000${period}\u0000${event.key}`;
					if (c.first) {
						const firstPeriod = seenHolders.get(`${id}\u0000${event.key}`);
						if (firstPeriod !== undefined && firstPeriod !== period) continue;
						seenHolders.set(`${id}\u0000${event.key}`, period);
					}
					if (distinctSeen.has(holder)) continue;
					distinctSeen.add(holder);
					add(id, period, 1);
				}
			}
			for (const [id, movement] of Object.entries(local)) {
				if (!(c.op === "sum" && c.cumulative)) {
					out[id] = movement;
					continue;
				}
				// a balance carries into the months with no postings, and opens with everything booked before the first period
				const balance: Record<string, number> = {};
				let running = 0;
				const months = [
					...new Set([...Object.keys(movement), ...periods]),
				].sort();
				for (const month of months) {
					running += movement[month] ?? 0;
					if (known.has(month)) balance[month] = running;
				}
				out[id] = balance;
			}
		}
		return out;
	},
} satisfies KpiChannel;
