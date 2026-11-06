import type { DisclosureOverride } from "../data/disclosure.ts";
import { checkOverride, type DisclosureFile } from "../data/disclosure.ts";
import type {
	CreatedKey,
	CreateKey,
	DisclosureSaved,
} from "../data/settings.ts";
import type { Writer } from "../data/writer.ts";
import disclosureFixture from "./disclosure.json";

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

/** The fixture Writer: records every call in `calls`; in `hold` mode each call stays pending until `release()`.
 * It keeps each school's saved disclosure override and the one waiting on its mailed link. */
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
		result: Result,
	): Promise<Result> => {
		calls.push({ method, args });
		if (options.mode === "hold")
			await new Promise<void>((resolve) => held.push(resolve));
		return result;
	};
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
	return {
		calls,
		release: () => {
			for (const resolve of held) resolve();
			held = [];
		},
		recordOutcome: (request) =>
			record("recordOutcome", [request], { creditEffect: "not_wired" }),
		cancelBooking: (request) => record("cancelBooking", [request], undefined),
		saveAccountingBasis: (request) =>
			record("saveAccountingBasis", [request], undefined),
		createKey: (request) => record("createKey", [request], createdKey(request)),
		revokeKey: (request) => record("revokeKey", [request], undefined),
		saveStripeKey: (request) => record("saveStripeKey", [request], undefined),
		removeStripeKey: (request) =>
			record("removeStripeKey", [request], undefined),
		saveZeffyKey: (request) => record("saveZeffyKey", [request], undefined),
		removeZeffyKey: (request) => record("removeZeffyKey", [request], undefined),
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
			return record("saveDisclosure", [request], result);
		},
		confirmDisclosureStepUp: (request) => {
			const waiting = waitingForLink.get(request.school);
			if (waiting) saved.set(request.school, waiting);
			waitingForLink.delete(request.school);
			return record("confirmDisclosureStepUp", [request], {
				status: "saved" as const,
			});
		},
	};
}
