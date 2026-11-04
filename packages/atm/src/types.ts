/**
 * atm's public types: plain JSON shapes, with no import from the engine, zod or @autumn/shared, so the built
 * library's declarations stand alone. They describe what a caller sends and reads; the engine's own parsers
 * still validate every command at runtime. tests/types.test.ts fails if the engine's types stop fitting them.
 */

export type AtmCommandType =
	| "check"
	| "finalize"
	| "confirmExpiredLock"
	| "reset"
	| "recalculateBalance"
	| "track"
	| "updateBalance"
	| "deleteBalance";

export type AtmIdentity = {
	orgId: string;
	env: string;
	customerId: string;
	entityId: string | null;
};

/** Autumn's WorkerFullSubject: the customer (or entity) with its products, entitlements, pools, windows and open locks. */
export type AtmSubject = {
	identity: AtmIdentity;
	revision: number;
	customer: Record<string, unknown>;
	entity: Record<string, unknown> | null;
	customer_products: Record<string, unknown>[];
	extra_customer_entitlements: Record<string, unknown>[];
	pooled_customer_entitlements: Record<string, unknown>[];
	usage_windows: Record<string, unknown>[];
	open_locks: Record<string, unknown>[];
};

/** Fields every engine command carries; each type adds its own (see the engine's parsers). */
export type AtmCommand = {
	schemaVersion: 1;
	type: AtmCommandType;
	requestId: string;
	identity: AtmIdentity;
	occurredAt: number;
	/** Required on commands that change balances; duplicates are dropped on it. */
	commandId?: string;
	[field: string]: unknown;
};

export type AtmCheckResult = {
	allowed: boolean;
	reason: string | null;
	limitType: string | null;
	requiredBalance: number;
	fundingFeatureId: string | null;
	isFlag: boolean;
};

export type AtmRowChange = {
	table: string;
	op: string;
	[field: string]: unknown;
};

/** What a command that changes balances returns: row changes guarded by the subject's revision. */
export type AtmMutation = {
	schemaVersion: 1;
	type: "mutation";
	id: string;
	identity: AtmIdentity;
	revision: { before: number; after: number };
	changes: AtmRowChange[];
	[field: string]: unknown;
};

export type AtmResultFor<T extends AtmCommandType> = T extends "check"
	? AtmCheckResult
	: T extends "reset" | "updateBalance"
		? AtmMutation | null
		: T extends "recalculateBalance"
			? Record<string, unknown>
			: AtmMutation;

export type AtmResult = AtmResultFor<AtmCommandType>;
