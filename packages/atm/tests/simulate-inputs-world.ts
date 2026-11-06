/**
 * Shared by the tests of `simulateFromInputs`: histories delivered through the real handler (`tests/handler-harness.ts`)
 * into SQLite, the log that the outbox makes, and the replay of both.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sqliteInputsSource } from "../src/handler/inputs.js";
import { replayInputs } from "../src/ledger/simulate-inputs.js";
import type { AtmEnv, AtmEvent, InputsRead } from "../src/types.js";
import {
	RECORDED_SCHOOL,
	recordedMenu,
	recordedPriceIds,
} from "./e2e-recorded.js";
import { harness } from "./handler-harness.js";
import type { RawEvent } from "./stripe-events.js";

export const DELIVERED_DIR = join(
	import.meta.dir,
	"../fixtures/billing/stripe/recorded/delivered",
);

export const SCENARIOS = readdirSync(DELIVERED_DIR, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.sort();

export const scenarioEvents = (scenario: string): RawEvent[] =>
	readdirSync(join(DELIVERED_DIR, scenario))
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) =>
			JSON.parse(readFileSync(join(DELIVERED_DIR, scenario, name), "utf8")),
		);

export type Harness = ReturnType<typeof harness>;

/** The handler for the recorded sandbox deliveries: school `spike-school`, env `test`, their menu and price ids. */
export const recordedHarness = (): Harness =>
	harness(undefined, {
		school: RECORDED_SCHOOL,
		menu: recordedMenu,
		env: "test",
		priceIds: recordedPriceIds(),
	});

const MAX_PASSES = 6;

/** Delivers in order, then retries the 409s as Stripe does until none is left. Returns the answers that ended each event. */
export const deliverWithRetries = (
	h: Harness,
	events: readonly RawEvent[],
	at: (event: RawEvent) => number = (event) => event.created * 1000,
): { status: number; id: string }[] => {
	let pending = [...events];
	const final: { status: number; id: string }[] = [];
	for (let pass = 0; pass < MAX_PASSES && pending.length > 0; pass += 1) {
		const retry: RawEvent[] = [];
		for (const event of pending) {
			const response = h.deliver(event, at(event));
			if (response.status === 409) retry.push(event);
			else final.push({ status: response.status, id: event.id });
		}
		pending = retry;
	}
	return final;
};

/** What the shipper would put in the log: the outbox's events in id order, once per idem. */
export const logOf = (h: Harness): AtmEvent[] => {
	const seen = new Set<string>();
	return h
		.outbox()
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		.filter((event) => {
			if (seen.has(event.idem)) return false;
			seen.add(event.idem);
			return true;
		});
};

export const readStored = async (
	h: Harness,
	env: AtmEnv,
	school: string,
): Promise<InputsRead> => sqliteInputsSource(h.db).read({ env, school });

/** The baseline replay of what the handler stored, set against the outbox. */
export const baselineOf = async (
	h: Harness,
	env: AtmEnv,
	school: string,
	events: readonly AtmEvent[] = logOf(h),
) => {
	const inputs = await readStored(h, env, school);
	const result = replayInputs({
		events,
		inputs,
		env,
		school,
		contextFor: (stored, recorded) => ({
			menu: recorded?.menu as never,
			menuVersion: stored.menuVersion ?? "",
			policy: recorded?.policy as never,
			policyVersion: stored.policyVersion ?? "",
			priceIds: { ...(recorded?.priceIds ?? {}) },
		}),
	});
	return { inputs, result, events };
};
