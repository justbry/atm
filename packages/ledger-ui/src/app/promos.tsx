import type { ComponentChildren, JSX } from "preact";
import { useId, useLayoutEffect, useState } from "preact/hooks";
import {
	type CreditUnit,
	expiresSoon,
	maskCode,
	type Promo,
	type PromoType,
	seesIdentities,
} from "../data/ledger.ts";
import { failedToast } from "./booking-text.ts";
import { type BooksPaneProps, smallCount } from "./books-pane.ts";
import { Dialog } from "./dialog.tsx";
import { Icon } from "./icon.tsx";
import { LoadFailed } from "./load-failed.tsx";
import { formatMoney } from "./money.ts";
import { formatPeriod } from "./period.ts";
import { type Route, withQuery } from "./route.ts";
import { useLoaded } from "./use-loaded.ts";
import { useViewing } from "./viewing.ts";
import { capitalise } from "./wording.ts";

const previewTitle = "Exit preview to act";
const copyFailedToast =
	"Could not copy the code: the browser blocked the clipboard.";
const minimumNoteLength = 3;
const defaultValue = "10";

const countOf = (count: number, unit: CreditUnit): string =>
	`${count} ${count === 1 ? unit.one : unit.other}`;

const typeLabel = (type: PromoType, unit: CreditUnit): string =>
	({
		member: "Member % off",
		dollar: "Dollar gift",
		session: `${capitalise(unit.one)} gift`,
	})[type];
const valueText = (promo: Promo, currency: string, unit: CreditUnit): string =>
	promo.type === "member"
		? `${promo.value}% off tiers`
		: promo.type === "dollar"
			? formatMoney(promo.value, currency)
			: countOf(promo.value, unit);

type Dialogs = { step: "form" } | { step: "created"; promo: Promo };

/** The create dialog's preview line (mockup `ACT.code.prev`): what the code will do, or why it cannot be made yet. */
function preview(
	type: PromoType,
	value: string,
	expires: string,
	unit: CreditUnit,
	currency: string,
): { error: boolean; text: ComponentChildren } {
	const amount = Number(value);
	if (!(amount > 0)) return { error: true, text: "Enter a value above 0." };
	if (type === "member" && amount > 100)
		return { error: true, text: "A percentage can't exceed 100." };
	if (type === "member")
		return {
			error: false,
			text: (
				<>
					{"Members get "}
					<b>{`${amount}% off`}</b>
					{` membership tiers at checkout until ${expires}. ${capitalise(unit.other)} granted stay full. One code per checkout.`}
				</>
			),
		};
	if (type === "dollar")
		return {
			error: false,
			text: (
				<>
					{"A one-use Stripe promotion code worth "}
					<b>{formatMoney(Math.round(amount * 100), currency)}</b>
					{`, expiring ${expires}. Nothing is booked until it is sold or redeemed.`}
				</>
			),
		};
	return {
		error: false,
		text: (
			<>
				{"Redeeming grants "}
				<b>{countOf(amount, unit)}</b>
				{` once, expiring ${expires}. No money moves in Stripe.`}
			</>
		),
	};
}

function PromoForm({
	schoolName,
	unit,
	currency,
	defaultExpires,
	create,
	onCancel,
}: {
	schoolName: string;
	unit: CreditUnit;
	currency: string;
	defaultExpires: string;
	/** Sends the promo; resolves true once the Writer has answered, false (after telling the person) if it failed. */
	create: (
		type: PromoType,
		value: number,
		expires: string,
		note: string,
	) => Promise<boolean>;
	onCancel: () => void;
}): JSX.Element {
	const [type, setType] = useState<PromoType>("member");
	const [value, setValue] = useState(defaultValue);
	const [expires, setExpires] = useState(defaultExpires);
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const ids = useId();
	const shown = preview(type, value, expires, unit, currency);
	const send = async (): Promise<void> => {
		setBusy(true);
		const amount = Number(value);
		const created = await create(
			type,
			type === "dollar" ? Math.round(amount * 100) : amount,
			expires,
			note.trim(),
		);
		if (!created) setBusy(false);
	};
	return (
		<Dialog title={`Create promo · ${schoolName}`} onClose={onCancel}>
			<div class="mut">New promo</div>
			<div class="fld">
				<label for={`${ids}-type`}>Type</label>
				<select
					id={`${ids}-type`}
					data-test="promo-type-input"
					data-autofocus
					value={type}
					onInput={(event) => {
						const chosen = event.currentTarget.value;
						if (
							chosen === "member" ||
							chosen === "dollar" ||
							chosen === "session"
						)
							setType(chosen);
					}}
				>
					<option value="member">Member % off</option>
					<option value="dollar">Dollar gift certificate</option>
					<option value="session">{`${capitalise(unit.one)} gift certificate`}</option>
				</select>
			</div>
			<div class="fld">
				<label
					for={`${ids}-value`}
				>{`Value (% off, dollars or ${unit.other})`}</label>
				<input
					id={`${ids}-value`}
					type="number"
					step="0.01"
					data-test="promo-value-input"
					value={value}
					onInput={(event) => setValue(event.currentTarget.value)}
				/>
			</div>
			<div class="fld">
				<label for={`${ids}-expires`}>Expires</label>
				<input
					id={`${ids}-expires`}
					type="date"
					data-test="promo-expires-input"
					value={expires}
					onInput={(event) => setExpires(event.currentTarget.value)}
				/>
			</div>
			<div class="fld">
				<label for={`${ids}-note`}>Note (required)</label>
				<textarea
					id={`${ids}-note`}
					placeholder="Why, and who asked"
					data-test="promo-note-input"
					value={note}
					onInput={(event) => setNote(event.currentTarget.value)}
				/>
			</div>
			<div class="prev" data-test="promo-preview">
				{shown.error ? <b class="err">{shown.text}</b> : shown.text}
			</div>
			<div class="mf">
				<button
					type="button"
					class="btn"
					data-test="dialog-cancel"
					onClick={onCancel}
				>
					Cancel
				</button>
				<button
					type="button"
					class="btn p"
					data-test="dialog-confirm"
					aria-busy={busy}
					disabled={
						busy || shown.error || note.trim().length < minimumNoteLength
					}
					onClick={send}
				>
					Create promo
				</button>
			</div>
		</Dialog>
	);
}

function PromoCreated({
	schoolName,
	promo,
	summary,
	copy,
	onDone,
}: {
	schoolName: string;
	promo: Promo;
	summary: string;
	copy: (code: string) => void;
	onDone: () => void;
}): JSX.Element {
	const emailId = useId();
	return (
		<Dialog title={`Promo created · ${schoolName}`} onClose={onDone}>
			<div class="mut" data-test="promo-created-summary">
				{summary}
			</div>
			<div class="codebig mono" data-test="promo-created-code">
				{promo.code}
			</div>
			<div class="row2">
				<button type="button" class="btn p" onClick={() => copy(promo.code)}>
					<Icon name="copy" />
					Copy code
				</button>
				<button
					type="button"
					class="btn"
					disabled
					title="Checkout links are not available yet."
				>
					<Icon name="ext" />
					Copy checkout link
				</button>
			</div>
			<p class="mut" style="margin:10px 0 0" data-test="promo-created-note">
				{`The full code is shown only now. Later it appears masked (${maskCode(promo.code)}); an owner can still reveal it.`}
			</p>
			{promo.type !== "member" && (
				<div class="fld">
					<label for={emailId}>Email it to the recipient (optional)</label>
					<div class="row2">
						<input
							id={emailId}
							type="email"
							placeholder="name@example.com"
							style="flex:1"
							data-test="promo-email-input"
						/>
						<button
							type="button"
							class="btn"
							disabled
							title="Emailing a code is not available yet."
						>
							<Icon name="mail" />
							Send
						</button>
					</div>
				</div>
			)}
			<div class="mf">
				<button
					type="button"
					class="btn p"
					data-test="dialog-confirm"
					data-autofocus
					onClick={onDone}
				>
					Done
				</button>
			</div>
		</Dialog>
	);
}

function Used({ promo }: { promo: Promo }): JSX.Element {
	const { used, maxUses } = promo;
	if (typeof used === "object" && "hidden" in used)
		return (
			<td
				class="r"
				data-test="promo-used"
				data-hid={used.hidden}
				title="Governance and up see this"
			>
				<span class="khid">
					<Icon name="lock" />
					Governance and up see this
				</span>
			</td>
		);
	const limit = maxUses === null ? "" : `/${maxUses}`;
	if (typeof used === "object")
		return (
			<td
				class="r"
				data-test="promo-used"
				title={`Rounded to the nearest 10: fewer than ${smallCount} redeemers`}
			>
				<span class="kapprox">{`<${used.lt}`}</span>
				{limit}
			</td>
		);
	return (
		<td class="r" data-test="promo-used">
			{`${used}${limit}`}
		</td>
	);
}

/** The Promos tab (mockup `codes()`). Owners create codes, owners and admins disable them; what an audience may see of
 * a code (its uses, who redeemed, the full code) follows its grant. A preview acts on nothing. */
export function Promos({
	reader,
	writer,
	school,
	clock,
	route,
	navigate,
	onRendered,
	onToast,
}: BooksPaneProps): JSX.Element | null {
	const { option, preview: previewing } = useViewing();
	const { audience } = option;
	const { admin } = option;
	const finance = seesIdentities(audience);
	const owner = school.role === "owner";
	const [loaded, change, status] = useLoaded(`${school.id}|${audience}`, () =>
		reader.promos({ school: school.id, audience }),
	);
	const [revealed, setRevealed] = useState<string[]>([]);
	const [disabling, setDisabling] = useState<string | null>(null);
	const [dialog, setDialog] = useState<Dialogs | null>(null);
	useLayoutEffect(() => {
		if (loaded || status.failed) onRendered();
	});
	if (status.failed)
		return <LoadFailed what="the promos" onRetry={status.retry} />;
	if (!loaded) return null;

	const { promos, currency, unit } = loaded;
	const copy = async (code: string): Promise<void> => {
		try {
			await navigator.clipboard.writeText(code);
			onToast("Code copied.");
		} catch {
			onToast(copyFailedToast);
		}
	};
	const disable = async (promo: Promo): Promise<void> => {
		setDisabling(promo.id);
		try {
			const answered = await writer.disablePromo({
				school: school.id,
				promoId: promo.id,
			});
			change((current) => ({
				...current,
				promos: current.promos.map((other) =>
					other.id === answered.id ? answered : other,
				),
			}));
			onToast(
				`Promo ${maskCode(answered.code)} disabled. It stops working at checkout now.`,
			);
		} catch {
			onToast(failedToast);
		} finally {
			setDisabling(null);
		}
	};
	const create = async (
		type: PromoType,
		value: number,
		expiresOn: string,
		note: string,
	): Promise<boolean> => {
		try {
			const promo = await writer.createPromo({
				school: school.id,
				type,
				value,
				expiresOn,
				note,
			});
			change((current) => ({ ...current, promos: [promo, ...current.promos] }));
			setDialog({ step: "created", promo });
			return true;
		} catch {
			onToast(failedToast);
			return false;
		}
	};
	const openRedemptions = (promo: Promo): void => {
		const yearToDate = {
			from: `${clock.today.slice(0, 4)}-01-01`,
			to: clock.today,
		};
		navigate(
			redemptionsRoute(route, promo.id, formatPeriod(yearToDate, clock.today)),
		);
	};
	const note = !admin
		? "Owners and admins manage promos. Redemption counts are a breakdown (Governance and up); who redeemed is finance and owner only."
		: owner
			? "Owners create promos. Admins can view and disable."
			: "You are an admin here: you can view and disable promos. Owners create them.";
	const newTitle = previewing
		? previewTitle
		: owner
			? undefined
			: "Creating promos needs the owner role in this school";

	return (
		<>
			<div class="tools">
				<span class="mut" data-test="promo-note">
					{note}
				</span>
				<span class="sp" />
				<button
					type="button"
					class="btn p"
					data-test="promo-new"
					disabled={!owner || previewing}
					title={newTitle}
					onClick={() => setDialog({ step: "form" })}
				>
					<Icon name="plus" />
					Create promo
				</button>
			</div>
			<table>
				<thead>
					<tr>
						<th>Code</th>
						<th>Type</th>
						<th>Value</th>
						<th class="r">Used</th>
						<th>Expires</th>
						<th>Status</th>
						<th />
					</tr>
				</thead>
				<tbody>
					{promos.map((promo) => {
						const shown = revealed.includes(promo.id);
						const busy = disabling === promo.id;
						const label = shown ? "Hide code" : "Show code";
						return (
							<tr
								key={promo.id}
								class="nc"
								data-test="promo-row"
								data-promo={promo.id}
							>
								<td>
									<span class="mono" data-test="promo-code">
										{shown ? promo.code : maskCode(promo.code)}
									</span>{" "}
									<button
										type="button"
										class="btn ico s"
										data-test="promo-reveal"
										disabled={!admin}
										aria-label={label}
										title={admin ? label : "Owners and admins only"}
										onClick={() =>
											setRevealed(
												shown
													? revealed.filter((id) => id !== promo.id)
													: [...revealed, promo.id],
											)
										}
									>
										<Icon name={shown ? "lock" : "eye"} />
									</button>{" "}
									<button
										type="button"
										class="btn ico s"
										data-test="promo-copy"
										disabled={!admin}
										aria-label="Copy code"
										title={admin ? "Copy code" : "Owners and admins only"}
										onClick={() => copy(promo.code)}
									>
										<Icon name="copy" />
									</button>
								</td>
								<td data-test="promo-type">{typeLabel(promo.type, unit)}</td>
								<td data-test="promo-value">
									{valueText(promo, currency, unit)}
								</td>
								<Used promo={promo} />
								<td data-test="promo-expires">
									{promo.expiresOn}
									{expiresSoon(promo, clock) && (
										<>
											{" "}
											<span class="badge b-warn" data-test="promo-soon">
												soon
											</span>
										</>
									)}
								</td>
								<td>
									<span
										class={`badge ${promo.status === "active" ? "b-ok" : promo.status === "disabled" ? "b-bad" : ""}`}
										data-test="promo-status"
									>
										{promo.status}
									</span>
								</td>
								<td class="r">
									<button
										type="button"
										class="btn s"
										data-test="promo-redemptions"
										disabled={!finance}
										title={
											finance
												? undefined
												: "Finance admins only: lists who redeemed"
										}
										onClick={() => openRedemptions(promo)}
									>
										<Icon name="list" />
										Redemptions
									</button>{" "}
									{promo.status === "active" && (
										<button
											type="button"
											class="btn s"
											data-test="promo-disable"
											aria-busy={busy}
											disabled={previewing || busy}
											title={previewing ? previewTitle : undefined}
											onClick={() => disable(promo)}
										>
											<Icon name="ban" />
											Disable
										</button>
									)}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
			{promos.length === 0 && (
				<p
					class="mut"
					data-test="promo-empty"
					style="text-align:center;padding:24px 0"
				>
					No promos yet.
				</p>
			)}
			{dialog?.step === "form" && (
				<PromoForm
					schoolName={school.name}
					unit={unit}
					currency={currency}
					defaultExpires={`${clock.today.slice(0, 4)}-12-31`}
					create={create}
					onCancel={() => setDialog(null)}
				/>
			)}
			{dialog?.step === "created" && (
				<PromoCreated
					schoolName={school.name}
					promo={dialog.promo}
					summary={`${typeLabel(dialog.promo.type, unit)} · ${valueText(dialog.promo, currency, unit)} · expires ${dialog.promo.expiresOn}`}
					copy={copy}
					onDone={() => setDialog(null)}
				/>
			)}
		</>
	);
}

/** A promo's Redemptions (mockup `[data-red]`): the Ledger for the year to date, filtered to that code. */
const redemptionsRoute = (
	route: Route,
	promoId: string,
	month: string | null,
): Route => ({
	...withQuery(
		withQuery(
			withQuery(withQuery(route, "month", month), "promo", promoId),
			"drill",
			null,
		),
		"type",
		null,
	),
	tab: "ledger",
});
