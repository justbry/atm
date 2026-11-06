import type { PromoType } from "../data/ledger.ts";
import type { Writer } from "../data/writer.ts";
import { promosBySchool } from "./ledger-data.ts";

/** The code the mockup makes for a new promo: its prefix and the lowest number of its random range. */
const createdCodes: Record<PromoType, string> = {
	member: "CODE1000",
	dollar: "GIFT1000",
	session: "SESS1000",
};

/** The fixture Writer: records every call in `calls`; in `hold` mode each call stays pending until `release()`. It
 * shares no state with the fixture Reader: a promo write answers the promo it made. */
export function createFixtureWriter(options: {
	mode: "instant" | "hold";
}): Writer & {
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
		cancelBooking: (request) =>
			record("cancelBooking", [request], () => undefined),
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
	};
}
