/**
 * Publishes Trifold's two menus (`catalog/trifold`) to Stripe TEST mode with tfd's `menuToStripe`, then writes
 * `src/published-plans.json`: per school id, the validated menu, the resolved policy, a menu version, the Stripe
 * product and price ids, and the billing portal configuration its portal sessions use (tfd's `portalConfigOf`). The Worker bundles that file, so checkout and the webhook handler read the ids without a
 * Stripe or D1 round trip, a deploy carries a publish, and git shows what was published. Nothing in it is secret.
 *
 *   bun scripts/publish-plans.ts            publish (test mode), write the file
 *   bun scripts/publish-plans.ts --dry-run  print the steps, call nothing
 *
 * Runs Stripe through the Stripe CLI's logged-in session (`stripe get|post`, test mode by default; `--live` is never
 * passed) so no key is read or printed here. Every object Stripe returns must say `livemode: false`, or the run stops.
 * Idempotent: the previous publish is `previous` for `menuToStripe` (a rerun makes no step), products and prices are
 * found again by `b4u_key` and lookup key before any create, and every create carries tfd's idempotency key.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
	checkTrifoldCatalog,
	trifoldLookupKey,
} from "../../../catalog/trifold/check.ts";
import {
	TRIFOLD_ORGS,
	TRIFOLD_SCHOOL_IDS,
	type TrifoldOrg,
} from "../../../catalog/trifold/index.ts";
import {
	menuToStripe,
	portalConfigOf,
	tierPriceKey,
	toStripeForm,
} from "../../../packages/atm/src/billing/stripe-menu.ts";
import type {
	BillingPolicy,
	Interval,
	Menu,
	StripeOp,
} from "../../../packages/atm/src/types.ts";

/** The API version tfd's handler reads (its recorded payloads). */
export const STRIPE_API_VERSION = "2025-10-29.clover";

export type StripeCall = (
	method: "GET" | "POST",
	path: string,
	params: readonly (readonly [string, string])[],
	idempotencyKey?: string,
) => Promise<Record<string, unknown>>;

export type PublishedSchool = {
	org: TrifoldOrg;
	/** sha256 of the menu and policy, first 12 hex: the `menu_version` on each checkout. */
	menuVersion: string;
	menu: Menu;
	policy: BillingPolicy;
	/** Stripe product ids by the menu's key (`t:<tierId>`). */
	products: Record<string, string>;
	/** Stripe price ids by lookup key: what checkout and the handler's `priceIds` take. */
	priceIds: Record<string, string>;
	/** The billing portal configuration (`bpc_…`) of this school's portal sessions. */
	portalConfiguration: string;
};

export type PublishedPlans = {
	stripeAccount: string;
	livemode: false;
	apiVersion: string;
	schools: Record<string, PublishedSchool>;
};

const OUTPUT = join(import.meta.dir, "../src/published-plans.json");

const canonical = (value: unknown): string =>
	JSON.stringify(value, (_key, inner) =>
		inner && typeof inner === "object" && !Array.isArray(inner)
			? Object.fromEntries(
					Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)),
				)
			: inner,
	);

export const menuVersionOf = (menu: Menu, policy: BillingPolicy): string =>
	createHash("sha256")
		.update(canonical({ menu, policy }))
		.digest("hex")
		.slice(0, 12);

/** Refuses any Stripe object that is not test mode, at any depth. */
const assertTestMode = (value: unknown, path: string): void => {
	if (!value || typeof value !== "object") return;
	if ((value as { livemode?: unknown }).livemode === true)
		throw new Error(`Stripe answered a LIVE-mode object for ${path}; stopping`);
	for (const inner of Object.values(value)) assertTestMode(inner, path);
};

const listData = (answer: Record<string, unknown>) =>
	(answer.data ?? []) as Record<string, unknown>[];

const quote = (text: string) => text.replaceAll("'", "\\'");

/** A product `menuToStripe` made, found again by its `b4u_key` and school (Stripe's search lags creates by about a minute). */
const searchProduct = async (
	stripe: StripeCall,
	schoolId: string,
	key: string,
): Promise<string | null> => {
	const answer = await stripe("GET", "/v1/products/search", [
		[
			"query",
			`metadata['b4u_key']:'${quote(key)}' AND metadata['b4u_school']:'${quote(schoolId)}'`,
		],
	]);
	const id = listData(answer)[0]?.id;
	return typeof id === "string" ? id : null;
};

/** Runs `menuToStripe`'s steps for one school; returns its product ids by key. */
type PriceCreate = Extract<StripeOp, { op: "price.create" }>;

/**
 * The form of `POST /v1/prices` for a `price.create` step: `unit_amount`, or for a pay-what-you-can price
 * `custom_unit_amount` with its bounds and no `unit_amount` (Stripe takes one or the other).
 */
export const priceFormOf = (
	op: PriceCreate,
	product: string,
): (readonly [string, string])[] => {
	const custom = op.customUnitAmount;
	const amount: (readonly [string, string])[] = custom
		? [
				["custom_unit_amount[enabled]", "true"],
				["custom_unit_amount[minimum]", String(custom.minimum)],
				["custom_unit_amount[maximum]", String(custom.maximum)],
				...(custom.preset === undefined
					? []
					: [["custom_unit_amount[preset]", String(custom.preset)] as const]),
			]
		: [["unit_amount", String(op.unitAmount)]];
	return [
		["product", product],
		["currency", op.currency],
		...amount,
		["lookup_key", op.lookupKey],
		...(op.recurring
			? [["recurring[interval]", op.recurring.interval] as const]
			: []),
		...Object.entries(op.metadata).map(
			([name, value]) => [`metadata[${name}]`, value] as const,
		),
	];
};

const runOps = async (
	stripe: StripeCall,
	schoolId: string,
	ops: readonly StripeOp[],
	known: Record<string, string>,
): Promise<Record<string, string>> => {
	const products = { ...known };
	const findProduct = async (key: string): Promise<string | null> =>
		products[key] ?? (await searchProduct(stripe, schoolId, key));
	const findPrice = async (lookupKey: string): Promise<string | null> => {
		const answer = await stripe("GET", "/v1/prices", [
			["lookup_keys[]", lookupKey],
		]);
		const id = listData(answer)[0]?.id;
		return typeof id === "string" ? id : null;
	};
	for (const op of ops) {
		switch (op.op) {
			case "product.create": {
				const found = await findProduct(op.key);
				if (found) {
					products[op.key] = found;
					break;
				}
				const created = await stripe(
					"POST",
					"/v1/products",
					[
						["name", op.name],
						...(op.description
							? [["description", op.description] as const]
							: []),
						...Object.entries(op.metadata).map(
							([name, value]) => [`metadata[${name}]`, value] as const,
						),
					],
					op.idempotencyKey,
				);
				products[op.key] = created.id as string;
				break;
			}
			case "product.update": {
				const id = await findProduct(op.key);
				if (!id) throw new Error(`no Stripe product for ${op.key}`);
				await stripe(
					"POST",
					`/v1/products/${id}`,
					[
						["name", op.name],
						...(op.description
							? [["description", op.description] as const]
							: []),
						["active", String(op.active)],
					],
					op.idempotencyKey,
				);
				products[op.key] = id;
				break;
			}
			case "price.create": {
				if (await findPrice(op.lookupKey)) break;
				const product = await findProduct(op.productKey);
				if (!product) throw new Error(`no Stripe product for ${op.productKey}`);
				await stripe(
					"POST",
					"/v1/prices",
					priceFormOf(op, product),
					op.idempotencyKey,
				);
				break;
			}
			case "price.archive": {
				const id = await findPrice(op.lookupKey);
				if (id)
					await stripe(
						"POST",
						`/v1/prices/${id}`,
						[["active", "false"]],
						op.idempotencyKey,
					);
				break;
			}
			default:
				// Trifold's policy has no member code and its menus no codes: a coupon step means the catalog changed.
				throw new Error(`publish-plans does not run ${op.op} steps`);
		}
	}
	return products;
};

/**
 * The portal configuration's form for one school: tfd's `portalConfigOf`, which offers a quantity change only for tiers
 * sold in quantities. Trifold sells none, so it answers null, and the portal is tfd's base without `subscription_update`:
 * invoice history, the payment method, and cancel at the period end (no tier switch, as with `portalConfigOf`). Marked
 * with the school and a version (a hash of the form), so a rerun finds it and changes it only when the form changes.
 */
export const portalFormOf = (input: {
	schoolId: string;
	menu: Menu;
	products: Record<string, string>;
	priceIdOf: (tierId: string, interval: Interval) => string | undefined;
}): Record<string, string> => {
	const prices: Record<string, string> = {};
	for (const tier of input.menu.tiers)
		for (const price of tier.prices) {
			const id = input.priceIdOf(tier.id, price.interval);
			if (id) prices[tierPriceKey(tier.id, price.interval)] = id;
		}
	const form =
		portalConfigOf(input.menu, { products: input.products, prices }) ??
		toStripeForm({
			features: {
				invoice_history: { enabled: true },
				payment_method_update: { enabled: true },
				subscription_cancel: { enabled: true, mode: "at_period_end" },
			},
			metadata: { b4u_key: "portal" },
		});
	const version = createHash("sha256")
		.update(canonical(form))
		.digest("hex")
		.slice(0, 12);
	return {
		...form,
		"metadata[b4u_school]": input.schoolId,
		"metadata[b4u_portal_version]": version,
	};
};

/** Finds the school's portal configuration by its metadata; makes it, or updates it when its version is not the form's. */
const publishPortal = async (
	stripe: StripeCall,
	schoolId: string,
	form: Record<string, string>,
	log: (line: string) => void,
): Promise<string> => {
	const version = form["metadata[b4u_portal_version]"] as string;
	const answer = await stripe("GET", "/v1/billing_portal/configurations", [
		["limit", "100"],
	]);
	const found = listData(answer).find((configuration) => {
		const metadata = (configuration.metadata ?? {}) as Record<string, string>;
		return (
			metadata.b4u_key === "portal" &&
			metadata.b4u_school === schoolId &&
			configuration.active === true
		);
	});
	const current = (found?.metadata as Record<string, string> | undefined)
		?.b4u_portal_version;
	if (found && current === version) return found.id as string;
	log(
		`${schoolId}: portal ${found ? `update ${String(found.id)}` : "create"} (version ${version})`,
	);
	const written = await stripe(
		"POST",
		found
			? `/v1/billing_portal/configurations/${String(found.id)}`
			: "/v1/billing_portal/configurations",
		Object.entries(form),
		`portal:${schoolId}:${version}`,
	);
	if (typeof written.id !== "string")
		throw new Error(
			`Stripe answered no portal configuration id for ${schoolId}`,
		);
	return written.id;
};

export const publishPlans = async (input: {
	stripe: StripeCall;
	previous: PublishedPlans | null;
	stripeAccount: string;
	dryRun?: boolean;
	log?: (line: string) => void;
}): Promise<PublishedPlans> => {
	const log = input.log ?? (() => {});
	const { menus, policy } = checkTrifoldCatalog();
	const stripe: StripeCall = async (method, path, params, key) => {
		const answer = await input.stripe(method, path, params, key);
		assertTestMode(answer, path);
		return answer;
	};
	const schools: Record<string, PublishedSchool> = {};
	for (const org of TRIFOLD_ORGS) {
		const schoolId = TRIFOLD_SCHOOL_IDS[org];
		const menu = menus[org];
		const before = input.previous?.schools[schoolId] ?? null;
		const ops = menuToStripe({
			schoolId,
			menu,
			previous: before?.menu ?? null,
			policy,
			previousPolicy: before?.policy ?? null,
		});
		log(
			`${schoolId}: ${ops.length} step(s)${ops.map((op) => `\n  ${op.op} ${"lookupKey" in op ? op.lookupKey : "key" in op ? op.key : ""}`).join("")}`,
		);
		if (input.dryRun) continue;
		const products = await runOps(
			stripe,
			schoolId,
			ops,
			before?.products ?? {},
		);
		const priceIds: Record<string, string> = {};
		const sold = menu.tiers.filter((tier) => tier.public);
		for (const lookupKey of sold.flatMap((tier) =>
			tier.prices.map((price) =>
				trifoldLookupKey(org, tier.id, price.interval),
			),
		)) {
			const answer = await stripe("GET", "/v1/prices", [
				["lookup_keys[]", lookupKey],
			]);
			const [price] = listData(answer);
			if (typeof price?.id !== "string" || price.active !== true)
				throw new Error(
					`${lookupKey} is not an active Stripe price after publishing`,
				);
			priceIds[lookupKey] = price.id;
		}
		for (const tier of sold) {
			const key = `t:${tier.id}`;
			products[key] ??= (await searchProduct(stripe, schoolId, key)) ?? "";
			if (!products[key])
				throw new Error(`no Stripe product id for ${schoolId} ${key}`);
		}
		const portalConfiguration = await publishPortal(
			stripe,
			schoolId,
			portalFormOf({
				schoolId,
				menu,
				products,
				priceIdOf: (tierId, interval) =>
					priceIds[trifoldLookupKey(org, tierId, interval)],
			}),
			log,
		);
		schools[schoolId] = {
			org,
			menuVersion: menuVersionOf(menu, policy),
			menu,
			policy,
			products: Object.fromEntries(
				Object.entries(products).sort(([a], [b]) => a.localeCompare(b)),
			),
			priceIds,
			portalConfiguration,
		};
	}
	return {
		stripeAccount: input.stripeAccount,
		livemode: false,
		apiVersion: STRIPE_API_VERSION,
		schools,
	};
};

/** `stripe get|post` through the CLI's logged-in TEST session. */
export const stripeCli: StripeCall = async (method, path, params, key) => {
	const args = [
		"stripe",
		method === "GET" ? "get" : "post",
		path,
		"--stripe-version",
		STRIPE_API_VERSION,
		...params.flatMap(([name, value]) => ["-d", `${name}=${value}`]),
		...(key ? ["--idempotency", key] : []),
	];
	const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
	const [out, code] = await Promise.all([
		new Response(child.stdout).text(),
		child.exited,
	]);
	const answer = JSON.parse(out || "{}") as Record<string, unknown>;
	if (code !== 0 || answer.error)
		throw new Error(
			`stripe ${method} ${path} failed: ${JSON.stringify((answer.error as { message?: string })?.message ?? code)}`,
		);
	return answer;
};

if (import.meta.main) {
	const dryRun = process.argv.includes("--dry-run");
	const file = Bun.file(OUTPUT);
	const previous = (await file.exists())
		? ((await file.json()) as PublishedPlans)
		: null;
	const account = await stripeCli("GET", "/v1/account", []);
	const stripeAccount = String(account.id);
	if (previous && previous.stripeAccount !== stripeAccount)
		throw new Error(
			`the CLI is logged in to ${stripeAccount}, and ${OUTPUT} was published to ${previous.stripeAccount}`,
		);
	const published = await publishPlans({
		stripe: stripeCli,
		previous,
		stripeAccount,
		dryRun,
		log: console.log,
	});
	if (!dryRun) {
		await Bun.write(OUTPUT, `${JSON.stringify(published, null, "\t")}\n`);
		console.log(`wrote ${OUTPUT}`);
	}
}
