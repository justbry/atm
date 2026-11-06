/** docs/suppression-report.md is the output of `suppressionReport()`; `UPDATE_GOLDEN=1` rewrites it. */
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import {
	REPORT_PATH,
	suppressionReport,
} from "../fixtures/suppression-report.js";
import { PROFILE_NAMES } from "../src/scenario/profiles.js";

const HOLDER_ID = /(family|profile):/;
const HEX_DIGEST = /\b[0-9a-f]{32,}\b/;

describe("suppression report", () => {
	test("docs/suppression-report.md is up to date", async () => {
		const report = await suppressionReport();
		if (process.env.UPDATE_GOLDEN) writeFileSync(REPORT_PATH, report);
		expect(report).toBe(readFileSync(REPORT_PATH, "utf8"));
	});

	test("is deterministic", async () => {
		expect(await suppressionReport()).toBe(await suppressionReport());
	});

	test("covers every preset and names no holder or digest", async () => {
		const report = await suppressionReport();
		for (const name of PROFILE_NAMES) expect(report).toContain(`### ${name}`);
		expect(report).not.toMatch(HOLDER_ID);
		expect(report).not.toMatch(HEX_DIGEST);
	});
});
