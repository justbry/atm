import type { DisclosureOverride } from "./disclosure.ts";

/**
 * The Settings contract (S7, orchestrator-owned, protected; protocol §4): what the mockup's Settings drawer (`#set`,
 * `settings()`) shows for one school and every change it makes. Accounting basis, keys and connections are the dev
 * mockup's; the School books section is the disclosure-v2 table, read from `Disclosure` (`disclosure.ts`) and saved
 * through `saveDisclosure`. The Reader and the Writer of `reader.ts` and `writer.ts` extend `SettingsReader` and
 * `SettingsWriter`; the S8 adapters call the family service's school-admin routes.
 *
 * Owners change settings; an admin reads them (every control disabled, "Owners only. You are an admin here: you can
 * look, not change."). While the route previews another audience (`as=`), every write control is disabled with the
 * title "Exit preview to act". Every write takes the family PIN where the mockup asks for it.
 */

export type AccountingBasis = "cash" | "deferred";

/** A Stripe restricted-key permission as the Check dialog lists it. */
export type StripePermission = string;
/** The Check dialog's three groups (mockup `PERMS_W`, `PERMS_R`, `PERMS_N`): the first two under "Needed to sell
 * plans", the last under "Needed for Send invoice and Refund". Only `money` can be missing from a connected key. */
export const stripePermissions = {
	write: [
		"Products (write)",
		"Prices (write)",
		"Coupons (write)",
		"Promotion codes (write)",
		"Customers (write)",
		"Checkout Sessions (write)",
		"Customer portal (write)",
		"Subscriptions (write)",
		"Subscription schedules (write)",
		"Webhook endpoints (write)",
	],
	read: [
		"Invoices (read)",
		"Charges (read)",
		"Disputes (read)",
		"Events (read)",
		"Account (read)",
	],
	money: ["Invoices (write)", "Refunds (write)"],
} as const;

export type StripeConnection =
	| {
			connected: true;
			/** The Stripe account's name. */
			account: string;
			mode: "live";
			/** The key's last four characters. */
			last4: string;
			/** Money permissions the key lacks, in `stripePermissions.money` order. */
			missing: StripePermission[];
	  }
	| { connected: false };
export type ZeffyConnection =
	| { connected: true; last4: string }
	| { connected: false };

export type ApiKeyKind = "pk" | "sk" | "rd";
/** A key or credential the school was given (mockup `s.keys`). */
export type ApiKey = {
	id: string;
	kind: ApiKeyKind;
	label: string;
	/** What is stored and shown: the first 15 characters of a key, `ro_<nn>` for a ledger read credential. */
	prefix: string;
	/** When it was last used, as the row shows it ("2 min ago", "yesterday", "Nov 3", "today", "never"): the S8
	 * adapter writes it from the key's last-use instant and the clock. */
	used: string;
};
/** At most this many live keys of one kind (`pk` or `sk`); a ledger read credential has no cap. */
export const maxLiveKeysPerKind = 2;

/** Booking rules the school has set (shown in Reports' "Rules in force"; not edited in the drawer). */
export type BookingRules = {
	cancelCutoffHours: number;
	noShow: "spend" | "release";
	lateCancel: "spend" | "release";
};

export type SchoolSettings = {
	school: string;
	basis: AccountingBasis;
	/** The day the saved basis applies from, `YYYY-MM-DD`. */
	basisFrom: string;
	stripe: StripeConnection;
	zeffy: ZeffyConnection;
	keys: ApiKey[];
	bookingRules: BookingRules;
};

/** The basis note's example (mockup copy): a yearly plan of 780 in the school's currency counts 780 at once on cash,
 * 65 a month deferred. Minor units. */
export const basisExample = { yearly: 78_000, monthly: 6500 } as const;

export interface SettingsReader {
	/** The school's settings; the S8 adapter reads the school-admin settings route. */
	settings(school: string): Promise<SchoolSettings>;
}

/** Accounting basis Save: `{ basis, from }`. Toast "Accounting basis saved: <basis> from <Mon d>. Logged as a policy
 * change." */
export type SaveAccountingBasis = {
	school: string;
	basis: AccountingBasis;
	from: string;
};
/** Create a key or credential with its label ("No label" when left empty). */
export type CreateKey = { school: string; kind: ApiKeyKind; label: string };
/** The new key: its secret is shown once and never stored here (only its SHA-256 and first 15 characters are). */
export type CreatedKey =
	| { kind: "pk" | "sk"; key: ApiKey; secret: string }
	| {
			kind: "rd";
			key: ApiKey;
			credential: {
				endpoint: string;
				bucket: string;
				prefix: string;
				keyId: string;
				secret: string;
			};
	  };
export type RevokeKey = { school: string; keyId: string };
/** Connect or Replace Stripe: a restricted live key (`rk_live_`) and the family PIN. */
export type SaveStripeKey = {
	school: string;
	restrictedKey: string;
	pin: string;
};
export type RemoveStripeKey = { school: string; pin: string };
export type SaveZeffyKey = { school: string; apiKey: string };
export type RemoveZeffyKey = { school: string; pin: string };
/** Check and save, after the PIN: the whole draft override (the saved one with the editor's changes). */
export type SaveDisclosure = {
	school: string;
	override: DisclosureOverride;
	pin: string;
};
/** `saved`: applied, one `books.disclosure_changed` audit row, effective from the next document build. `step_up`:
 * the change makes Public more open, so a link was mailed (it works once and expires in `expiresInMinutes`) and
 * nothing changes until it is opened. */
export type DisclosureSaved =
	| { status: "saved" }
	| { status: "step_up"; expiresInMinutes: number };

export interface SettingsWriter {
	saveAccountingBasis(request: SaveAccountingBasis): Promise<void>;
	createKey(request: CreateKey): Promise<CreatedKey>;
	revokeKey(request: RevokeKey): Promise<void>;
	saveStripeKey(request: SaveStripeKey): Promise<void>;
	removeStripeKey(request: RemoveStripeKey): Promise<void>;
	saveZeffyKey(request: SaveZeffyKey): Promise<void>;
	removeZeffyKey(request: RemoveZeffyKey): Promise<void>;
	saveDisclosure(request: SaveDisclosure): Promise<DisclosureSaved>;
	/** "I opened the link": asks whether the mailed step-up was confirmed and the change applied (the fixture applies
	 * it; S8 reads the step-up's state). */
	confirmDisclosureStepUp(request: {
		school: string;
	}): Promise<DisclosureSaved>;
}

/** The restricted-key field's line and whether Save key may be pressed (mockup `stripeModal` `chk`; Save also needs
 * a PIN of 4 or more digits). */
export function restrictedKeyMessage(key: string): {
	text: string;
	ok: boolean;
} {
	const minimumLength = 20;
	const value = key.trim();
	if (!value)
		return { text: "Paste a key that starts with rk_live_.", ok: false };
	if (value.startsWith("sk_"))
		return {
			text: "That is a full secret key. Create a restricted key instead.",
			ok: false,
		};
	if (value.startsWith("rk_test_"))
		return { text: "A test key can't be used in production.", ok: false };
	if (!value.startsWith("rk_live_"))
		return { text: "The key must start with rk_live_.", ok: false };
	if (value.length < minimumLength) return { text: "Keep typing…", ok: false };
	return {
		text: "Looks right. Permissions are checked when you save.",
		ok: true,
	};
}
/** A family PIN field is complete from this many digits. */
export const pinMinimumLength = 4;
/** Zeffy's Save key needs a key of at least this many characters. */
export const zeffyKeyMinimumLength = 10;
