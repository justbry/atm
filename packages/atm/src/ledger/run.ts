import {
	applyMutation,
	type Catalog,
	type CatalogRow,
	catalogRowsToCatalog,
	computeApplyBillingPlan,
	parseApplyBillingPlanRequest,
	type SubjectState,
	type SubjectStateMutation,
	subjectStateToFullSubject,
} from "@autumn/balance-engine";
import { runEngineCommand } from "../engine.js";

/**
 * The engine reads the process time zone in one place: a rollover's expiry is `date-fns` `addMonths` in local
 * time (the cycle's reset itself is added on the UTC calendar), so the same command gives a different instant
 * on a machine in Denver than in UTC. Every ledger run pins UTC around the engine call and puts the old value back.
 */
export const withUtc = <T>(run: () => T): T => {
	const had = Object.hasOwn(process.env, "TZ");
	const before = process.env.TZ;
	process.env.TZ = "UTC";
	try {
		return run();
	} finally {
		if (had) process.env.TZ = before;
		else delete process.env.TZ;
	}
};

export type EngineCommandInput = {
	type?: unknown;
	commandId?: unknown;
} & Record<string, unknown>;

/**
 * The engine mints rollover ids with a random KSUID. An id that depends on chance would put different bytes in
 * the log on every run, so each `roll_*` id in a mutation is replaced by `roll_<commandId>_<n>` (n counts the
 * new ids in the order they appear), in the changes and in the result alike.
 */
export const canonicalRolloverIds = (
	mutation: SubjectStateMutation,
): SubjectStateMutation => {
	const map = new Map<string, string>();
	for (const change of mutation.changes) {
		if (change.table === "rollovers" && change.op === "insert") {
			map.set(change.row.id, `roll_${mutation.id}_${map.size + 1}`);
		}
	}
	if (map.size === 0) return mutation;
	let text = JSON.stringify(mutation);
	for (const [from, to] of map) text = text.split(from).join(to);
	return JSON.parse(text) as SubjectStateMutation;
};

export const toCatalog = (rows: readonly unknown[]): Catalog =>
	catalogRowsToCatalog({ rows: rows as CatalogRow[] });

/**
 * One engine command against a state: the mutation it decides (rollover ids made deterministic) and the state
 * after it. `applyBillingPlan` runs through `computeApplyBillingPlan`; the other commands through
 * `runEngineCommand`. A command that moves nothing (a null result) gives a null mutation and the same state.
 * The command carries its own time (`occurredAt`); nothing here reads the clock.
 */
export const runOnState = ({
	state,
	catalog,
	command,
}: {
	state: SubjectState | null;
	catalog: Catalog;
	command: EngineCommandInput;
}): { mutation: SubjectStateMutation | null; state: SubjectState | null } =>
	withUtc(() => {
		let mutation: SubjectStateMutation | null;
		if (command.type === "applyBillingPlan") {
			const { command: parsed } = parseApplyBillingPlanRequest({
				input: { command, catalogRows: [] },
			});
			mutation = computeApplyBillingPlan({ command: parsed, state, catalog });
		} else {
			if (!state) throw new Error("no subject yet: attach a plan first");
			const result = runEngineCommand({
				fullSubject: subjectStateToFullSubject({ state, catalog }),
				command,
			}) as SubjectStateMutation | { type: string } | null;
			if (result === null) mutation = null;
			else if ((result as { type?: string }).type !== "mutation") {
				throw new Error(`${String(command.type)} decides, it does not mutate`);
			} else mutation = result as SubjectStateMutation;
		}
		if (mutation === null) return { mutation, state };
		const canonical = canonicalRolloverIds(mutation);
		return {
			mutation: canonical,
			state: applyMutation({ state, mutation: canonical }),
		};
	});
