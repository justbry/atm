import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
	ReconcilePeriod,
	ReconcileResult,
	ReconcileStripe,
	ReconcileStripeList,
} from "../types.js";
import { readEvents } from "./files.js";
import { ReconcileInputError, reconcile } from "./reconcile.js";

/** The file `atm reconcile --stripe <dir>` reads for each list, named as the Stripe resource. */
export const STRIPE_FILES: Record<ReconcileStripeList, string> = {
	invoices: "invoices.json",
	refunds: "refunds.json",
	disputes: "disputes.json",
	payouts: "payouts.json",
	balanceTransactions: "balance_transactions.json",
};

/** The numbers each record must carry: a missing one would otherwise compare as NaN and match nothing. */
const NUMBER_FIELDS: Record<ReconcileStripeList, string[]> = {
	invoices: ["amount_paid", "created"],
	refunds: ["amount", "created"],
	disputes: ["amount", "created"],
	payouts: ["amount", "created"],
	balanceTransactions: ["amount", "fee", "net", "created"],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The records of one file: a bare array, or the list object `stripe ... list` prints (`{ object: "list", data, has_more }`). */
const recordsOf = (
	list: ReconcileStripeList,
	file: string,
	parsed: unknown,
): unknown[] => {
	let data = parsed;
	if (isRecord(parsed) && Array.isArray(parsed.data)) {
		if (parsed.has_more === true)
			throw new ReconcileInputError(
				`${file} is one page of a longer list (has_more is true); fetch every page (--limit 100 and --starting-after) and join the data`,
			);
		data = parsed.data;
	}
	if (!Array.isArray(data))
		throw new ReconcileInputError(
			`${file} must be a JSON array or a Stripe list object with a data array`,
		);
	data.forEach((record, index) => {
		const bad =
			!isRecord(record) ||
			typeof record.id !== "string" ||
			NUMBER_FIELDS[list].some((field) => !Number.isFinite(record[field]));
		if (bad)
			throw new ReconcileInputError(
				`${file} record ${index} needs a string id and numeric ${NUMBER_FIELDS[list].join(", ")}`,
			);
	});
	return data;
};

/**
 * Reads the Stripe files in `directory`. A file that is not there leaves its list undefined (reported as not supplied);
 * one that is there but unreadable or not a list is bad input. A folder with none of the files is bad input too.
 */
export const readStripeDirectory = async (
	directory: string,
): Promise<ReconcileStripe> => {
	const info = await stat(directory).catch(() => null);
	if (!info?.isDirectory())
		throw new ReconcileInputError(`--stripe ${directory} is not a folder`);
	const stripe: Record<string, unknown[]> = {};
	for (const [list, file] of Object.entries(STRIPE_FILES) as [
		ReconcileStripeList,
		string,
	][]) {
		const text = await readFile(join(directory, file), "utf8").catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return null;
				throw new ReconcileInputError(`cannot read ${file}: ${error.message}`);
			},
		);
		if (text === null) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new ReconcileInputError(`${file} is not valid JSON`);
		}
		stripe[list] = recordsOf(list, file, parsed);
	}
	if (Object.keys(stripe).length === 0)
		throw new ReconcileInputError(
			`--stripe ${directory} has none of ${Object.values(STRIPE_FILES).join(", ")}`,
		);
	return stripe as ReconcileStripe;
};

/** `atm reconcile`: the school's events under `root` against the Stripe files in `stripeDirectory`. */
export const reconcileFolder = async ({
	root,
	school,
	period,
	stripeDirectory,
	timeZone,
	mode,
}: {
	root: string;
	school: string;
	period: ReconcilePeriod;
	stripeDirectory: string;
	timeZone?: string;
	mode?: "live" | "test";
}): Promise<ReconcileResult> => {
	// A typo in --school would otherwise read no events and report every Stripe record missing.
	const schoolFolder = await stat(join(root, "schools", school)).catch(
		() => null,
	);
	if (!schoolFolder?.isDirectory())
		throw new ReconcileInputError(
			`no school folder ${join(root, "schools", school)}`,
		);
	const stripe = await readStripeDirectory(stripeDirectory);
	const { events } = await readEvents(root, school);
	return reconcile({ events, stripe, period, timeZone, mode });
};

const dollars = (cents: number | null): string =>
	cents === null ? "none" : `${(cents / 100).toFixed(2)}`;

/** A human summary: the period, what was checked, then one line per difference. */
export const formatReconcile = (result: ReconcileResult): string => {
	const lines = [
		`reconcile ${result.period.label} (${result.period.timeZone}, ${result.mode} mode)`,
	];
	for (const list of result.notSupplied)
		lines.push(`not supplied: ${STRIPE_FILES[list]} (its checks did not run)`);
	for (const [reason, count] of Object.entries(result.ignored))
		lines.push(`ignored ${count} Stripe record(s): ${reason}`);
	for (const [object, count] of Object.entries(result.counts))
		lines.push(
			`${object}: Stripe ${count.stripe ?? "not supplied"}, log ${count.log}`,
		);
	if (result.differences.length === 0) {
		lines.push("no differences");
		return `${lines.join("\n")}\n`;
	}
	for (const difference of result.differences) {
		const amounts =
			difference.stripe?.amount != null || difference.log?.amount != null
				? ` [stripe ${dollars(difference.stripe?.amount ?? null)}, log ${dollars(difference.log?.amount ?? null)}]`
				: "";
		lines.push(`${difference.kind}: ${difference.message}${amounts}`);
	}
	lines.push(`${result.differences.length} difference(s)`);
	return `${lines.join("\n")}\n`;
};
