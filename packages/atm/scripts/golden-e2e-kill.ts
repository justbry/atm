#!/usr/bin/env bun
/**
 * The real `atm` command line with one change: the folder store kills the process (SIGKILL, no cleanup) at a chosen
 * operation. It exists for the crash drill (`tests/golden-e2e-check.test.ts`, S4), which needs to stop `atm ship` and
 * `atm inputs ship` at an exact point instead of at a lucky moment.
 *
 *   ATM_KILL_OP     put or delete: which store operation to count (default put)
 *   ATM_KILL_AT     the 1-based count of that operation at which to die (0 or unset: never)
 *   ATM_KILL_PHASE  before: die as the operation begins; after: die as it has finished and before the shipper marks its rows
 *
 * Usage: bun scripts/golden-e2e-kill.ts <atm arguments>, for example `inputs ship --db ... --school ... --env live --root ...`.
 */
import { program } from "../src/cli.js";
import { FolderStore } from "../src/store/folder-store.js";

const operation = process.env.ATM_KILL_OP === "delete" ? "delete" : "put";
const at = Number(process.env.ATM_KILL_AT ?? 0);
const phase = process.env.ATM_KILL_PHASE === "before" ? "before" : "after";
let seen = 0;

const original = {
	put: FolderStore.prototype.putIfAbsent,
	delete: FolderStore.prototype.delete,
};

const die = (): never => {
	process.kill(process.pid, "SIGKILL");
	throw new Error("unreachable");
};

const guard = <Args extends unknown[], Result>(
	kind: "put" | "delete",
	run: (this: FolderStore, ...args: Args) => Promise<Result>,
) =>
	async function (this: FolderStore, ...args: Args): Promise<Result> {
		const mine = kind === operation && at > 0;
		if (mine) seen += 1;
		if (mine && seen === at && phase === "before") die();
		const result = await run.apply(this, args);
		if (mine && seen === at && phase === "after") die();
		return result;
	};

FolderStore.prototype.putIfAbsent = guard(
	"put",
	original.put as (
		this: FolderStore,
		...args: Parameters<FolderStore["putIfAbsent"]>
	) => Promise<Awaited<ReturnType<FolderStore["putIfAbsent"]>>>,
);
FolderStore.prototype.delete = guard(
	"delete",
	original.delete as (
		this: FolderStore,
		...args: Parameters<FolderStore["delete"]>
	) => Promise<Awaited<ReturnType<FolderStore["delete"]>>>,
);

await program.parseAsync(process.argv);
