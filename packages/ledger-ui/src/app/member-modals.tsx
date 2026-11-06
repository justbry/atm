import type { ComponentChildren, JSX } from "preact";
import { useEffect, useId, useState } from "preact/hooks";
import { type DownloadFile, jsonMediaType } from "../data/ledger.ts";
import type {
	InvoiceItem,
	Member,
	MemberAudit,
	MemberBooking,
	MemberDetail,
	SwitchTier,
} from "../data/members.ts";
import { cutoffHours } from "./booking-text.ts";
import { Dialog } from "./dialog.tsx";
import { Icon, type IconName } from "./icon.tsx";
import {
	type Applied,
	type Change,
	capitalized,
	countOf,
	formatWallTime,
	pendingBookingIds,
	project,
	type RoleChange,
	refundedOf,
	roleTexts,
} from "./members-model.ts";
import {
	adjustCredits,
	cancelMembership,
	changeRole,
	recordOutcome,
	refundPayment,
	releasable,
	releaseHold,
	resumeMembership,
	sendInvoice,
	switchPlan,
	type WriteContext,
} from "./members-writes.ts";
import { currencySymbol, formatMoney } from "./money.ts";

/** What the Members tab can ask the person's modal for. */
export type Action =
	| { kind: "role"; change: RoleChange }
	| { kind: "adjust" | "invoice" | "switch" | "cancel" | "resume" | "audit" }
	/** The release picker: the person's releasable bookings. */
	| { kind: "pick" }
	/** `bookingId`: the payment of that booking is the one offered first. */
	| { kind: "refund"; bookingId: string | null }
	| { kind: "release" | "noshow"; bookingId: string };

/** Everything a modal reads and the three ways it ends. */
export type ModalContext = {
	write: WriteContext;
	member: Member | null;
	detail: MemberDetail;
	changes: Change[];
	currency: string;
	invoiceItems: InvoiceItem[];
	switchTiers: SwitchTier[];
	/** Whether the booking is inside its cutoff (the server says so, in the person's attention). */
	insideCutoff: (booking: MemberBooking) => boolean;
	/** "Audit member": the server's replay of the person's log, balance and Stripe. */
	readAudit: () => Promise<MemberAudit>;
	/** "Export report": the Writer's download. */
	saveReport: (file: DownloadFile) => Promise<void>;
	onToast: (text: string) => void;
	onDone: (applied: Applied) => void;
	onFailed: () => void;
	onCancel: () => void;
};

/** Runs a write; the modal stays open and busy until the Writer answers, then hands the effect to the tab. */
function useSubmit(context: ModalContext): {
	busy: boolean;
	submit: (write: () => Promise<Applied>) => Promise<void>;
} {
	const [busy, setBusy] = useState(false);
	const { onDone, onFailed } = context;
	const submit = async (write: () => Promise<Applied>): Promise<void> => {
		setBusy(true);
		let applied: Applied;
		try {
			applied = await write();
		} catch {
			setBusy(false);
			onFailed();
			return;
		}
		onDone(applied);
	};
	return { busy, submit };
}

type FrameProps = {
	title: ComponentChildren;
	subtitle?: ComponentChildren;
	children?: ComponentChildren;
	/** The dashed box under the fields (the mockup's `.prev`). */
	preview?: ComponentChildren;
	/** What `preview` is for the golden file: the role modal's refresh line is the note. */
	previewHook?: "modal-preview" | "modal-note";
	confirm?: {
		label: string;
		tone: "p" | "d" | "";
		icon?: IconName;
		disabled: boolean;
		onConfirm: () => void;
	};
	cancelLabel?: string;
	busy: boolean;
	onCancel: () => void;
};

/** A Members modal in the shared dialog: a title, the fields, the preview, Cancel and the action. Escape, the
 * backdrop and Cancel close it unless a write is on its way; focus starts on Cancel. */
function ModalFrame({
	title,
	subtitle,
	children,
	preview,
	previewHook = "modal-preview",
	confirm,
	cancelLabel = "Cancel",
	busy,
	onCancel,
}: FrameProps): JSX.Element {
	const close = (): void => {
		if (!busy) onCancel();
	};
	return (
		<Dialog title={title} onClose={onCancel} busy={busy} hooks="modal">
			{subtitle !== undefined && (
				<div class="mut" data-test="modal-subtitle">
					{subtitle}
				</div>
			)}
			{children}
			{preview !== undefined && (
				<div class="prev" data-test={previewHook} aria-live="polite">
					{preview}
				</div>
			)}
			<div class="mf">
				<button
					type="button"
					class="btn"
					data-test="modal-cancel"
					data-autofocus
					onClick={close}
				>
					{cancelLabel}
				</button>
				{confirm && (
					<button
						type="button"
						class={`btn ${confirm.tone}`}
						data-test="modal-confirm"
						disabled={confirm.disabled || busy}
						aria-busy={busy ? "true" : undefined}
						onClick={confirm.onConfirm}
					>
						{confirm.icon && <Icon name={confirm.icon} />}
						{confirm.label}
					</button>
				)}
			</div>
		</Dialog>
	);
}

/** A labelled field; `children` gets the id the label points to. */
function Field({
	field,
	label,
	children,
}: {
	field: string;
	label: ComponentChildren;
	children: (id: string) => ComponentChildren;
}): JSX.Element {
	const id = useId();
	return (
		<div class="fld">
			<label for={id} data-test="modal-field-label" data-field={field}>
				{label}
			</label>
			{children(id)}
		</div>
	);
}

function NoteField({
	note,
	onInput,
}: {
	note: string;
	onInput: (note: string) => void;
}): JSX.Element {
	return (
		<Field field="note" label="Note (required)">
			{(id) => (
				<textarea
					id={id}
					data-test="modal-field"
					data-field="note"
					placeholder="Why, and who asked"
					value={note}
					onInput={(event) => onInput(event.currentTarget.value)}
				/>
			)}
		</Field>
	);
}

const noteLength = 3;
const hasNote = (note: string): boolean => note.trim().length >= noteLength;

const errorText = (text: string): JSX.Element => <b class="err">{text}</b>;

const adjustKinds = [
	["goodwill", "Goodwill"],
	["gift", "Gift"],
	["correction", "Correction"],
] as const;

function AdjustModal({ context }: { context: ModalContext }): JSX.Element {
	const { write, member } = context;
	const [kind, setKind] = useState<(typeof adjustKinds)[number][0]>("goodwill");
	const [delta, setDelta] = useState("2");
	const [note, setNote] = useState("");
	const { busy, submit } = useSubmit(context);
	const available = member?.balances[0]?.available ?? 0;
	const amount = Number(delta);
	const problem =
		!Number.isInteger(amount) || amount === 0
			? "Enter a whole number other than 0."
			: kind === "gift" && amount < 0
				? "A gift must be positive."
				: available + amount < 0
					? `Would go below zero (${available} available).`
					: null;
	const { person, unit } = write;
	return (
		<ModalFrame
			title={`Adjust ${unit.other} · ${write.schoolName}`}
			subtitle={`${person.name} · ${person.id}`}
			preview={
				problem === null ? (
					<>
						{person.name}:{" "}
						<b>
							{available} → {available + amount}
						</b>{" "}
						available.
						{kind === "gift" && ` Gift ${unit.other} expire after 6 months.`}
					</>
				) : (
					errorText(problem)
				)
			}
			confirm={{
				label: "Apply",
				tone: "p",
				disabled: problem !== null || !hasNote(note) || member === null,
				onConfirm: () => {
					if (member)
						submit(() =>
							adjustCredits(write, member, {
								kind,
								amount,
								note: note.trim(),
							}),
						);
				},
			}}
			busy={busy}
			onCancel={context.onCancel}
		>
			<Field field="type" label="Type">
				{(id) => (
					<select
						id={id}
						data-test="modal-field"
						data-field="type"
						value={kind}
						onInput={(event) => {
							const chosen = adjustKinds.find(
								([value]) => value === event.currentTarget.value,
							);
							if (chosen) setKind(chosen[0]);
						}}
					>
						{adjustKinds.map(([value, label]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</select>
				)}
			</Field>
			<Field
				field="delta"
				label={`${capitalized(unit.other)} (negative to remove)`}
			>
				{(id) => (
					<input
						id={id}
						type="number"
						step="0.01"
						data-test="modal-field"
						data-field="delta"
						defaultValue="2"
						value={delta}
						onInput={(event) => setDelta(event.currentTarget.value)}
					/>
				)}
			</Field>
			<NoteField note={note} onInput={setNote} />
		</ModalFrame>
	);
}

function InvoiceModal({ context }: { context: ModalContext }): JSX.Element {
	const { write, member, invoiceItems } = context;
	const [addonId, setAddonId] = useState(invoiceItems[0]?.addonId ?? "");
	const [memo, setMemo] = useState("");
	const { busy, submit } = useSubmit(context);
	const item = invoiceItems.find((candidate) => candidate.addonId === addonId);
	return (
		<ModalFrame
			title={`Send invoice · ${write.schoolName}`}
			subtitle={`${write.person.name} · ${write.person.id}`}
			preview={
				item ? (
					<>
						Stripe emails {write.person.name} an invoice for <b>{item.label}</b>
						. Credits are granted <b>only when it is paid</b>.
					</>
				) : (
					errorText("There is nothing to invoice.")
				)
			}
			confirm={{
				label: "Send invoice",
				tone: "p",
				disabled: !item || member === null,
				onConfirm: () => {
					if (item && member)
						submit(() =>
							sendInvoice(write, member, {
								addonId: item.addonId,
								memo: memo.trim(),
							}),
						);
				},
			}}
			busy={busy}
			onCancel={context.onCancel}
		>
			<Field field="item" label="Item">
				{(id) => (
					<select
						id={id}
						data-test="modal-field"
						data-field="item"
						value={addonId}
						onInput={(event) => setAddonId(event.currentTarget.value)}
					>
						{invoiceItems.map((candidate) => (
							<option key={candidate.addonId} value={candidate.addonId}>
								{candidate.label}
							</option>
						))}
					</select>
				)}
			</Field>
			<Field field="memo" label="Memo (optional)">
				{(id) => (
					<input
						id={id}
						type="text"
						autoComplete="off"
						data-test="modal-field"
						data-field="memo"
						value={memo}
						onInput={(event) => setMemo(event.currentTarget.value)}
					/>
				)}
			</Field>
		</ModalFrame>
	);
}

const majorUnits = (cents: number): string => (cents / 100).toFixed(2);

function RefundModal({
	context,
	bookingId,
}: {
	context: ModalContext;
	bookingId: string | null;
}): JSX.Element {
	const { write, detail, changes, currency } = context;
	const { refundable } = detail;
	const leftOf = (payment: (typeof refundable)[number]): number =>
		payment.amountCents - refundedOf(payment, changes);
	const first =
		refundable.find(
			(payment) => bookingId && payment.bookingId === bookingId,
		) ??
		refundable.find((payment) => leftOf(payment) > 0) ??
		refundable[0];
	const [paymentId, setPaymentId] = useState(first?.paymentIntentId ?? "");
	const [amount, setAmount] = useState(first ? majorUnits(leftOf(first)) : "0");
	const [typed, setTyped] = useState("");
	const [note, setNote] = useState("");
	const { busy, submit } = useSubmit(context);
	const payment = refundable.find(
		({ paymentIntentId }) => paymentIntentId === paymentId,
	);
	const money = (cents: number): string => formatMoney(cents, currency);
	const cents = Math.round((Number.parseFloat(amount) || 0) * 100);
	const refunded = payment ? refundedOf(payment, changes) : 0;
	const left = payment ? payment.amountCents - refunded : 0;
	const whole = cents === left;
	const matches =
		(Number.parseFloat(typed) || 0).toFixed(2) === majorUnits(cents);
	const problem = !payment
		? "This member has no payments to refund."
		: left <= 0
			? `Nothing left to refund: ${money(refunded)} of ${money(payment.amountCents)} was already refunded.`
			: cents <= 0
				? "Enter an amount above 0."
				: cents > left
					? `Only ${money(left)} is left to refund on this payment (${money(refunded)} already refunded, pending refunds included).`
					: null;
	const effect = (): JSX.Element | string => {
		if (payment?.kind === "booking")
			return whole ? (
				<>
					Booking <span class="mono">{payment.bookingId}</span> is cancelled and
					the place is freed.
				</>
			) : (
				"The booking stays."
			);
		if (payment?.kind === "gift")
			return whole
				? "The gift code is disabled if it has not been redeemed."
				: "The gift code stays valid.";
		return whole ? (
			`${capitalized(write.unit.other)} from that invoice are taken back when Stripe confirms, never below zero.`
		) : (
			<>
				A <b>partial refund changes no {write.unit.other}</b>.
			</>
		);
	};
	const pick = (id: string): void => {
		setPaymentId(id);
		const chosen = refundable.find(
			({ paymentIntentId }) => paymentIntentId === id,
		);
		if (chosen) setAmount(majorUnits(leftOf(chosen)));
	};
	return (
		<ModalFrame
			title={`Refund a payment · ${write.schoolName}`}
			subtitle={`${write.person.name} · ${write.person.id}`}
			preview={
				problem === null ? (
					<>
						Stripe refunds <b>{money(cents)}</b>. {effect()}
						<div class="mut">
							{money(refunded)} already refunded · {money(left - cents)} would
							remain.
						</div>
					</>
				) : (
					errorText(problem)
				)
			}
			confirm={{
				label: "Refund in Stripe",
				tone: "p",
				disabled: problem !== null || !matches || !hasNote(note),
				onConfirm: () => {
					if (payment)
						submit(() =>
							refundPayment(write, payment, {
								amountCents: cents,
								whole,
								note: note.trim(),
							}),
						);
				},
			}}
			busy={busy}
			onCancel={context.onCancel}
		>
			<Field field="payment" label="Payment">
				{(id) => (
					<select
						id={id}
						data-test="modal-field"
						data-field="payment"
						value={paymentId}
						onInput={(event) => pick(event.currentTarget.value)}
					>
						{refundable.map((candidate) => {
							const already = refundedOf(candidate, changes);
							return (
								<option
									key={candidate.paymentIntentId}
									value={candidate.paymentIntentId}
								>
									{candidate.description} · {money(candidate.amountCents)} ·{" "}
									{already > 0
										? `refunded ${money(already)}, ${money(leftOf(candidate))} left`
										: "not refunded"}
								</option>
							);
						})}
					</select>
				)}
			</Field>
			<Field
				field="amount"
				label={
					<>
						Amount ({currencySymbol(currency)}, up to what is left){" "}
						<button
							type="button"
							class="link fill-rest"
							data-test="modal-fill-rest"
							onClick={() => setAmount(majorUnits(left))}
						>
							Refund the rest
						</button>
					</>
				}
			>
				{(id) => (
					<input
						id={id}
						type="number"
						step="0.01"
						data-test="modal-field"
						data-field="amount"
						defaultValue={first ? majorUnits(leftOf(first)) : "0"}
						value={amount}
						onInput={(event) => setAmount(event.currentTarget.value)}
					/>
				)}
			</Field>
			<Field field="typed" label="Type the refund amount to confirm">
				{(id) => (
					<input
						id={id}
						type="text"
						autoComplete="off"
						data-test="modal-field"
						data-field="typed"
						value={typed}
						onInput={(event) => setTyped(event.currentTarget.value)}
					/>
				)}
			</Field>
			<NoteField note={note} onInput={setNote} />
		</ModalFrame>
	);
}

/** "Facial · bk_5kd · Ivy N. · m_012" */
const bookingLine = (booking: MemberBooking, context: ModalContext): string =>
	`${booking.service} · ${booking.id} · ${context.write.person.name} · ${context.write.person.id}`;

function ReleaseHoldModal({
	context,
	booking,
}: {
	context: ModalContext;
	booking: MemberBooking;
}): JSX.Element {
	const { write } = context;
	const [waive, setWaive] = useState(false);
	const { busy, submit } = useSubmit(context);
	const held = countOf(booking.creditsHeld, write.unit);
	return (
		<ModalFrame
			title={`Release hold · ${write.schoolName}`}
			subtitle={bookingLine(booking, context)}
			preview={
				waive ? (
					<>
						<b>{held}</b> return to {write.person.name}'s available balance.
					</>
				) : (
					<>
						Inside the {cutoffHours(booking.cutoffMinutes)} cutoff, the school's
						rule <b>forfeits {held}</b>. Tick "Waive" to return them.
					</>
				)
			}
			confirm={{
				label: "Release hold",
				tone: "p",
				disabled: false,
				onConfirm: () =>
					submit(() =>
						releaseHold(write, booking, { waive, inside: true, quick: false }),
					),
			}}
			busy={busy}
			onCancel={context.onCancel}
		>
			<div class="fld c">
				<label data-test="modal-field-label" data-field="waive">
					<input
						type="checkbox"
						data-test="modal-field"
						data-field="waive"
						checked={waive}
						onChange={(event) => setWaive(event.currentTarget.checked)}
					/>{" "}
					Waive the late-cancel forfeit (return the {write.unit.other})
				</label>
			</div>
		</ModalFrame>
	);
}

function NoShowModal({
	context,
	booking,
}: {
	context: ModalContext;
	booking: MemberBooking;
}): JSX.Element {
	const { write } = context;
	const { busy, submit } = useSubmit(context);
	const held = countOf(booking.creditsHeld, write.unit);
	return (
		<ModalFrame
			title={`Mark no-show · ${write.schoolName}`}
			subtitle={bookingLine(booking, context)}
			preview={
				booking.creditsHeld === 0 ? (
					"No credits are involved. The no-show is recorded."
				) : write.rules.noShow === "spend" ? (
					<>
						Rule: a no-show spends the {write.unit.other}. <b>{held}</b> are
						spent.
					</>
				) : (
					<>
						Rule: a no-show releases the {write.unit.other}. <b>{held}</b>{" "}
						return to available.
					</>
				)
			}
			confirm={{
				label: "Mark no-show",
				tone: "p",
				disabled: false,
				onConfirm: () => submit(() => recordOutcome(write, booking, "no_show")),
			}}
			busy={busy}
			onCancel={context.onCancel}
		/>
	);
}

/** The release picker (mockup `kReleasePick`). A release that needs no second modal runs from the option, which
 * waits while the call is on its way; one inside its cutoff goes on to the Release hold modal. */
function PickModal({
	context,
	onPick,
}: {
	context: ModalContext;
	onPick: (booking: MemberBooking) => void;
}): JSX.Element {
	const { write } = context;
	const [waiting, setWaiting] = useState<string | null>(null);
	const { busy, submit } = useSubmit(context);
	const bookings = releasable(
		context.detail,
		write.person,
		pendingBookingIds(context.changes),
	);
	return (
		<ModalFrame
			title={
				<>
					<Icon name="unlock" /> Release a booking · {write.schoolName}
				</>
			}
			subtitle={`${write.person.name} · ${write.person.id}. Pick the booking whose hold to release.`}
			busy={busy}
			onCancel={context.onCancel}
		>
			<div class="fld">
				{bookings.map((booking) => (
					<button
						key={booking.id}
						type="button"
						class="btn release-option"
						data-test="release-option"
						data-booking={booking.id}
						disabled={busy}
						aria-busy={busy && waiting === booking.id ? "true" : undefined}
						onClick={() => {
							if (
								context.insideCutoff(booking) &&
								write.rules.lateCancel === "spend"
							) {
								onPick(booking);
								return;
							}
							setWaiting(booking.id);
							submit(() =>
								releaseHold(write, booking, {
									waive: false,
									inside: context.insideCutoff(booking),
									quick: true,
								}),
							);
						}}
					>
						<span>
							{booking.service} · {formatWallTime(booking.startsAt)}
						</span>
						<span class="mut">
							{countOf(booking.creditsHeld, write.unit)} held
						</span>
					</button>
				))}
			</div>
		</ModalFrame>
	);
}

function SwitchModal({ context }: { context: ModalContext }): JSX.Element {
	const { write, member, switchTiers, currency } = context;
	const others = switchTiers.filter(({ id }) => id !== member?.tierId);
	const [tierId, setTierId] = useState(others[0]?.id ?? "");
	const [quantity, setQuantity] = useState(others[0]?.quantities?.[0] ?? 1);
	const { busy, submit } = useSubmit(context);
	const tier = others.find(({ id }) => id === tierId);
	const money = (cents: number): string => formatMoney(cents, currency);
	const chosenTier = (id: string): void => {
		setTierId(id);
		setQuantity(
			others.find((candidate) => candidate.id === id)?.quantities?.[0] ?? 1,
		);
	};
	const label = tier ? `${tier.name} ×${quantity}` : "";
	const shown = tier?.quantities ? `${tier.name} ×${quantity}` : tier?.name;
	return (
		<ModalFrame
			title={
				<>
					<Icon name="layers" /> Switch plan · {write.person.name}{" "}
					<span class="badge">Admin</span>
				</>
			}
			subtitle={
				member ? `${member.tierName} ×${member.quantity} now` : undefined
			}
			preview={
				tier ? (
					<>
						From {write.renewal}: <b>{shown}</b> at{" "}
						<b>{money(tier.monthlyCents * quantity)}</b> / month. It takes
						effect at the renewal and grants nothing until then.
						<div class="mut">
							<Icon name="alert" /> Stripe's member portal doesn't offer plan
							switches today, so members can't do this themselves.
						</div>
					</>
				) : (
					errorText("There is no other plan to switch to.")
				)
			}
			confirm={{
				label: "Schedule switch",
				tone: "p",
				disabled: !tier || member === null,
				onConfirm: () => {
					if (tier && member)
						submit(() =>
							switchPlan(write, member, { tierId: tier.id, label, quantity }),
						);
				},
			}}
			busy={busy}
			onCancel={context.onCancel}
		>
			<Field field="tier" label="New plan">
				{(id) => (
					<select
						id={id}
						data-test="modal-field"
						data-field="tier"
						value={tierId}
						onInput={(event) => chosenTier(event.currentTarget.value)}
					>
						{others.map((candidate) => (
							<option key={candidate.id} value={candidate.id}>
								{candidate.name} · {money(candidate.monthlyCents)}
								{candidate.quantities ? ` per ${write.unit.one}` : ""} / month
							</option>
						))}
					</select>
				)}
			</Field>
			{tier?.quantities && (
				<Field field="quantity" label="Amount">
					{(id) => (
						<select
							id={id}
							data-test="modal-field"
							data-field="quantity"
							value={String(quantity)}
							onInput={(event) =>
								setQuantity(Number(event.currentTarget.value))
							}
						>
							{tier.quantities?.map((size) => (
								<option key={size} value={size}>
									{size}
								</option>
							))}
						</select>
					)}
				</Field>
			)}
		</ModalFrame>
	);
}

function CancelModal({ context }: { context: ModalContext }): JSX.Element {
	const { write, member, changes } = context;
	const [at, setAt] = useState<"period_end" | "now">("period_end");
	const [reason, setReason] = useState("");
	const { busy, submit } = useSubmit(context);
	const balance = member?.balances[0];
	const available = balance
		? project(balance, write.person.id, changes).available
		: 0;
	const now = at === "now";
	const choice = (
		value: "period_end" | "now",
		label: ComponentChildren,
	): JSX.Element => (
		<div class="fld c">
			<label data-test="modal-field-label" data-field="when" data-value={value}>
				<input
					type="radio"
					name="when"
					value={value}
					data-test="modal-field"
					data-field="when"
					checked={at === value}
					onChange={() => setAt(value)}
				/>{" "}
				{label}
			</label>
		</div>
	);
	return (
		<ModalFrame
			title={
				<>
					<Icon name="ban" /> Cancel membership · {write.person.name}
				</>
			}
			subtitle={member ? `${member.tierName} ×${member.quantity}` : undefined}
			preview={
				now ? (
					<>
						Ends today. <b>{countOf(available, write.unit)}</b> unused are
						forfeited. No refund is issued automatically: use Refund on an
						invoice if one is owed.
					</>
				) : (
					`Stays active until ${write.renewal}. ${countOf(available, write.unit)} can still be used until then. No further charges.`
				)
			}
			confirm={{
				label: "Cancel membership",
				tone: "d",
				disabled: (now && reason.trim().length < noteLength) || member === null,
				onConfirm: () => {
					if (member)
						submit(() =>
							cancelMembership(write, member, {
								at,
								reason: reason.trim(),
								available,
							}),
						);
				},
			}}
			cancelLabel="Keep membership"
			busy={busy}
			onCancel={context.onCancel}
		>
			{choice("period_end", `At the end of this period (${write.renewal})`)}
			{choice(
				"now",
				<>
					Right now <span class="badge">Admin</span>
				</>,
			)}
			<Field
				field="reason"
				label="Reason (optional; required to cancel right now)"
			>
				{(id) => (
					<textarea
						id={id}
						data-test="modal-field"
						data-field="reason"
						value={reason}
						onInput={(event) => setReason(event.currentTarget.value)}
					/>
				)}
			</Field>
		</ModalFrame>
	);
}

function ResumeModal({ context }: { context: ModalContext }): JSX.Element {
	const { write, member } = context;
	const { busy, submit } = useSubmit(context);
	return (
		<ModalFrame
			title={
				<>
					<Icon name="undo" /> Resume membership · {write.person.name}
				</>
			}
			subtitle={member ? `${member.tierName} ×${member.quantity}` : undefined}
			confirm={{
				label: "Resume",
				tone: "p",
				disabled: member === null,
				onConfirm: () => {
					if (member) submit(() => resumeMembership(write, member));
				},
			}}
			cancelLabel="Not now"
			busy={busy}
			onCancel={context.onCancel}
		>
			<div class="prev" data-test="modal-body">
				Billing continues on {write.renewal} as normal. Nothing is charged
				today.
			</div>
		</ModalFrame>
	);
}

function RoleModal({
	context,
	change,
}: {
	context: ModalContext;
	change: RoleChange;
}): JSX.Element {
	const { write } = context;
	const { busy, submit } = useSubmit(context);
	const { person } = write;
	const texts = roleTexts(change, person, write.schoolName);
	return (
		<ModalFrame
			title={
				<>
					<Icon name="key" /> {texts.title}
				</>
			}
			preview={
				<>
					<Icon name="clock" /> This applies at {person.name}'s next sign-in
					refresh. Their access token lasts 5 minutes, so it can take up to 5
					minutes to show.
				</>
			}
			previewHook="modal-note"
			confirm={{
				label: "Confirm",
				tone: "p",
				disabled: false,
				onConfirm: () => submit(() => changeRole(write, change)),
			}}
			busy={busy}
			onCancel={context.onCancel}
		>
			<p class="mut" data-test="modal-body">
				{texts.body}
			</p>
		</ModalFrame>
	);
}

const auditFailedText = "Could not run the audit. Try again.";
const reportFailedToast = "Could not save the report. Try again.";

/** The audit of one person: the server's steps in order, then its verdict. Until the server answers there is only a
 * loading line, never a verdict; if it fails, the modal says so. */
function AuditModal({ context }: { context: ModalContext }): JSX.Element {
	const { write, readAudit, saveReport, onToast } = context;
	const [audit, setAudit] = useState<MemberAudit | "failed" | null>(null);
	const [saving, setSaving] = useState(false);
	useEffect(() => {
		let current = true;
		readAudit().then(
			(read) => {
				if (current) setAudit(read);
			},
			() => {
				if (current) setAudit("failed");
			},
		);
		return () => {
			current = false;
		};
	}, [readAudit]);
	const exportReport = async (): Promise<void> => {
		if (audit === null || audit === "failed") return;
		setSaving(true);
		try {
			await saveReport({
				name: audit.reportFileName,
				type: jsonMediaType,
				text: JSON.stringify(audit, null, 2),
			});
			onToast(`${audit.reportFileName} downloaded.`);
		} catch {
			onToast(reportFailedToast);
		}
		setSaving(false);
	};
	const read = audit === null || audit === "failed" ? null : audit;
	return (
		<ModalFrame
			title={
				<>
					<Icon name="check" /> Audit {write.person.name}
				</>
			}
			subtitle="Replays the event log and compares it with the live balance and Stripe"
			preview={
				read ? (
					<>
						<b class={read.clean ? "ok" : "err"}>
							{read.clean ? "Clean." : "1 problem."}
						</b>{" "}
						{read.verdict}
					</>
				) : undefined
			}
			previewHook="modal-preview"
			{...(read && {
				confirm: {
					label: "Export report",
					tone: "",
					icon: "download",
					disabled: false,
					onConfirm: exportReport,
				},
			})}
			cancelLabel="Close"
			busy={saving}
			onCancel={context.onCancel}
		>
			{audit === null && (
				<p class="mut" data-test="audit-loading" aria-live="polite">
					Replaying the log…
				</p>
			)}
			{audit === "failed" && (
				<p class="err" data-test="audit-failed" role="alert">
					{auditFailedText}
				</p>
			)}
			{read && (
				<ul class="steps">
					{read.steps.map((step, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: the steps are the server's ordered list; two may read alike
						<li key={index}>
							<span class={step.ok ? "ok" : "no"}>
								<Icon name={step.ok ? "check" : "xCircle"} />
							</span>
							<span>{step.text}</span>
						</li>
					))}
				</ul>
			)}
		</ModalFrame>
	);
}

/** The modal for one action on one person. `bookingOf` finds the booking the action names. */
export function ActionModal({
	action,
	context,
	onPick,
}: {
	action: Action;
	context: ModalContext;
	onPick: (booking: MemberBooking) => void;
}): JSX.Element | null {
	const bookingOf = (id: string): MemberBooking | undefined =>
		context.detail.bookings.find((booking) => booking.id === id);
	switch (action.kind) {
		case "role":
			return <RoleModal context={context} change={action.change} />;
		case "adjust":
			return <AdjustModal context={context} />;
		case "invoice":
			return <InvoiceModal context={context} />;
		case "refund":
			return <RefundModal context={context} bookingId={action.bookingId} />;
		case "pick":
			return <PickModal context={context} onPick={onPick} />;
		case "switch":
			return <SwitchModal context={context} />;
		case "cancel":
			return <CancelModal context={context} />;
		case "resume":
			return <ResumeModal context={context} />;
		case "audit":
			return <AuditModal context={context} />;
		case "release": {
			const booking = bookingOf(action.bookingId);
			return booking ? (
				<ReleaseHoldModal context={context} booking={booking} />
			) : null;
		}
		case "noshow": {
			const booking = bookingOf(action.bookingId);
			return booking ? (
				<NoShowModal context={context} booking={booking} />
			) : null;
		}
	}
}
