import type { MembersWriter } from "../data/members.ts";
import type { Writer } from "../data/writer.ts";

/** The fixture Writer: records every call in `calls`; in `hold` mode each call stays pending until `release()`. It
 * holds no balances, so a refund answers with the amount asked and nothing remaining. */
export function createFixtureWriter(options: {
	mode: "instant" | "hold";
}): Writer &
	MembersWriter & {
		calls: Array<{ method: string; args: unknown[] }>;
		release(): void;
	} {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	let held: Array<() => void> = [];
	const record = async <Result>(
		method: string,
		args: unknown[],
		result: Result,
	): Promise<Result> => {
		calls.push({ method, args });
		if (options.mode === "hold")
			await new Promise<void>((resolve) => held.push(resolve));
		return result;
	};
	const accepted = { accepted: true } as const;
	return {
		calls,
		release: () => {
			for (const resolve of held) resolve();
			held = [];
		},
		recordOutcome: (request) =>
			record("recordOutcome", [request], { creditEffect: "not_wired" }),
		cancelBooking: (request) => record("cancelBooking", [request], accepted),
		refund: (request) =>
			record("refund", [request], {
				refundId: `re_${calls.length}`,
				status: "pending",
				refundedCents: request.amountCents,
				remainingCents: 0,
			}),
		adjustCredits: (request) => record("adjustCredits", [request], accepted),
		sendInvoice: (request) =>
			record("sendInvoice", [request], {
				invoiceId: `in_${calls.length}`,
				status: "open",
			}),
		grantFinance: (request) => record("grantFinance", [request], accepted),
		revokeFinance: (request) => record("revokeFinance", [request], accepted),
		changeRole: (request) => record("changeRole", [request], accepted),
		switchTier: (request) => record("switchTier", [request], accepted),
		cancelMembership: (request) =>
			record("cancelMembership", [request], accepted),
		resumeMembership: (request) =>
			record("resumeMembership", [request], accepted),
	};
}
