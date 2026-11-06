import {
	checkOverride,
	type DisclosureFile,
	type DisclosureOverride,
} from "../data/disclosure.ts";
import type { PromoType } from "../data/ledger.ts";
import type { MembersWriter } from "../data/members.ts";
import type {
	CreatedKey,
	CreateKey,
	DisclosureSaved,
} from "../data/settings.ts";
import type { Writer } from "../data/writer.ts";
import disclosureFixture from "./disclosure.json";
import { promosBySchool } from "./ledger-data.ts";
import { fixtureQuantityChanged } from "./portal.ts";

/** The code the mockup makes for a new promo: its prefix and the lowest number of its random range. */
const createdCodes: Record<PromoType, string> = {
	member: "CODE1000",
	dollar: "GIFT1000",
	session: "SESS1000",
};

const disclosureFile = disclosureFixture.file as unknown as DisclosureFile;
const storedOverrides = disclosureFixture.schools as unknown as Record<
	string,
	{ override: DisclosureOverride }
>;
const stepUpExpiresInMinutes = 15;
const keyPrefixLength = 15;
const ledgerCredentialFirstNumber = 41;
/** Written out of pieces and a counter, so no key-shaped literal sits in the source. */
const secretBody = "Kx4mQ7".repeat(6);
const dollars = (minorUnits: number): string =>
	`$${Math.round(minorUnits / 100).toLocaleString("en-US")}`;

/** The fixture Writer: records every call in `calls`; in `hold` mode each call stays pending until `release()`. It
 * shares no state with the fixture Reader: a promo write answers the promo it made, and it holds no balances, so a
 * refund answers with the amount asked and nothing remaining. It keeps each school's saved disclosure override and the
 * one waiting on its mailed link. */
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
	const saved = new Map<string, DisclosureOverride>();
	const waitingForLink = new Map<string, DisclosureOverride>();
	const savedOverride = (school: string): DisclosureOverride =>
		saved.get(school) ?? storedOverrides[school]?.override ?? {};
	let createdKeys = 0;
	const createdKey = ({ kind, label }: CreateKey): CreatedKey => {
		createdKeys += 1;
		const id = `new${createdKeys}`;
		if (kind === "rd")
			return {
				kind,
				key: {
					id,
					kind,
					label,
					prefix: `ro_${ledgerCredentialFirstNumber + createdKeys}`,
					used: "never",
				},
				credential: {
					endpoint: "https://<account>.r2.cloudflarestorage.com",
					bucket: "b4uni-prod-ledger",
					prefix: `schools/${id}/`,
					keyId: `ROKEY${createdKeys}`,
					secret: secretBody.repeat(2),
				},
			};
		const secret = ["b4u", kind, "live", secretBody].join("_");
		return {
			kind,
			key: {
				id,
				kind,
				label,
				prefix: secret.slice(0, keyPrefixLength),
				used: "never",
			},
			secret,
		};
	};
	const nothing = () => undefined;
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
		saveMenu: (schoolId, menu) => record("saveMenu", [schoolId, menu], nothing),
		publishMenu: (schoolId) => record("publishMenu", [schoolId], nothing),
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
		download: (file) => record("download", [file], nothing),
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
			record("portalCancelMembership", [request], nothing),
		portalResumeMembership: (request) =>
			record("portalResumeMembership", [request], nothing),
		portalCancelBooking: (request) =>
			record("portalCancelBooking", [request], nothing),
		saveAccountingBasis: (request) =>
			record("saveAccountingBasis", [request], nothing),
		createKey: (request) => {
			const created = createdKey(request);
			return record("createKey", [request], () => created);
		},
		revokeKey: (request) => record("revokeKey", [request], nothing),
		saveStripeKey: (request) => record("saveStripeKey", [request], nothing),
		removeStripeKey: (request) => record("removeStripeKey", [request], nothing),
		saveZeffyKey: (request) => record("saveZeffyKey", [request], nothing),
		removeZeffyKey: (request) => record("removeZeffyKey", [request], nothing),
		saveDisclosure: (request) => {
			const { change } = checkOverride(
				disclosureFile,
				savedOverride(request.school),
				request.override,
				dollars,
			);
			let result: DisclosureSaved = { status: "saved" };
			if (change === "public_open") {
				waitingForLink.set(request.school, request.override);
				result = {
					status: "step_up",
					expiresInMinutes: stepUpExpiresInMinutes,
				};
			} else saved.set(request.school, request.override);
			return record("saveDisclosure", [request], () => result);
		},
		confirmDisclosureStepUp: (request) => {
			const waiting = waitingForLink.get(request.school);
			if (waiting) saved.set(request.school, waiting);
			waitingForLink.delete(request.school);
			return record("confirmDisclosureStepUp", [request], () => ({
				status: "saved" as const,
			}));
		},
	};
}
