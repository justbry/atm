import { Ajv2020 } from "ajv/dist/2020.js";
import policySchema from "../../schema/catalog/policy.v1.json";
import type { BillingPolicy } from "./types.js";

/** The defaults from the tiers spec, "Default billing rules" (owner 2026-11-04). */
export const DEFAULT_POLICY: BillingPolicy = {
	v: 1,
	upgradeGrant: "prorated",
	removeOnFullRefund: true,
	removeOnLostDispute: true,
	giftSessionMonths: 6,
	giftDollarMinimum: 2500,
	giftDollarMonths: 12,
	memberCode: { code: "MEMBER15", percentOff: 15 },
	deductionOrder: "expiry",
};

/**
 * The `org` a `track` or `check` command carries: the engine reads its deduction settings from it, per command. The
 * policy's `deductionOrder` is the only setting that varies; the others are the family service's fixed choices.
 */
export const commandOrg = (policy: BillingPolicy) => ({
	config: {
		reverse_deduction_order: false,
		block_overdue_entitlements: false,
		include_past_due: true,
		// A policy read back from an event published before the field existed has none: that is the default.
		deduction_order: policy.deductionOrder ?? DEFAULT_POLICY.deductionOrder,
	},
});

let validate: ReturnType<Ajv2020["compile"]> | null = null;

/**
 * A school's `catalog/policy.json` over the defaults. `overrides` is null/undefined (all defaults) or an object
 * naming only what it changes; an unknown key or a wrong value throws, naming each problem.
 */
export const resolvePolicy = (overrides: unknown): BillingPolicy => {
	if (overrides === null || overrides === undefined)
		return structuredClone(DEFAULT_POLICY);
	validate ??= new Ajv2020({ allErrors: true, strict: false }).compile(
		policySchema,
	);
	if (!validate(overrides)) {
		const why = (validate.errors ?? [])
			.map((e) => {
				const where = e.instancePath || "policy";
				const extra =
					e.keyword === "additionalProperties"
						? ` (${String((e.params as { additionalProperty: string }).additionalProperty)})`
						: "";
				return `${where} ${e.message ?? "is invalid"}${extra}`;
			})
			.join("; ");
		throw new Error(`policy is invalid: ${why}`);
	}
	return structuredClone({
		...DEFAULT_POLICY,
		...(overrides as Partial<BillingPolicy>),
		v: 1,
	});
};
