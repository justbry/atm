import { beforeAll, describe, expect, test } from "bun:test";
import { type ParityReport, runParity } from "./parity/harness.ts";
import { isSlice, readTable, slugify } from "./parity/smoke.ts";

/**
 * The parity table's own test (protocol v9 addendum §3). Gate R itself is `bun test/parity/run.ts --slice S<k>`, which
 * also requires every owned check to pass; this file guards the table: well-formed, every na explained, and every check
 * it records as pass still passing on the UI.
 */
const table = readTable();
const entries = Object.entries(table.checks).filter(
	([, entry]) => !entry.removed,
);
let report: ParityReport;
beforeAll(async () => {
	report = await runParity("S7");
}, 120_000);

describe("parity table", () => {
	test("ids, slices and statuses are well formed", () => {
		const malformed = entries
			.filter(
				([id, entry]) =>
					id !== `${slugify(entry.name)}.${id.split(".").at(-1)}` ||
					!isSlice(entry.slice) ||
					!["pass", "fail", "pending-slice", "na"].includes(entry.status),
			)
			.map(([id]) => id);
		expect(malformed).toEqual([]);
	});
	test("every na says why", () => {
		expect(
			entries
				.filter(([, entry]) => entry.status === "na" && !entry.reason?.trim())
				.map(([id]) => id),
		).toEqual([]);
	});
	test("every check recorded as pass still passes on the UI", () => {
		const regressed = report.outcomes
			.filter(
				({ entry, result }) => entry.status === "pass" && result !== "pass",
			)
			.map(({ id, result, detail }) => `${id}: ${result} ${detail}`);
		expect(regressed).toEqual([]);
	});
});
