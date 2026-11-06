/**
 * S1, the what-ifs: the histories of `simulate-inputs-whatif.test.ts` (a plan switch, a renewal, a quantity raise recorded by a
 * Stripe sandbox) are delivered to the reference handler into a database file, shipped by the command line, and the golden
 * candidates (`upgradeGrant` prorated, full and none, a price and allowance change, a rollover cap) are asked of
 * `atm simulate --inputs` from the database and from the folder. What the command prints must equal the committed
 * `golden/simulate/inputs-*.json` for every field the command's JSON keeps (it leaves out the balances and the deliveries that did not change).
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addUtcMonths } from "../src/billing/grants.js";
import { DEFAULT_POLICY } from "../src/billing/policy.js";
import { lookupKeyOf, tierPriceKey } from "../src/billing/stripe-menu.js";
import type { Menu } from "../src/billing/types.js";
import type { AtmEnv, BillingPolicy } from "../src/types.js";
import {
	RECORDED_SCHOOL,
	recordedMenu,
	recordedPriceIds,
} from "./e2e-recorded.js";
import { type RunOptions, step } from "./golden-e2e-cases.js";
import {
	createWalDatabase,
	firstDifference,
	makeWorld,
	Outcomes,
	type World,
} from "./golden-e2e-lib.js";
import {
	FAMILY,
	HOUR,
	harness,
	menu,
	paid,
	SCHOOL,
	T0,
	T1,
} from "./handler-harness.js";
import { deliverWithRetries, scenarioEvents } from "./simulate-inputs-world.js";
import { invoicePaid, type RawEvent } from "./stripe-events.js";

const GOLDEN = join(import.meta.dir, "golden/simulate");
const DAY = 24 * HOUR;
const METADATA = { b4u_school: SCHOOL, family_id: FAMILY };

const monthlyPrice = (tierId: string): number =>
	menu.tiers
		.find((tier) => tier.id === tierId)
		?.prices.find((price) => price.interval === "month")?.amount as number;

const tierLine = (tierId: string, over: Record<string, unknown> = {}) => ({
	lookupKey: lookupKeyOf(
		SCHOOL,
		tierPriceKey(tierId, "month"),
		monthlyPrice(tierId),
		menu.currency,
	),
	amount: monthlyPrice(tierId),
	interval: "month" as const,
	...over,
});

const withTier = (
	base: Menu,
	tierId: string,
	change: (tier: Menu["tiers"][number]) => Menu["tiers"][number],
): Menu => ({
	...base,
	tiers: base.tiers.map((tier) => (tier.id === tierId ? change(tier) : tier)),
});

type History = {
	name: string;
	school: string;
	env: AtmEnv;
	build: (raw: Database) => void;
};

/** sparkle-2 on 2026-01-15, then on 2026-02-05 the switch to sparkle-4 with the unused part credited (proration lines). */
const planSwitch: History = {
	name: "plan switch",
	school: SCHOOL,
	env: "live",
	build: (raw) => {
		const h = harness(undefined, { raw });
		h.deliver(paid());
		const at = T0 + 21 * DAY;
		const span = T1 - T0;
		const left = T1 - at;
		h.deliver(
			invoicePaid({
				eventId: "evt_up",
				invoiceId: "in_up",
				at,
				subscriptionId: "sub_1",
				reason: "subscription_update",
				periodStart: at,
				periodEnd: T1,
				lines: [
					tierLine("sparkle-2", {
						amount: -Math.floor((monthlyPrice("sparkle-2") * left) / span),
						proration: true,
					}),
					tierLine("sparkle-4", {
						amount: Math.floor((monthlyPrice("sparkle-4") * left) / span),
						proration: true,
					}),
				],
				metadata: METADATA,
			}),
			at,
		);
	},
};

/** sparkle-2 on 2026-01-15, renewed on 2026-02-15. */
const renewal: History = {
	name: "renewal",
	school: SCHOOL,
	env: "live",
	build: (raw) => {
		const h = harness(undefined, { raw });
		h.deliver(paid());
		const cycle: RawEvent = invoicePaid({
			eventId: "evt_cycle",
			invoiceId: "in_cycle",
			at: T1,
			subscriptionId: "sub_1",
			reason: "subscription_cycle",
			periodStart: T1,
			periodEnd: addUtcMonths(T1, 1),
			lines: [tierLine("sparkle-2")],
			metadata: METADATA,
		});
		h.deliver(cycle, T1);
	},
};

/** The recorded sandbox scenario yearly-raise: 2 units to 4 units on a yearly plan. */
const yearlyRaise: History = {
	name: "yearly raise (recorded)",
	school: RECORDED_SCHOOL,
	env: "test",
	build: (raw) => {
		const h = harness(undefined, {
			school: RECORDED_SCHOOL,
			menu: recordedMenu,
			env: "test",
			priceIds: recordedPriceIds(),
			raw,
		});
		deliverWithRetries(h, scenarioEvents("yearly-raise"));
	},
};

const policyOf = (over: Partial<BillingPolicy>): BillingPolicy => ({
	...DEFAULT_POLICY,
	...over,
});

type WhatIf = {
	golden: string;
	history: History;
	label: string;
	candidate: { policy?: BillingPolicy; menu?: Menu };
};

const WHAT_IFS: WhatIf[] = [
	{
		golden: "inputs-upgrade-prorated.json",
		history: planSwitch,
		label: "upgradeGrant prorated",
		candidate: { policy: policyOf({ upgradeGrant: "prorated" }) },
	},
	{
		golden: "inputs-upgrade-full.json",
		history: planSwitch,
		label: "upgradeGrant full",
		candidate: { policy: policyOf({ upgradeGrant: "full" }) },
	},
	{
		golden: "inputs-upgrade-none.json",
		history: planSwitch,
		label: "upgradeGrant none",
		candidate: { policy: policyOf({ upgradeGrant: "none" }) },
	},
	{
		golden: "inputs-renewal-allowance-price.json",
		history: renewal,
		label: "allowance 3 and a price of $270.00",
		candidate: {
			menu: withTier(menu, "sparkle-2", (tier) => ({
				...tier,
				prices: tier.prices.map((price) =>
					price.interval === "month" ? { ...price, amount: 27_000 } : price,
				),
				grants: tier.grants.map((grant) => ({ ...grant, amount: 3 })),
			})),
		},
	},
	{
		golden: "inputs-renewal-rollover.json",
		history: renewal,
		label: "rollover at most 1",
		candidate: {
			menu: withTier(menu, "sparkle-2", (tier) => ({
				...tier,
				grants: tier.grants.map((grant) => ({
					...grant,
					rollover: { max: 1, months: 1 },
				})),
			})),
		},
	},
	{
		golden: "inputs-raise-full.json",
		history: yearlyRaise,
		label: "upgradeGrant full on the recorded raise",
		candidate: { policy: policyOf({ upgradeGrant: "full" }) },
	},
	{
		golden: "inputs-raise-none.json",
		history: yearlyRaise,
		label: "upgradeGrant none on the recorded raise",
		candidate: { policy: policyOf({ upgradeGrant: "none" }) },
	},
	{
		golden: "inputs-raise-allowance.json",
		history: yearlyRaise,
		label: "allowance 2 a unit and dearer prices on the recorded raise",
		candidate: {
			menu: withTier(recordedMenu, "sparkle", (tier) => ({
				...tier,
				prices: tier.prices.map((price) => ({
					...price,
					amount: price.amount + 100_000,
				})),
				grants: tier.grants.map((grant) => ({ ...grant, amount: 2 })),
			})),
		},
	},
];

type Golden = Record<string, unknown> & { deliveries: { kind: string }[] };

const buildHistory = async (history: History, world: World) => {
	const file = world.databaseFor(history.school);
	createWalDatabase(file);
	const raw = new Database(file);
	history.build(raw);
	raw.close();
};

export const checkWhatIfs = async (options: RunOptions): Promise<Outcomes> => {
	const rec = new Outcomes("what-if goldens");
	for (const history of [planSwitch, renewal, yearlyRaise]) {
		const world = await makeWorld(`whatif-${history.school}`);
		try {
			await buildHistory(history, world);
			const database = world.databaseFor(history.school);
			step(
				rec,
				`${history.name}: inputs ship`,
				[
					"inputs",
					"ship",
					"--db",
					database,
					"--school",
					history.school,
					"--env",
					history.env,
					"--root",
					world.root,
				],
				options,
			);
			step(
				rec,
				`${history.name}: ship`,
				[
					"ship",
					"--db",
					database,
					"--root",
					world.root,
					"--school",
					history.school,
				],
				options,
			);
			for (const [index, what] of WHAT_IFS.entries()) {
				if (what.history !== history) continue;
				const args: string[] = [];
				if (what.candidate.policy) {
					const file = join(world.dir, `policy-${index}.json`);
					await writeFile(file, JSON.stringify(what.candidate.policy));
					args.push("--policy", file);
				}
				if (what.candidate.menu) {
					const file = join(world.dir, `menu-${index}.json`);
					await writeFile(file, JSON.stringify(what.candidate.menu));
					args.push("--menu", file);
				}
				const ask = (source: string) =>
					step(
						rec,
						`${what.label} (${source === database ? "db" : "folder"})`,
						[
							"simulate",
							"--root",
							world.root,
							"--school",
							history.school,
							"--inputs",
							source,
							"--env",
							history.env,
							"--json",
							...args,
						],
						options,
						[0, 1],
					);
				const fromDatabase = ask(database);
				const fromFolder = ask(world.root);
				rec.expect(
					`${what.label}: database and folder print the same`,
					fromDatabase.stdout === fromFolder.stdout,
					() => firstDifference(fromDatabase.stdout, fromFolder.stdout),
				);
				const printed = JSON.parse(fromDatabase.stdout) as Record<
					string,
					unknown
				>;
				const golden = JSON.parse(
					readFileSync(join(GOLDEN, what.golden), "utf8"),
				) as Golden;
				const mismatched: string[] = [];
				for (const key of Object.keys(printed)) {
					if (key === "ok" || key === "school" || key === "env") continue;
					const want =
						key === "deliveries"
							? golden.deliveries.filter((delivery) => delivery.kind !== "same")
							: golden[key];
					if (JSON.stringify(printed[key]) !== JSON.stringify(want))
						mismatched.push(key);
				}
				rec.expect(
					`${what.label}: equals golden ${what.golden} (${Object.keys(printed).length - 3} fields)`,
					mismatched.length === 0,
					() => `fields differ: ${mismatched.join(", ")}`,
				);
				rec.expect(
					`${what.label}: exit code says whether anything changed`,
					fromDatabase.code === ((golden.differences as number) > 0 ? 1 : 0),
					() =>
						`exit ${fromDatabase.code}, golden differences ${golden.differences}`,
				);
			}
		} finally {
			await world.dispose();
		}
	}
	return rec;
};
