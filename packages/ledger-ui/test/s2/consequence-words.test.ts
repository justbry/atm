import { expect, test } from "bun:test";
import { consequenceLine } from "../../src/app/booking-text.ts";

const unit = { one: "session", other: "sessions" };
const held = (credits: number) => ({
	billing: { kind: "held" as const, credits },
	cutoffMinutes: 120,
});
const sentence = (
	line: { before: string; strong: string; after: string } | null,
): string => (line ? `${line.before}${line.strong}${line.after}` : "");

test("a released hold of one credit returns, of two credits return", () => {
	const input = {
		action: "release" as const,
		waive: true,
		rules: { noShow: "spend" as const, lateCancel: "spend" as const },
		creditUnit: unit,
		memberName: "Ivy N.",
	};
	expect(sentence(consequenceLine({ ...input, booking: held(1) }))).toBe(
		"1 session returns to Ivy N.'s available balance.",
	);
	expect(sentence(consequenceLine({ ...input, booking: held(2) }))).toBe(
		"2 sessions return to Ivy N.'s available balance.",
	);
});

test("the forfeit line keeps its verb for the rule and counts with the unit's words", () => {
	const line = consequenceLine({
		action: "release",
		waive: false,
		rules: { noShow: "spend" as const, lateCancel: "spend" as const },
		booking: held(1),
		creditUnit: unit,
		memberName: "Ivy N.",
	});
	expect(line?.strong).toBe("forfeits 1 session");
});
