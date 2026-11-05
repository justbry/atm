// Modified by justbry/atm: opt-in expiry-first draw order (org.config.deduction_order).
import { OrgConfigSchema } from "@autumn/shared";
import { z } from "zod/v4";
import { openSchema } from "../common/openSchema.js";
import { nonEmptyStringSchema } from "../common/primitives.js";

/**
 * The org as the log's readers need it, sent by the server with every command. Ids and settings only:
 * the log is kept, replayed and read by every consumer, so nothing secret ever goes on it.
 */
export const commandOrgSchema = openSchema({
	name: "commandOrg",
	schema: z.object({
		/** Absent on records logged before they existed. */
		id: nonEmptyStringSchema.optional(),
		slug: nonEmptyStringSchema.optional(),
		config: OrgConfigSchema.pick({
			reverse_deduction_order: true,
			block_overdue_entitlements: true,
			include_past_due: true,
			usage_alerts: true,
			sandbox_usage_alerts: true,
			persist_free_overage: true,
		})
			.partial({
				usage_alerts: true,
				sandbox_usage_alerts: true,
				persist_free_overage: true,
			})
			.extend({
				/** "expiry": among peer included rows, soonest-lapsing first. Absent and "engine" keep the engine's order. */
				deduction_order: z.enum(["expiry", "engine"]).optional(),
			})
			.loose(),
		/** The Svix apps the org's webhooks deliver through, one per env; absent where none is set up. */
		svix: z
			.object({
				sandbox_app_id: nonEmptyStringSchema.nullable(),
				live_app_id: nonEmptyStringSchema.nullable(),
			})
			.loose()
			.optional(),
	}),
});

export type CommandOrg = z.infer<typeof commandOrgSchema>;
