/**
 * What open bookings hold, read from the grants state: the units each lock took from each credit row, whether the row has
 * reset since the hold, and what refunded invoices are still owed. Shared by the booking commands (a release takes the
 * owed units back) and the refund rule (it records them). Pure; reads nothing but its arguments.
 */
import type { BookingRecord, GrantsState, HoldLock } from "../types.js";

export const CREDIT_ROWS = "customerEntitlements";
export const ROLLOVER_ROWS = "rollovers";

export type LockDelta = {
	table: string;
	id: string;
	/** The units the lock took from the row (credits are one per unit). */
	units: number;
};

/** What a lock row took from each balance row, in the order it took them. A delta that took nothing is left out. */
export const lockDeltasOf = (lock: HoldLock | undefined): LockDelta[] => {
	const deltas = (lock?.deltas as Record<string, unknown>[] | undefined) ?? [];
	return deltas.flatMap((delta) => {
		const units = -(Number(delta.valueDelta) || 0);
		return units > 0 && typeof delta.id === "string"
			? [{ table: String(delta.table), id: delta.id, units }]
			: [];
	});
};

/**
 * Whether a credit row has reset since the hold was made: the reset that was due when the hold was made has passed and the
 * row's next reset is no longer that one (the reset ran, or the subscription ended and the row stopped refilling). A row
 * that was not due to reset, and a reset that is late (still due), are not.
 */
export const resetSinceHold = ({
	record,
	rowId,
	nextResetAt,
	now,
}: {
	record: BookingRecord;
	rowId: string;
	nextResetAt: number | null | undefined;
	now: number;
}): boolean => {
	const due = record.resetsAt?.[rowId];
	return due !== undefined && due <= now && nextResetAt !== due;
};

/**
 * The units open holds keep on each balance row, by row id, counting only units of the row's current refill: a hold made
 * before the row's last reset holds last cycle's units, which no invoice of this cycle granted.
 */
export const heldOnRows = ({
	grants,
	nextResetOf,
	now,
}: {
	grants: GrantsState;
	nextResetOf: (rowId: string) => number | null | undefined;
	now: number;
}): Map<string, number> => {
	const held = new Map<string, number>();
	for (const record of Object.values(grants.bookings ?? {})) {
		if (record.state !== "held") continue;
		for (const delta of lockDeltasOf(record.lock)) {
			if (
				delta.table === CREDIT_ROWS &&
				resetSinceHold({
					record,
					rowId: delta.id,
					nextResetAt: nextResetOf(delta.id),
					now,
				})
			)
				continue;
			held.set(delta.id, (held.get(delta.id) ?? 0) + delta.units);
		}
	}
	return held;
};

/** What the removed invoices are still owed on each row, summed over the invoices. */
export const owedOnRows = (grants: GrantsState): Map<string, number> => {
	const owed = new Map<string, number>();
	for (const record of Object.values(grants.invoices))
		for (const [rowId, units] of Object.entries(record.owed ?? {}))
			owed.set(rowId, (owed.get(rowId) ?? 0) + units);
	return owed;
};

/**
 * Settles up to `units` of what the invoices are owed on `rowId`, invoice by invoice in id order. Returns the units settled
 * and the invoices with their `owed` lowered (a row owed nothing is dropped, and an invoice owed nothing loses the key);
 * the same object when nothing is owed on the row.
 */
export const settleOwed = ({
	invoices,
	rowId,
	units,
}: {
	invoices: GrantsState["invoices"];
	rowId: string;
	units: number;
}): { settled: number; invoices: GrantsState["invoices"] } => {
	let left = units;
	let next = invoices;
	for (const invoiceId of Object.keys(invoices).sort()) {
		if (left <= 0) break;
		const record = next[invoiceId];
		const owed = record?.owed?.[rowId];
		if (!record || owed === undefined || owed <= 0) continue;
		const taken = Math.min(owed, left);
		left -= taken;
		const { [rowId]: _settledRow, ...otherRows } = record.owed ?? {};
		const remaining =
			owed - taken > 0 ? { ...otherRows, [rowId]: owed - taken } : otherRows;
		const { owed: _owed, ...rest } = record;
		next = {
			...next,
			[invoiceId]:
				Object.keys(remaining).length > 0 ? { ...rest, owed: remaining } : rest,
		};
	}
	return { settled: units - left, invoices: next };
};
