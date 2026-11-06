/**
 * KPI suppression from events: the rules and the pure function are in `suppress-core.ts` (Worker-safe, re-exported here
 * so every importer keeps its path); this file adds `contributionsFromEvents`, which folds the events through the atm
 * channel once per holder and is test, CI and job tooling.
 */
import type { AtmEvent } from "../types.js";
import { atmChannel } from "./channels/atm.js";
import {
	evaluateKpis,
	isBase,
	type KpiRow,
	type KpiSpec,
	kpiRootId,
} from "./kpi-evaluate.js";
import {
	type Contributions,
	PROVIDER_RULE_KPIS,
	ROLLING_MONTHS,
} from "./suppress-core.js";

export type {
	Contributions,
	Shares,
	SumGroup,
	SuppressedCell as Cell,
	SuppressedCellInfo,
	SuppressedDocument,
	SuppressInput,
	SuppressionReason,
	SuppressionRules,
} from "./suppress-core.js";
export {
	DEFAULT_FAMILY_SUMS,
	DEFAULT_RULES,
	defaultSumGroups,
	isExportableKpiId,
	MIN_ACTIVE_PAYERS,
	PAIRED_KPIS,
	PROVIDER_RULE_KPIS,
	ROLLING_MONTHS,
	suppressKpis,
} from "./suppress-core.js";

/** The provider (tutor) labels an event may carry; the first one found in the events is used. */
export const PROVIDER_LABELS: readonly string[] = ["provider", "tutor"];
const UNATTRIBUTED = "unattributed";

const shift = (period: string, months: number): string => {
	const [year, month] = period.split("-").map(Number) as [number, number];
	const index = year * 12 + (month - 1) + months;
	return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
};

const sharesOfGroups = async ({
	groups,
	spec,
	periods,
}: {
	groups: Map<string, AtmEvent[]>;
	spec: KpiSpec;
	periods: readonly string[];
}): Promise<Contributions> => {
	const out: Contributions = {};
	for (const [contributor, events] of groups) {
		const base = await atmChannel.base({ events, spec, periods });
		for (const [id, byPeriod] of Object.entries(base))
			for (const [period, n] of Object.entries(byPeriod)) {
				if (n === 0) continue;
				const byPeriodOut = out[id] ?? {};
				out[id] = byPeriodOut;
				const cell = byPeriodOut[period] ?? {};
				byPeriodOut[period] = cell;
				cell[contributor] = n;
			}
	}
	return out;
};

export type EventContributions = {
	/** The school-wide rows by the normal path (atm channel, then `evaluateKpis`). */
	rows: KpiRow[];
	contributions: Contributions;
	/** Only when some event carries a provider label (see `PROVIDER_LABELS`); events without one count as one provider. */
	providerContributions?: Contributions;
	/** Holders with a `payment.succeeded` in the 12 months ending at the last period. */
	activePayers: number;
};

/**
 * Rows, per-holder shares (the atm channel run on each holder's events alone), per-provider shares for `providerKpis`
 * and the active-payer count, from the events. Test, CI and job tooling: it folds the events once per holder. No event
 * label names a provider today, so provider shares are produced only when `providerLabels` finds one.
 */
export const contributionsFromEvents = async ({
	events,
	spec,
	periods,
	providerLabels = PROVIDER_LABELS,
	providerKpis = PROVIDER_RULE_KPIS,
}: {
	events: readonly AtmEvent[];
	spec: KpiSpec;
	periods: readonly string[];
	providerLabels?: readonly string[];
	providerKpis?: readonly string[];
}): Promise<EventContributions> => {
	const rows = evaluateKpis({
		spec,
		base: await atmChannel.base({ events, spec, periods }),
		periods,
	});
	const byHolder = new Map<string, AtmEvent[]>();
	for (const event of events)
		byHolder.set(event.key, [...(byHolder.get(event.key) ?? []), event]);
	const contributions = await sharesOfGroups({
		groups: byHolder,
		spec,
		periods,
	});

	const labelName = providerLabels.find((name) =>
		events.some((event) => event.labels[name] !== undefined),
	);
	let providerContributions: Contributions | undefined;
	if (labelName) {
		const roots = new Set(providerKpis.map(kpiRootId));
		const byProvider = new Map<string, AtmEvent[]>();
		for (const event of events) {
			const provider = event.labels[labelName] ?? UNATTRIBUTED;
			byProvider.set(provider, [...(byProvider.get(provider) ?? []), event]);
		}
		providerContributions = await sharesOfGroups({
			groups: byProvider,
			spec: {
				...spec,
				kpis: spec.kpis.filter((kpi) => isBase(kpi) && roots.has(kpi.id)),
			},
			periods,
		});
	}

	const last = [...periods].sort().at(-1);
	const window = new Set(
		last
			? Array.from({ length: ROLLING_MONTHS }, (_, i) =>
					shift(last, i - (ROLLING_MONTHS - 1)),
				)
			: [],
	);
	const payers = new Set(
		events
			.filter(
				(event) =>
					event.event_type === "payment.succeeded" &&
					window.has(event.date.slice(0, 7)),
			)
			.map((event) => event.key),
	);
	return {
		rows,
		contributions,
		...(providerContributions ? { providerContributions } : {}),
		activePayers: payers.size,
	};
};
