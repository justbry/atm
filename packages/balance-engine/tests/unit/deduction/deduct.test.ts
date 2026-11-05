// Modified by justbry/atm: tests for the opt-in expiry-first draw order (org.config.deduction_order).
import { describe, expect, test } from "bun:test";
import {
	AllowanceType,
	BillingInterval,
	BillWhen,
	CusProductStatus,
	FeatureType,
	PriceType,
} from "@autumn/shared";
import type {
	CommandOrg,
	WorkerCustomerProduct,
} from "../../../src/balanceEngine.js";
import {
	createSubjectState,
	parseTrackCommand,
	subjectStateToFullSubject,
} from "../../../src/balanceEngine.js";
import { deduct } from "../../../src/deduction/deduct.js";
import {
	createCatalogFor,
	createCustomerEntitlement,
	createCustomerProduct,
	createSubjectFor,
	createTrackCommand,
	entity,
	identity,
	occurredAt,
	org,
} from "../engineFixtures.js";
import {
	balancesAfter,
	createDeductionRequest,
	deductFrom,
} from "./deductionFixtures.js";

describe("deduct", () => {
	test.concurrent("takes from one row and stops at zero under cap", () => {
		const outcome = deductFrom({
			customerEntitlements: [createCustomerEntitlement({ balance: 3 })],
			value: 5,
		});

		expect(outcome).toMatchObject({
			appliedValue: 3,
			remaining: 2,
			rejected: false,
		});
		expect(balancesAfter(outcome)).toEqual([
			["messages_monthly", { balance: 0 }],
		]);
	});

	test.concurrent("refuses the whole value under reject", () => {
		const outcome = deductFrom({
			customerEntitlements: [createCustomerEntitlement({ balance: 3 })],
			value: 5,
			overageBehavior: "reject",
		});

		expect(outcome).toMatchObject({
			appliedValue: 3,
			remaining: 2,
			rejected: true,
			changes: [],
		});
	});

	test.concurrent("drives a row negative under overflow", () => {
		const outcome = deductFrom({
			customerEntitlements: [createCustomerEntitlement({ balance: 3 })],
			value: 5,
			overageBehavior: "overflow",
		});

		expect(outcome).toMatchObject({ appliedValue: 5, remaining: 0 });
		expect(balancesAfter(outcome)).toEqual([
			["messages_monthly", { balance: -2 }],
		]);
	});

	test.concurrent("drains rows in order, included before overage", () => {
		const outcome = deductFrom({
			customerEntitlements: [
				{
					...createCustomerEntitlement({ id: "free", balance: 10 }),
					created_at: occurredAt,
				},
				{
					...createCustomerEntitlement({ id: "paid", balance: 5 }),
					created_at: occurredAt + 1,
					usage_allowed: true,
				},
			],
			value: 30,
		});

		expect(outcome).toMatchObject({ appliedValue: 30, remaining: 0 });
		expect(
			outcome.deltas.map((delta) => [delta.id, delta.balanceDelta]),
		).toEqual([
			["free", -10],
			["paid", -5],
			["paid", -15],
		]);
		expect(balancesAfter(outcome)).toEqual([
			["free", { balance: 0 }],
			["paid", { balance: -15 }],
		]);
	});

	test.concurrent(
		"an unlimited row absorbs everything and siblings stay untouched",
		() => {
			const outcome = deductFrom({
				customerEntitlements: [
					{
						...createCustomerEntitlement({ id: "finite", balance: 10 }),
						created_at: occurredAt,
					},
					{
						...createCustomerEntitlement({ id: "infinite", balance: 0 }),
						created_at: occurredAt + 1,
						unlimited: true,
					},
				],
				value: 30,
			});

			expect(outcome).toMatchObject({ appliedValue: 30, remaining: 0 });
			expect(balancesAfter(outcome)).toEqual([["infinite", { balance: -30 }]]);
		},
	);

	test.concurrent(
		"a refund lifts an overdrawn row to zero, then rows in order up to their grant",
		() => {
			const outcome = deductFrom({
				customerEntitlements: [
					{
						...createCustomerEntitlement({ id: "a", balance: -4 }),
						created_at: occurredAt,
					},
					{
						...createCustomerEntitlement({ id: "b", balance: 998 }),
						created_at: occurredAt + 1,
					},
				],
				value: -10,
			});

			expect(outcome).toMatchObject({
				appliedValue: -10,
				remaining: 0,
				rejected: false,
			});
			expect(
				outcome.deltas.map((delta) => [delta.id, delta.balanceDelta]),
			).toEqual([
				["a", 4],
				["a", 6],
			]);
			expect(balancesAfter(outcome)).toEqual([["a", { balance: 6 }]]);
		},
	);

	test.concurrent(
		"a refund stops at the grant plus the row's adjustment",
		() => {
			const outcome = deductFrom({
				customerEntitlements: [
					{ ...createCustomerEntitlement({ balance: 995 }), adjustment: 10 },
				],
				value: -20,
			});

			expect(outcome).toMatchObject({ appliedValue: -15, remaining: -5 });
			expect(balancesAfter(outcome)).toEqual([
				["messages_monthly", { balance: 1010 }],
			]);
		},
	);

	test.concurrent("overage stops at usage_limit above the grant", () => {
		const state = createSubjectState({
			identity,
			customerProducts: [createCustomerProduct()],
			customerEntitlements: [
				{ ...createCustomerEntitlement({ balance: 10 }), usage_allowed: true },
			],
		});
		const catalog = createCatalogFor({ state });
		for (const entitlement of Object.values(catalog.entitlements)) {
			entitlement.usage_limit = 1005;
		}
		const outcome = deduct({
			fullSubject: subjectStateToFullSubject({ state, catalog }),
			request: createDeductionRequest({
				org,
				overageBehavior: "cap",
				value: 20,
			}),
		});

		expect(outcome).toMatchObject({ appliedValue: 15, remaining: 5 });
		expect(balancesAfter(outcome)).toEqual([
			["messages_monthly", { balance: -5 }],
		]);
	});

	test.concurrent(
		"reverse_deduction_order flips which row drains first",
		() => {
			const customerEntitlements = [
				{
					...createCustomerEntitlement({ id: "resetting", balance: 10 }),
					next_reset_at: occurredAt + 1000,
				},
				createCustomerEntitlement({ id: "lifetime", balance: 10 }),
			];
			const drainedFirst = ({ reverse }: { reverse: boolean }) =>
				deductFrom({
					customerEntitlements,
					value: 5,
					orgConfig: { ...org.config, reverse_deduction_order: reverse },
				}).deltas.map((delta) => delta.id);

			expect(drainedFirst({ reverse: false })).toEqual(["resetting"]);
			expect(drainedFirst({ reverse: true })).toEqual(["lifetime"]);
		},
	);

	describe("deduction_order", () => {
		const drainedFirstUnder = ({
			deductionOrder,
			customerEntitlements,
			rollovers,
		}: {
			deductionOrder?: "expiry" | "engine";
			customerEntitlements: ReturnType<typeof createCustomerEntitlement>[];
			rollovers?: NonNullable<Parameters<typeof deductFrom>[0]["rollovers"]>;
		}) =>
			deductFrom({
				customerEntitlements,
				rollovers,
				value: 5,
				orgConfig: { ...org.config, deduction_order: deductionOrder },
			}).deltas.map((delta) => delta.id);

		const resettingRow = ({
			resetsAt,
			createdAt = occurredAt,
		}: {
			resetsAt: number;
			createdAt?: number;
		}) => ({
			...createCustomerEntitlement({ id: "resetting", balance: 10 }),
			next_reset_at: resetsAt,
			created_at: createdAt,
		});
		const oneOffRow = ({
			expiresAt,
			createdAt = occurredAt,
		}: {
			expiresAt: number | null;
			createdAt?: number;
		}) => ({
			...createCustomerEntitlement({ id: "one_off", balance: 10 }),
			expires_at: expiresAt,
			created_at: createdAt,
		});

		test.concurrent(
			"absent and engine keep the engine's order: the resetting row drains first",
			() => {
				const customerEntitlements = [
					oneOffRow({ expiresAt: occurredAt + 500 }),
					resettingRow({ resetsAt: occurredAt + 1000 }),
				];

				for (const deductionOrder of [undefined, "engine" as const]) {
					expect(
						drainedFirstUnder({ deductionOrder, customerEntitlements }),
					).toEqual(["resetting"]);
				}
			},
		);

		test.concurrent(
			"expiry: a one-off row expiring before the resetting row's reset drains first",
			() => {
				expect(
					drainedFirstUnder({
						deductionOrder: "expiry",
						customerEntitlements: [
							resettingRow({ resetsAt: occurredAt + 1000 }),
							oneOffRow({ expiresAt: occurredAt + 500 }),
						],
					}),
				).toEqual(["one_off"]);
			},
		);

		test.concurrent(
			"expiry: of two resetting rows, the sooner reset drains first even though the engine ranks the older grant first",
			() => {
				const resetting = ({
					id,
					resetsAt,
					createdAt,
				}: {
					id: string;
					resetsAt: number;
					createdAt: number;
				}) => ({
					...createCustomerEntitlement({ id, balance: 10 }),
					next_reset_at: resetsAt,
					created_at: createdAt,
				});
				const customerEntitlements = [
					resetting({
						id: "older_later_reset",
						resetsAt: occurredAt + 1000,
						createdAt: occurredAt,
					}),
					resetting({
						id: "newer_sooner_reset",
						resetsAt: occurredAt + 500,
						createdAt: occurredAt + 1,
					}),
				];

				expect(
					drainedFirstUnder({
						deductionOrder: "engine",
						customerEntitlements,
					}),
				).toEqual(["older_later_reset"]);
				expect(
					drainedFirstUnder({
						deductionOrder: "expiry",
						customerEntitlements,
					}),
				).toEqual(["newer_sooner_reset"]);
			},
		);

		test.concurrent(
			"expiry: equal lapse times drain the oldest grant first",
			() => {
				expect(
					drainedFirstUnder({
						deductionOrder: "expiry",
						customerEntitlements: [
							resettingRow({
								resetsAt: occurredAt + 500,
								createdAt: occurredAt + 2,
							}),
							oneOffRow({
								expiresAt: occurredAt + 500,
								createdAt: occurredAt + 1,
							}),
						],
					}),
				).toEqual(["one_off"]);
			},
		);

		test.concurrent("expiry: a row that never lapses drains last", () => {
			expect(
				drainedFirstUnder({
					deductionOrder: "expiry",
					customerEntitlements: [
						oneOffRow({ expiresAt: null, createdAt: occurredAt }),
						resettingRow({
							resetsAt: occurredAt + 5000,
							createdAt: occurredAt + 1,
						}),
					],
				}),
			).toEqual(["resetting"]);
		});

		test.concurrent("expiry: an unlimited row still comes first", () => {
			expect(
				drainedFirstUnder({
					deductionOrder: "expiry",
					customerEntitlements: [
						oneOffRow({ expiresAt: occurredAt + 500 }),
						{
							...createCustomerEntitlement({ id: "infinite", balance: 0 }),
							unlimited: true,
							created_at: occurredAt + 9,
						},
					],
				}),
			).toEqual(["infinite"]);
		});

		test.concurrent(
			"expiry: rollovers still drain before included rows",
			() => {
				const drained = drainedFirstUnder({
					deductionOrder: "expiry",
					customerEntitlements: [
						oneOffRow({ expiresAt: occurredAt + 500 }),
						resettingRow({ resetsAt: occurredAt + 1000 }),
					],
					rollovers: [
						{
							id: "rollover_1",
							cus_ent_id: "resetting",
							balance: 10,
							usage: 0,
							expires_at: occurredAt + 9000,
						},
					],
				});

				expect(drained).toEqual(["rollover_1"]);
			},
		);

		/** The same drain as `drainedFirstUnder`, over a catalog the test shapes and an optional entity in play. */
		const drainedFirstOverCatalog = ({
			customerEntitlements,
			shapeCatalog,
			underEntity = false,
		}: {
			customerEntitlements: ReturnType<typeof createCustomerEntitlement>[];
			shapeCatalog: (catalog: ReturnType<typeof createCatalogFor>) => void;
			underEntity?: boolean;
		}) => {
			const state = createSubjectState({
				identity: underEntity ? { ...identity, entityId: entity.id } : identity,
				customerProducts: [createCustomerProduct()],
				customerEntitlements,
				entity: underEntity ? entity : null,
			});
			const catalog = createCatalogFor({ state });
			shapeCatalog(catalog);
			return deduct({
				fullSubject: subjectStateToFullSubject({
					state,
					catalog,
					entityId: underEntity ? entity.id : null,
				}),
				request: createDeductionRequest({
					org: { config: { ...org.config, deduction_order: "expiry" } },
					value: 5,
				}),
			}).deltas.map((delta) => delta.id);
		};
		const doNotShapeCatalog = () => {};

		test.concurrent(
			"expiry: never moves an entity-level row past a customer-level one",
			() => {
				// Tracking under an entity, the engine draws entity-level rows first; the customer-level row lapses sooner.
				expect(
					drainedFirstOverCatalog({
						underEntity: true,
						shapeCatalog: doNotShapeCatalog,
						customerEntitlements: [
							{
								...resettingRow({ resetsAt: occurredAt + 500 }),
								id: "customer_level",
							},
							{
								...resettingRow({ resetsAt: occurredAt + 1000 }),
								id: "entity_level",
								internal_entity_id: entity.internal_id,
							},
						],
					}),
				).toEqual(["entity_level"]);
			},
		);

		test.concurrent(
			"expiry: never moves a credit-system row past a direct feature row",
			() => {
				// The engine draws the feature's own rows before the credit system's; the credit row lapses sooner.
				expect(
					drainedFirstOverCatalog({
						shapeCatalog: (catalog) => {
							const credits = catalog.features.feat_credits;
							if (!credits) throw new Error("credits feature row missing");
							credits.type = FeatureType.CreditSystem;
							credits.config = {
								schema: [
									{
										metered_feature_id: "messages",
										feature_amount: 1,
										credit_amount: 1,
									},
								],
							};
						},
						customerEntitlements: [
							{
								...createCustomerEntitlement({
									id: "credit_row",
									featureId: "credits",
									balance: 10,
								}),
								next_reset_at: occurredAt + 500,
							},
							{
								...createCustomerEntitlement({ id: "direct_row", balance: 10 }),
								next_reset_at: occurredAt + 1000,
							},
						],
					}),
				).toEqual(["direct_row"]);
			},
		);

		test.concurrent(
			"expiry: never moves a row flagged unlimited past a limited one",
			() => {
				expect(
					drainedFirstOverCatalog({
						shapeCatalog: doNotShapeCatalog,
						customerEntitlements: [
							oneOffRow({ expiresAt: occurredAt + 500 }),
							{
								...createCustomerEntitlement({ id: "flagged", balance: 0 }),
								unlimited: true,
								expires_at: occurredAt + 9000,
							},
						],
					}),
				).toEqual(["flagged"]);
			},
		);

		test.concurrent(
			"expiry: never moves a row with an unlimited allowance past a limited one",
			() => {
				expect(
					drainedFirstOverCatalog({
						shapeCatalog: (catalog) => {
							const entitlement = catalog.entitlements.ent_allowance_unlimited;
							if (!entitlement) throw new Error("entitlement row missing");
							entitlement.allowance_type = AllowanceType.Unlimited;
						},
						customerEntitlements: [
							oneOffRow({ expiresAt: occurredAt + 500 }),
							{
								...createCustomerEntitlement({
									id: "allowance_unlimited",
									balance: 0,
								}),
								expires_at: occurredAt + 9000,
							},
						],
					}),
				).toEqual(["allowance_unlimited"]);
			},
		);

		test.concurrent(
			"expiry: a customerEntitlementFilters.cusEntIds filter leaves only the named rows, ranked by expiry among themselves",
			() => {
				const drained = deductFrom({
					customerEntitlements: [
						{ ...resettingRow({ resetsAt: occurredAt + 100 }), id: "unnamed" },
						{
							...resettingRow({ resetsAt: occurredAt + 1000 }),
							id: "named_late",
						},
						{
							...resettingRow({ resetsAt: occurredAt + 500 }),
							id: "named_soon",
						},
					],
					customerEntitlementFilters: {
						cusEntIds: ["named_late", "named_soon"],
					},
					value: 5,
					orgConfig: { ...org.config, deduction_order: "expiry" },
				}).deltas.map((delta) => delta.id);

				expect(drained).toEqual(["named_soon"]);
			},
		);

		test.concurrent(
			"expiry: a null deduction_order parses and keeps the engine's order",
			() => {
				const command = JSON.parse(JSON.stringify(createTrackCommand()));
				command.org.config.deduction_order = null;
				const parsed = parseTrackCommand({ input: command });

				expect(
					deductFrom({
						customerEntitlements: [
							oneOffRow({ expiresAt: occurredAt + 500 }),
							resettingRow({ resetsAt: occurredAt + 1000 }),
						],
						value: 5,
						orgConfig: parsed.org.config,
					}).deltas.map((delta) => delta.id),
				).toEqual(["resetting"]);
			},
		);

		describe("rollover order", () => {
			const rolloverDrainedFirst = ({
				deductionOrder,
				expiresAt,
			}: {
				deductionOrder: "expiry" | "engine";
				expiresAt: number | null;
			}) =>
				drainedFirstUnder({
					deductionOrder,
					customerEntitlements: [
						oneOffRow({ expiresAt: occurredAt + 500 }),
						resettingRow({ resetsAt: occurredAt + 1000 }),
					],
					// The id order is the reverse of the order the expiry re-rank gives the parents.
					rollovers: [
						{
							id: "rollover_b",
							cus_ent_id: "one_off",
							balance: 10,
							usage: 0,
							expires_at: expiresAt,
						},
						{
							id: "rollover_a",
							cus_ent_id: "resetting",
							balance: 10,
							usage: 0,
							expires_at: expiresAt,
						},
					],
				});

			test.concurrent(
				"rollovers with equal expiry drain by id, whatever order their parent rows take",
				() => {
					for (const deductionOrder of ["engine", "expiry"] as const) {
						expect(
							rolloverDrainedFirst({
								deductionOrder,
								expiresAt: occurredAt + 9000,
							}),
						).toEqual(["rollover_a"]);
					}
				},
			);

			test.concurrent(
				"rollovers that never expire drain by id, whatever order their parent rows take",
				() => {
					for (const deductionOrder of ["engine", "expiry"] as const) {
						expect(
							rolloverDrainedFirst({ deductionOrder, expiresAt: null }),
						).toEqual(["rollover_a"]);
					}
				},
			);
		});
	});

	test.concurrent(
		"past-due products fund a track only when the org says so",
		() => {
			const pastDueProduct: WorkerCustomerProduct = {
				...createCustomerProduct(),
				id: "cp_past_due",
				status: CusProductStatus.PastDue,
			};
			const customerEntitlements = [
				createCustomerEntitlement({ id: "active_row", balance: 10 }),
				{
					...createCustomerEntitlement({ id: "past_due_row", balance: 10 }),
					customer_product_id: "cp_past_due",
				},
			];
			const applied = ({ includePastDue }: { includePastDue: boolean }) =>
				deductFrom({
					customerProducts: [createCustomerProduct(), pastDueProduct],
					customerEntitlements,
					value: 15,
					orgConfig: { ...org.config, include_past_due: includePastDue },
				}).appliedValue;

			expect(applied({ includePastDue: false })).toBe(10);
			expect(applied({ includePastDue: true })).toBe(15);
		},
	);

	test.concurrent(
		"a prepaid grant lifts the refund ceiling by quantity × billing units",
		() => {
			const state = createSubjectState({
				identity,
				customerProducts: [
					{
						...createCustomerProduct(),
						options: [
							{
								feature_id: "messages",
								internal_feature_id: "feat_messages",
								quantity: 3,
							},
						],
					},
				],
				customerPrices: [
					{
						id: "cpr_1",
						internal_customer_id: "cus_internal_1",
						customer_product_id: "cp_1",
						price_id: "price_prepaid",
						created_at: occurredAt,
					},
				],
				customerEntitlements: [createCustomerEntitlement({ balance: 1290 })],
			});
			const catalog = createCatalogFor({ state });
			catalog.prices.price_prepaid = {
				id: "price_prepaid",
				internal_product_id: "prod_internal_pro",
				entitlement_id: "ent_messages_monthly",
				proration_config: null,
				config: {
					type: PriceType.Usage,
					bill_when: BillWhen.InAdvance,
					billing_units: 100,
					internal_feature_id: "feat_messages",
					feature_id: "messages",
					usage_tiers: [],
					interval: BillingInterval.Month,
				},
			};
			const outcome = deduct({
				fullSubject: subjectStateToFullSubject({ state, catalog }),
				request: createDeductionRequest({
					org,
					overageBehavior: "cap",
					value: -20,
				}),
			});

			// grant 1000 + 3 × 100 prepaid = 1300 ceiling
			expect(outcome).toMatchObject({ appliedValue: -10, remaining: -10 });
			expect(balancesAfter(outcome)).toEqual([
				["messages_monthly", { balance: 1300 }],
			]);
		},
	);

	test.concurrent("the product quantity multiplies an unpriced grant", () => {
		const outcome = deductFrom({
			customerProducts: [{ ...createCustomerProduct(), quantity: 2 }],
			customerEntitlements: [createCustomerEntitlement({ balance: 1995 })],
			value: -20,
		});

		expect(outcome).toMatchObject({ appliedValue: -5, remaining: -15 });
		expect(balancesAfter(outcome)).toEqual([
			["messages_monthly", { balance: 2000 }],
		]);
	});

	test.concurrent(
		"a past-due plan funds a track but not a check when the org blocks overdue usage",
		() => {
			const pastDue: WorkerCustomerProduct = {
				...createCustomerProduct(),
				status: CusProductStatus.PastDue,
			};
			const state = createSubjectState({
				identity,
				customerProducts: [pastDue],
				customerEntitlements: [createCustomerEntitlement({ balance: 10 })],
			});
			const blocking: CommandOrg = {
				config: { ...org.config, block_overdue_entitlements: true },
			};
			const run = ({ enforceOverdueBlock }: { enforceOverdueBlock: boolean }) =>
				deduct({
					fullSubject: createSubjectFor({ state }),
					request: createDeductionRequest({
						org: blocking,
						overageBehavior: "cap",
						enforceOverdueBlock,
						value: 5,
					}),
				});

			expect(run({ enforceOverdueBlock: false })).toMatchObject({
				appliedValue: 5,
				rejected: false,
			});
			expect(run({ enforceOverdueBlock: true })).toMatchObject({
				appliedValue: 0,
				rejected: true,
				changes: [],
			});
		},
	);

	test.concurrent(
		"among equal intervals the soonest-expiring row drains first, whatever was created first",
		() => {
			const outcome = deductFrom({
				customerEntitlements: [
					{
						...createCustomerEntitlement({ id: "later", balance: 100 }),
						expires_at: occurredAt + 365 * 86_400_000,
						created_at: occurredAt,
					},
					{
						...createCustomerEntitlement({ id: "sooner", balance: 100 }),
						expires_at: occurredAt + 30 * 86_400_000,
						created_at: occurredAt + 1,
					},
				],
				value: 60,
			});

			expect(balancesAfter(outcome)).toEqual([["sooner", { balance: 40 }]]);
		},
	);

	test.concurrent(
		"a prepaid row drains before a pay-per-use row of the same feature",
		() => {
			const outcome = deductFrom({
				customerEntitlements: [
					{
						...createCustomerEntitlement({ id: "pay_per_use", balance: 5 }),
						usage_allowed: true,
						created_at: occurredAt,
					},
					{
						...createCustomerEntitlement({ id: "prepaid", balance: 5 }),
						created_at: occurredAt + 1,
					},
				],
				value: 7,
			});

			expect(
				outcome.deltas.map((delta) => [delta.id, delta.balanceDelta]),
			).toEqual([
				["prepaid", -5],
				["pay_per_use", -2],
			]);
		},
	);

	test.concurrent("a refund on an untouched grant is a no-op", () => {
		const outcome = deductFrom({
			customerEntitlements: [createCustomerEntitlement({ balance: 1000 })],
			value: -10,
		});

		expect(outcome).toMatchObject({
			appliedValue: 0,
			remaining: -10,
			changes: [],
		});
	});

	test.concurrent("overflow lifts the refund ceiling above the grant", () => {
		const outcome = deductFrom({
			customerEntitlements: [createCustomerEntitlement({ balance: 1000 })],
			value: -50,
			overageBehavior: "overflow",
		});

		expect(outcome).toMatchObject({ appliedValue: -50, remaining: 0 });
		expect(balancesAfter(outcome)).toEqual([
			["messages_monthly", { balance: 1050 }],
		]);
	});

	test.concurrent(
		"a zero grant is a ceiling of its own: a refund stops at the row's adjustment",
		() => {
			const state = createSubjectState({
				identity,
				customerProducts: [createCustomerProduct()],
				customerEntitlements: [
					{ ...createCustomerEntitlement({ balance: -5 }), adjustment: 2 },
				],
			});
			const catalog = createCatalogFor({ state });
			for (const entitlement of Object.values(catalog.entitlements)) {
				entitlement.allowance = 0;
			}
			const outcome = deduct({
				fullSubject: subjectStateToFullSubject({ state, catalog }),
				request: createDeductionRequest({ org, value: -20 }),
			});

			// up to zero first, then to grant 0 + adjustment 2
			expect(outcome).toMatchObject({ appliedValue: -7, remaining: -13 });
			expect(balancesAfter(outcome)).toEqual([
				["messages_monthly", { balance: 2 }],
			]);
		},
	);

	test.concurrent(
		"a usage_limit below the grant is a floor above zero: the overage bucket takes nothing",
		() => {
			const state = createSubjectState({
				identity,
				customerProducts: [createCustomerProduct()],
				customerEntitlements: [
					{
						...createCustomerEntitlement({ balance: 50 }),
						usage_allowed: true,
					},
				],
			});
			const catalog = createCatalogFor({ state });
			for (const entitlement of Object.values(catalog.entitlements)) {
				entitlement.usage_limit = 900;
			}
			const outcome = deduct({
				fullSubject: subjectStateToFullSubject({ state, catalog }),
				request: createDeductionRequest({ org, value: 80 }),
			});

			expect(outcome).toMatchObject({ appliedValue: 50, remaining: 30 });
			expect(balancesAfter(outcome)).toEqual([
				["messages_monthly", { balance: 0 }],
			]);
		},
	);

	test.concurrent(
		"fractional values land exactly, never on float noise",
		() => {
			expect(
				balancesAfter(
					deductFrom({
						customerEntitlements: [createCustomerEntitlement({ balance: 0.3 })],
						value: 0.1,
					}),
				),
			).toEqual([["messages_monthly", { balance: 0.2 }]]);
			expect(
				deductFrom({
					customerEntitlements: [createCustomerEntitlement({ balance: 0.001 })],
					value: 0.001,
					overageBehavior: "reject",
				}),
			).toMatchObject({ rejected: false, remaining: 0 });
		},
	);
});
