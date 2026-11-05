// Modified by justbry/atm: opt-in expiry-first draw order (org.config.deduction_order).
// Expiry wins over reverse: with `deduction_order: "expiry"` and `reverse_deduction_order` both set, the re-rank
// inside each run ignores `selection.reverseOrder`, so the reversed tiers inside a run are lost (the reverse
// still decides which run comes first). atm's commandOrg always sends reverse false.
import {
	AllowanceType,
	CusProductStatus,
	FeatureType,
	fullSubjectToCustomerEntitlements,
	isEntityCusEnt,
	isThresholdBillingCustomerProduct,
	isUnlimitedCustomerEntitlement,
} from "@autumn/shared";
import type { WorkerRollover } from "../../models/subject/rows/workerRollover.js";
import type {
	WorkerFullCustomerEntitlementWithProduct,
	WorkerFullCustomerProduct,
	WorkerFullSubject,
} from "../../models/subject/workerFullSubject.js";
import type { DeductionSelection } from "../types/deductionRequest.js";

/** The sort prefers unlimited only within a tier; the sink contract needs it first outright. */
const hoistUnlimited = ({
	customerEntitlements,
}: {
	customerEntitlements: WorkerFullCustomerEntitlementWithProduct[];
}): WorkerFullCustomerEntitlementWithProduct[] => {
	const unlimited = customerEntitlements.find((customerEntitlement) =>
		isUnlimitedCustomerEntitlement({ customerEntitlement }),
	);
	if (!unlimited) return customerEntitlements;
	return [
		unlimited,
		...customerEntitlements.filter((candidate) => candidate !== unlimited),
	];
};

/** When the row's unused balance is lost or rolled over: a refilling row's at its next reset, a one-off grant's at its expiry. A row with neither never lapses. */
const lapsesAtOf = ({
	customerEntitlement,
}: {
	customerEntitlement: WorkerFullCustomerEntitlementWithProduct;
}): number =>
	Math.min(
		customerEntitlement.expires_at ?? Number.POSITIVE_INFINITY,
		customerEntitlement.next_reset_at ?? Number.POSITIVE_INFINITY,
	);

/** Rows that share this key were ordered by the engine's earlier criteria as peers; expiry-first never moves a row across it. */
const drawGroupKeyOf = ({
	customerEntitlement,
	selection,
}: {
	customerEntitlement: WorkerFullCustomerEntitlementWithProduct;
	selection: DeductionSelection;
}): string => {
	const idsFilter =
		selection.customerEntitlementFilters?.cusEntIds &&
		selection.customerEntitlementFilters.cusEntIds.length > 0
			? selection.customerEntitlementFilters.cusEntIds
			: null;
	const { feature, allowance_type: allowanceType } =
		customerEntitlement.entitlement;
	return JSON.stringify([
		idsFilter?.includes(customerEntitlement.id) ?? false,
		isEntityCusEnt({ cusEnt: customerEntitlement }),
		feature.type === FeatureType.Boolean,
		feature.type === FeatureType.CreditSystem,
		allowanceType === AllowanceType.Unlimited,
		Boolean(customerEntitlement.unlimited),
	]);
};

/**
 * Opt-in `deduction_order: "expiry"`: within each maximal run of rows the engine's order already ranks as peers
 * (same filter hit, entity level, boolean, credit system, unlimited), soonest-lapsing first, then oldest grant.
 * A tuple key, not a patched comparator: the original index closes every tie, so the order is total.
 */
const rankByExpiry = ({
	customerEntitlements,
	selection,
}: {
	customerEntitlements: WorkerFullCustomerEntitlementWithProduct[];
	selection: DeductionSelection;
}): WorkerFullCustomerEntitlementWithProduct[] => {
	const ranked: WorkerFullCustomerEntitlementWithProduct[] = [];
	let runStart = 0;
	while (runStart < customerEntitlements.length) {
		const runKey = drawGroupKeyOf({
			customerEntitlement: customerEntitlements[runStart],
			selection,
		});
		let runEnd = runStart + 1;
		while (
			runEnd < customerEntitlements.length &&
			drawGroupKeyOf({
				customerEntitlement: customerEntitlements[runEnd],
				selection,
			}) === runKey
		) {
			runEnd += 1;
		}
		const keyed = customerEntitlements
			.slice(runStart, runEnd)
			.map((customerEntitlement, index) => ({
				customerEntitlement,
				lapsesAt: lapsesAtOf({ customerEntitlement }),
				index,
			}));
		keyed.sort((left, right) => {
			if (left.lapsesAt !== right.lapsesAt) {
				return left.lapsesAt < right.lapsesAt ? -1 : 1;
			}
			const leftCreatedAt = left.customerEntitlement.created_at;
			const rightCreatedAt = right.customerEntitlement.created_at;
			if (leftCreatedAt !== rightCreatedAt) {
				return leftCreatedAt - rightCreatedAt;
			}
			return left.index - right.index;
		});
		for (const { customerEntitlement } of keyed) {
			ranked.push(customerEntitlement);
		}
		runStart = runEnd;
	}
	return ranked;
};

/** Soonest-expiring first; rollovers without an expiry drain last. Ties fall to the rollover id, so the order never depends on the order of the parent rows (which the expiry re-rank changes). */
const byExpiresAt = (left: WorkerRollover, right: WorkerRollover): number => {
	const leftExpiresAt = left.expires_at ?? Number.POSITIVE_INFINITY;
	const rightExpiresAt = right.expires_at ?? Number.POSITIVE_INFINITY;
	if (leftExpiresAt !== rightExpiresAt) {
		return leftExpiresAt < rightExpiresAt ? -1 : 1;
	}
	if (left.id === right.id) return 0;
	return left.id < right.id ? -1 : 1;
};

/** `getCheckSubject`: a past-due product stops funding when the selection blocks overdue usage, or when it bills by threshold. */
const isOverdueBlocked = ({
	customerProduct,
	selection,
}: {
	customerProduct: WorkerFullCustomerProduct;
	selection: DeductionSelection;
}): boolean =>
	customerProduct.status === CusProductStatus.PastDue &&
	!customerProduct.product.config?.ignore_past_due &&
	(selection.blocksOverdue ||
		isThresholdBillingCustomerProduct({ customerProduct }));

/** Which rows the selection draws from, in draw order, and their rollovers: the same selection and sort the Lua path uses. */
export const selectDeductionRows = ({
	fullSubject,
	selection,
}: {
	fullSubject: WorkerFullSubject;
	selection: DeductionSelection;
}): {
	customerEntitlements: WorkerFullCustomerEntitlementWithProduct[];
	rollovers: WorkerRollover[];
	overdueBlocked: boolean;
} => {
	const blockedProducts = fullSubject.customer_products.filter(
		(customerProduct) => isOverdueBlocked({ customerProduct, selection }),
	);
	// Only a blocked product calls for a narrowed copy; the view itself keeps the rows it has already flattened.
	const fundingSubject =
		blockedProducts.length === 0
			? fullSubject
			: {
					...fullSubject,
					customer_products: fullSubject.customer_products.filter(
						(customerProduct) => !blockedProducts.includes(customerProduct),
					),
				};
	const sortedCustomerEntitlements = hoistUnlimited({
		customerEntitlements: fullSubjectToCustomerEntitlements({
			fullSubject: fundingSubject,
			...(selection.includesCreditSystems
				? { fundsFeatureId: selection.featureId }
				: { featureIds: [selection.featureId] }),
			customerEntitlementFilters: selection.customerEntitlementFilters,
			inStatuses: selection.inStatuses,
			reverseOrder: selection.reverseOrder,
			now: selection.now,
		}),
	});
	const customerEntitlements = selection.expiryFirst
		? rankByExpiry({
				customerEntitlements: sortedCustomerEntitlements,
				selection,
			})
		: sortedCustomerEntitlements;
	// State outlives a rollover's expiry; the hydration query drops these, the draw must too.
	const rollovers = customerEntitlements
		.flatMap((customerEntitlement) => customerEntitlement.rollovers)
		.filter(
			(rollover) =>
				rollover.expires_at === null || rollover.expires_at > selection.now,
		)
		.sort(byExpiresAt);
	const overdueBlocked = blockedProducts.some((customerProduct) =>
		customerProduct.customer_entitlements.some(
			(customerEntitlement) =>
				customerEntitlement.entitlement.feature.id === selection.featureId,
		),
	);
	return { customerEntitlements, rollovers, overdueBlocked };
};
