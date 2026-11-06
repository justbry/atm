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
const noShow = (noShowRule: "spend" | "release", credits: number) =>
	sentence(
		consequenceLine({
			action: "noshow",
			waive: false,
			rules: { noShow: noShowRule, lateCancel: "spend" as const },
			booking: held(credits),
			creditUnit: unit,
			memberName: "Ivy N.",
		}),
	);

test("a no-show on one credit says is spent and returns; on two says are spent and return", () => {
	expect(noShow("spend", 1)).toBe(
		"Rule: a no-show spends the sessions. 1 session is spent.",
	);
	expect(noShow("spend", 2)).toBe(
		"Rule: a no-show spends the sessions. 2 sessions are spent.",
	);
	expect(noShow("release", 1)).toBe(
		"Rule: a no-show releases the sessions. 1 session returns to available.",
	);
	expect(noShow("release", 2)).toBe(
		"Rule: a no-show releases the sessions. 2 sessions return to available.",
	);
});

test("with no billing there is no line", () => {
	expect(
		consequenceLine({
			action: "noshow",
			waive: false,
			rules: { noShow: "spend" as const, lateCancel: "spend" as const },
			booking: { cutoffMinutes: 120 },
			creditUnit: unit,
			memberName: "Ivy N.",
		}),
	).toBeNull();
});
