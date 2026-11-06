/**
 * The shipped folder and the handler's database give the same answer: all 8 recorded scenarios, the identity and four
 * candidates, compared field by field (no refused row is shipped, and none of these scenarios stores one).
 */
import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import { folderInputsSource, shipInputs } from "../src/ledger/ship-inputs.js";
import { simulateFromInputs } from "../src/ledger/simulate-inputs.js";
import { FolderStore } from "../src/store/folder-store.js";
import { RECORDED_SCHOOL, recordedMenu } from "./e2e-recorded.js";
import { tmp } from "./helpers.js";
import {
	deliverWithRetries,
	logOf,
	readStored,
	recordedHarness,
	SCENARIOS,
	scenarioEvents,
} from "./simulate-inputs-world.js";

const candidates = [
	{},
	{ policy: { ...DEFAULT_POLICY, upgradeGrant: "full" as const } },
	{ policy: { ...DEFAULT_POLICY, upgradeGrant: "none" as const } },
	{
		policy: {
			...DEFAULT_POLICY,
			removeOnFullRefund: false,
			removeOnLostDispute: false,
		},
	},
	{
		menu: {
			...recordedMenu,
			tiers: recordedMenu.tiers.map((t) => ({
				...t,
				grants: t.grants.map((g) => ({ ...g, amount: g.amount + 1 })),
			})),
		},
	},
];

test.each(SCENARIOS)(
	"%s: folder == sqlite for every candidate",
	async (scenario) => {
		const h = recordedHarness();
		deliverWithRetries(h, scenarioEvents(scenario));
		const events = logOf(h);
		const sql = await readStored(h, "test", RECORDED_SCHOOL);
		const dir = await tmp("rev97-folder");
		await mkdir(dir, { recursive: true });
		await shipInputs({
			db: h.db,
			store: new FolderStore({ root: dir }),
			school: RECORDED_SCHOOL,
			env: "test",
			nowMs: () => 1_800_000_000_000,
		});
		const fol = await folderInputsSource(dir).read({
			env: "test",
			school: RECORDED_SCHOOL,
		});
		for (const candidate of candidates) {
			const a = simulateFromInputs({
				events,
				inputs: sql,
				env: "test",
				school: RECORDED_SCHOOL,
				candidate: candidate as never,
			});
			const b = simulateFromInputs({
				events,
				inputs: fol,
				env: "test",
				school: RECORDED_SCHOOL,
				candidate: candidate as never,
			});
			const strip = (s: typeof a) => {
				const { summary: _s, events: _e, ...rest } = s;
				return JSON.parse(JSON.stringify(rest));
			};
			expect(strip(b)).toEqual(strip(a));
		}
	},
);
