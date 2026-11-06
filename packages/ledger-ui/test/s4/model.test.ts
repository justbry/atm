import { expect, test } from "bun:test";
import {
	applyRoles,
	attentionOf,
	barOf,
	type Change,
	capabilityReason,
	changeWaiting,
	formatMoney,
	paymentsCsv,
	paymentsOf,
	pendingEvent,
	project,
	roleGuard,
	standingOf,
	viewerOf,
} from "../../src/app/members-model.ts";
import type {
	Capabilities,
	Member,
	MemberBalance,
	Person,
} from "../../src/data/members.ts";
import { membersFixtures } from "../../src/fixtures/members.ts";

const vol = membersFixtures.vol;
const b4u = membersFixtures.b4u;
if (!vol || !b4u) throw new Error("fixtures missing");
const person = (id: string, people: Person[]): Person => {
	const found = people.find((candidate) => candidate.id === id);
	if (!found) throw new Error(`no person ${id}`);
	return found;
};
const balance: MemberBalance = {
	featureId: "session",
	featureName: "Sessions",
	unit: { one: "session", other: "sessions" },
	available: 20,
	held: 2,
	expiresAt: null,
	granted: 32,
};
const ledger = (
	personId: string,
	fields: Parameters<typeof pendingEvent>[1],
	paymentIntentId: string | null = null,
): Change => ({
	kind: "ledger",
	personId,
	event: pendingEvent("2026-11-05T12:00", fields),
	paymentIntentId,
});

test("who is looking: a preview needs the audience, and an unheld one falls back to the viewer's own", () => {
	expect(viewerOf(vol.people, null)).toEqual({
		subject: "owner",
		preview: false,
		roster: true,
		finance: true,
	});
	expect(viewerOf(vol.people, "finance")).toMatchObject({
		subject: "finance",
		preview: true,
		roster: true,
		finance: true,
	});
	expect(viewerOf(vol.people, "admin")).toMatchObject({
		roster: true,
		finance: false,
	});
	expect(viewerOf(vol.people, "public")).toMatchObject({
		preview: true,
		roster: false,
	});
	// Jo A. at B4 Uni is a finance admin: she may preview governance, not the owner, and not nonsense.
	expect(viewerOf(b4u.people, "governance").roster).toBe(false);
	expect(viewerOf(b4u.people, "owner")).toMatchObject({
		subject: "finance",
		preview: false,
	});
	expect(viewerOf(b4u.people, "nonsense").subject).toBe("finance");
});

test("pending events move the balance as the mockup does, and the bar follows", () => {
	const none = project(balance, "m_012", []);
	expect(none).toEqual({ available: 20, held: 2, used: 10, reported: 20 });
	const released = project(balance, "m_012", [
		ledger("m_012", { type: "credit.released", text: "", credits: 2 }),
	]);
	expect(released).toMatchObject({ available: 22, held: 0, used: 10 });
	const forfeited = project(balance, "m_012", [
		ledger("m_012", { type: "credit.forfeited", text: "", credits: -2 }),
	]);
	expect(forfeited).toMatchObject({ available: 20, held: 0, used: 12 });
	const adjusted = project(balance, "m_012", [
		ledger("m_012", { type: "credit.adjusted", text: "", credits: -5 }),
		ledger("m_204", { type: "credit.adjusted", text: "", credits: 100 }),
	]);
	expect(adjusted.available).toBe(15);
	const { low, percents } = barOf(balance, none);
	expect(low).toBe(false);
	expect(percents).toEqual({ used: "31.3%", held: "6.3%", available: "62.5%" });
	expect(
		barOf(
			{ ...balance, available: 6 },
			project({ ...balance, available: 6 }, "x", []),
		).low,
	).toBe(true);
});

test("a booking with a write on its way drops its attention reasons, a canceled membership has none", () => {
	const ivy = person("m_012", vol.people);
	expect(attentionOf(ivy, false, []).map(({ kind }) => kind)).toEqual([
		"inside_cutoff",
	]);
	expect(
		attentionOf(ivy, false, [{ kind: "booking", bookingId: "bk_5kd" }]),
	).toEqual([]);
	const mia = person("m_204", vol.people);
	expect(
		attentionOf(mia, false, [{ kind: "booking", bookingId: "bk_8zz" }]).map(
			({ kind }) => kind,
		),
	).toEqual(["out"]);
	expect(attentionOf(mia, true, [])).toEqual([]);
});

test("cancels and resumes apply to the membership in order", () => {
	const member: Member | undefined = vol.page.members.find(
		({ profileId }) => profileId === "m_012",
	);
	if (!member) throw new Error("no member");
	const change = (
		kind: "cancel_period_end" | "cancel_now" | "resume",
	): Change => ({
		kind: "membership",
		membershipId: member.membershipId,
		change: kind,
	});
	expect(standingOf(member, [])).toEqual({
		canceled: false,
		cancelsAtPeriodEnd: false,
		endsToday: false,
	});
	expect(standingOf(member, [change("cancel_period_end")])).toMatchObject({
		cancelsAtPeriodEnd: true,
	});
	expect(
		standingOf(member, [change("cancel_period_end"), change("resume")]),
	).toMatchObject({ cancelsAtPeriodEnd: false, canceled: false });
	expect(standingOf(member, [change("cancel_now")])).toMatchObject({
		canceled: true,
		endsToday: true,
	});
	expect(
		changeWaiting(
			[ledger("m_012", { type: "membership.changed", text: "" })],
			"m_012",
		),
	).toBe(true);
	expect(
		changeWaiting(
			[ledger("m_012", { type: "membership.changed", text: "" })],
			"m_204",
		),
	).toBe(false);
});

test("role changes: a plan holder stays, a role-only member leaves, the audience follows the grant", () => {
	const role = (
		id: string,
		change: "make" | "remove" | "grant" | "revoke",
	): Change => ({
		kind: "role",
		personId: id,
		role: change,
	});
	const afterRevoke = applyRoles(vol.people, [role("u_rav", "revoke")]);
	expect(person("u_rav", afterRevoke)).toMatchObject({
		financeGrant: false,
		audience: "public",
	});
	const afterRemove = applyRoles(vol.people, [
		role("u_rav", "remove"),
		role("m_093", "remove"),
	]);
	expect(afterRemove.some(({ id }) => id === "u_rav")).toBe(false);
	expect(person("m_093", afterRemove).role).toBe("member");
	const afterGrant = applyRoles(vol.people, [role("m_093", "grant")]);
	expect(person("m_093", afterGrant)).toMatchObject({
		financeGrant: true,
		audience: "finance",
	});
	const afterMake = applyRoles(vol.people, [role("m_204", "make")]);
	expect(person("m_204", afterMake)).toMatchObject({
		role: "admin",
		audience: "member",
	});
});

test("role guards and capability reasons", () => {
	const owner: Capabilities = vol.capabilities;
	const admin: Capabilities = b4u.capabilities;
	const kim = person("u_kim", vol.people);
	expect(roleGuard(owner, vol.people, kim, "remove")).toBe(
		"Last owner: add another owner first",
	);
	const twoOwners = [
		...vol.people,
		{ ...kim, id: "u_zed", name: "Zed Q.", you: false },
	];
	expect(roleGuard(owner, twoOwners, kim, "remove")).toBe(
		"Owners can't demote themselves",
	);
	expect(
		roleGuard(owner, twoOwners, person("u_zed", twoOwners), "remove"),
	).toBe("");
	expect(roleGuard(owner, vol.people, kim, "make")).toBe("");
	expect(roleGuard(admin, b4u.people, person("s_21", b4u.people), "make")).toBe(
		"Owner role needed",
	);
	expect(capabilityReason(admin, "refund", "menu")).toBe("Owner role needed");
	expect(capabilityReason(admin, "refund", "drawer")).toBe(
		"Refunds need the owner role in this school",
	);
	const map = membersFixtures.map;
	if (!map) throw new Error("no map");
	expect(capabilityReason(map.capabilities, "invoice", "menu")).toBe(
		"The Stripe key lacks Invoices (write). Fix it in Settings.",
	);
	expect(capabilityReason(owner, "invoice", "menu")).toBe("");
});

test("a refund on its way is the first payment row and turns its payment to Refunded or Partly refunded", () => {
	const detail = vol.details.m_012;
	if (!detail) throw new Error("no detail");
	const refund = (cents: number): Change =>
		ledger(
			"m_012",
			{
				type: "payment.refunded",
				kind: "membership",
				text: "Partial refund · duplicate charge",
				amountCents: -cents,
			},
			"pay_1114",
		);
	const partial = paymentsOf(detail, "m_012", [refund(5000)], "2026-11-05");
	expect(partial[0]).toMatchObject({
		date: "2026-11-05",
		amountCents: -5000,
		status: "Open",
	});
	expect(partial[1]).toMatchObject({
		description: "Invoice paid, Sparkle ×4 (10% off)",
		status: "Partly refunded",
	});
	const whole = paymentsOf(detail, "m_012", [refund(11700)], "2026-11-05");
	expect(whole[1]?.status).toBe("Refunded");
	expect(whole).toHaveLength(detail.payments.length + 1);
});

test("money and the CSV: the minus sign is U+2212, text cells that start like a formula are quoted off", () => {
	expect(formatMoney(-5000, "USD")).toBe("−$50.00");
	expect(formatMoney(11700, "USD")).toBe("$117.00");
	const csv = paymentsCsv(
		[
			{
				date: "2026-11-02",
				description: '=HYPERLINK("x"), "quoted"',
				amountCents: -5000,
				status: "Refunded",
				invoiceId: null,
				paymentId: "pay_51",
			},
		],
		"USD",
	);
	expect(csv).toBe(
		`﻿date,description,amount,currency,status,invoice_id,payment_id\r\n2026-11-02,"'=HYPERLINK(""x""), ""quoted""",-50.00,USD,Refunded,,pay_51\r\n`,
	);
});
