import type { PromoType } from "../data/ledger.ts";
import type { MembersWriter } from "../data/members.ts";
import type { Writer } from "../data/writer.ts";
import { promosBySchool } from "./ledger-data.ts";
import { fixtureQuantityChanged } from "./portal.ts";

/** The code the mockup makes for a new promo: its prefix and the lowest number of its random range. */
const createdCodes: Record<PromoType, string> = {
	member: "CODE1000",
	dollar: "GIFT1000",
	session: "SESS1000",
};

/** The fixture Writer: records every call in `calls`; in `hold` mode each call stays pending until `release()`. It
 * shares no state with the fixture Reader: a promo write answers the promo it made, and it holds no balances, so a
 * refund answers with the amount asked and nothing remaining. */
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
		result: () => Result,
	): Promise<Result> => {
		calls.push({ method, args });
		if (options.mode === "hold")
			await new Promise<void>((resolve) => held.push(resolve));
		return result();
	};
	const accepted = () => ({ accepted: true }) as const;
	return {
		calls,
		release: () => {
			for (const resolve of held) resolve();
			held = [];
		},
		recordOutcome: (request) =>
			record("recordOutcome", [request], () => ({
				creditEffect: "not_wired" as const,
			})),
		cancelBooking: (request) => record("cancelBooking", [request], accepted),
		saveMenu: (schoolId, menu) =>
			record("saveMenu", [schoolId, menu], () => undefined),
		publishMenu: (schoolId) =>
			record("publishMenu", [schoolId], () => undefined),
		refund: (request) =>
			record("refund", [request], () => ({
				refundId: `re_${calls.length}`,
				status: "pending" as const,
				refundedCents: request.amountCents,
				remainingCents: 0,
			})),
		adjustCredits: (request) => record("adjustCredits", [request], accepted),
		sendInvoice: (request) =>
			record("sendInvoice", [request], () => ({
				invoiceId: `in_${calls.length}`,
				status: "open" as const,
			})),
		grantFinance: (request) => record("grantFinance", [request], accepted),
		revokeFinance: (request) => record("revokeFinance", [request], accepted),
		changeRole: (request) => record("changeRole", [request], accepted),
		switchTier: (request) => record("switchTier", [request], accepted),
		cancelMembership: (request) =>
			record("cancelMembership", [request], accepted),
		resumeMembership: (request) =>
			record("resumeMembership", [request], accepted),
		download: (file) => record("download", [file], () => undefined),
		createPromo: (request) =>
			record("createPromo", [request], () => ({
				id: "c_new",
				code: createdCodes[request.type],
				type: request.type,
				value: request.value,
				used: 0,
				maxUses: request.type === "member" ? null : 1,
				expiresOn: request.expiresOn,
				status: "active" as const,
			})),
		disablePromo: (request) =>
			record("disablePromo", [request], () => {
				const promo = promosBySchool[request.school]?.find(
					({ id }) => id === request.promoId,
				);
				if (!promo) throw new Error(`no promo ${request.promoId}`);
				return { ...promo, status: "disabled" as const };
			}),
		portalChangeQuantity: (request) =>
			record("portalChangeQuantity", [request], () =>
				fixtureQuantityChanged(request, request.quantity),
			),
		portalCancelMembership: (request) =>
			record("portalCancelMembership", [request], () => undefined),
		portalResumeMembership: (request) =>
			record("portalResumeMembership", [request], () => undefined),
		portalCancelBooking: (request) =>
			record("portalCancelBooking", [request], () => undefined),
	};
}
