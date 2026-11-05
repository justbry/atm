/**
 * Gift codes: a session gift certificate (credits, redeemed in atm, no Stripe) and a dollar gift certificate (a one-use
 * Stripe promotion code). Member codes are on the menu (`menu.codes`, `menuToStripe`, `checkoutParams`). Pure. Owned by the
 * codes change (0.8.0); the signatures are fixed in `ROADMAP.md` ("0.8.0 design") and `types.ts`, and this file holds them
 * until that change lands.
 */
import type {
	CreateSessionGiftCodeInput,
	CreateSessionGiftCodeResult,
	DollarGiftInput,
	DollarGiftResult,
	RedeemSessionGiftCodeInput,
	RedeemSessionGiftCodeResult,
} from "./types.js";

const notBuilt = (name: string): never => {
	throw new Error(`${name} is not built yet`);
};

/** A session gift code, or why it cannot be made (a bad code text, an unknown feature, credits that are not whole, an expiry in the past). */
export const createSessionGiftCode = (
	_input: CreateSessionGiftCodeInput,
): CreateSessionGiftCodeResult => notBuilt("createSessionGiftCode");

/** Redeems a session gift code for a holder: the credits as a new grant, and the code's next state. */
export const redeemSessionGiftCode = (
	_input: RedeemSessionGiftCodeInput,
): RedeemSessionGiftCodeResult => notBuilt("redeemSessionGiftCode");

/** The Stripe steps for a dollar gift certificate: a fixed-amount coupon and a one-use promotion code that ends. */
export const dollarGiftOps = (_input: DollarGiftInput): DollarGiftResult =>
	notBuilt("dollarGiftOps");
