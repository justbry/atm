import type { ComponentChildren, JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import {
	embedAllowedSitesDefault,
	embedBooksAudienceLabels,
	embedSnippets,
	type PortalAudience,
	type PortalMember,
	type SiteTheme,
} from "../data/portal.ts";
import type { School } from "../data/types.ts";
import { useFocusTrap } from "./focus-trap.ts";
import { Icon } from "./icon.tsx";
import { count, money, type Plan } from "./portal-format.ts";

type DialogProps = {
	/** "Change amount · Dana W.". */
	title: ComponentChildren;
	/** The line under the title. */
	detail: string;
	children: ComponentChildren;
	footer: ComponentChildren;
	onClose: () => void;
};

/** The mockup's modal (`#md`) for the portal's four dialogs: title, a line under it, the body, the buttons. Escape, a
 * click on the backdrop and the button marked `data-autofocus` (Cancel, Done) close it; Tab stays inside; focus starts
 * on that button (without scrolling the dialog to it) and returns to the one that opened the dialog. */
function PortalDialog({
	title,
	detail,
	children,
	footer,
	onClose,
}: DialogProps): JSX.Element {
	const modal = useRef<HTMLDivElement>(null);
	const titleId = useId();
	useFocusTrap(true, modal, onClose);
	useEffect(() => {
		const opener = document.activeElement;
		modal.current
			?.querySelector<HTMLElement>("[data-autofocus]")
			?.focus({ preventScroll: true });
		return () => {
			if (opener instanceof HTMLElement) opener.focus();
		};
	}, []);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: Escape closes the dialog (useFocusTrap); a click on the backdrop is a pointer shortcut for the same
		<div
			class="bg on"
			role="presentation"
			onClick={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div
				ref={modal}
				class="modal"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				data-test="dialog"
			>
				<h3 id={titleId} data-test="dialog-title">
					{title}
				</h3>
				<div class="mut">{detail}</div>
				{children}
				<div class="mf">{footer}</div>
			</div>
		</div>
	);
}

type DialogContext = {
	school: School;
	viewed: PortalMember;
	plan: Plan;
	onClose: () => void;
};

/** Change amount (mockup `vAct('qty')`): the amounts the plan is sold in, and what choosing one does. A decrease
 * waits for the renewal; the price of an increase and what it grants now are the server's, so the preview names only
 * the price from the renewal on. */
export function QuantityDialog({
	school,
	viewed,
	plan,
	onClose,
	onConfirm,
}: DialogContext & { onConfirm: (quantity: number) => void }): JSX.Element {
	const [chosen, setChosen] = useState(plan.quantity);
	const selectId = useId();
	const options = viewed.quantityOptions ?? [];
	const price = money(
		options.find((option) => option.quantity === chosen)?.priceCents ?? 0,
		school.currency,
	);
	const unit = school.creditUnit.other;
	let preview: JSX.Element | string = "No change.";
	if (chosen < plan.quantity)
		preview = (
			<>
				From {plan.endsOn}: <b>{price}</b> / month with fewer {unit} each month.{" "}
				<b>No refund</b>, and {unit} now are unchanged until then.
			</>
		);
	else if (chosen > plan.quantity)
		preview = (
			<>
				The difference is charged now, prorated by the school's billing. From{" "}
				{plan.endsOn}: <b>{price}</b> / month.
			</>
		);
	return (
		<PortalDialog
			title={
				<>
					<Icon name="sliders" /> Change amount · {viewed.name}
				</>
			}
			detail={`${viewed.tierName} · now ×${plan.quantity}`}
			onClose={onClose}
			footer={
				<>
					<button
						type="button"
						class="btn"
						data-test="dialog-cancel"
						data-autofocus
						onClick={onClose}
					>
						Cancel
					</button>
					<button
						type="button"
						class="btn p"
						data-test="dialog-confirm"
						disabled={chosen === plan.quantity}
						onClick={() => onConfirm(chosen)}
					>
						Confirm
					</button>
				</>
			}
		>
			<div class="fld">
				<label for={selectId}>New amount</label>
				<select
					id={selectId}
					data-test="quantity-select"
					value={chosen}
					onInput={(event) => setChosen(Number(event.currentTarget.value))}
				>
					{options.map(({ quantity }) => (
						<option key={quantity} value={quantity}>
							{quantity}
							{quantity === plan.quantity ? " (current)" : ""}
						</option>
					))}
				</select>
			</div>
			<div class="prev" data-test="dialog-preview">
				{preview}
			</div>
		</PortalDialog>
	);
}

/** Cancel membership (mockup `vAct('cancel')`): a member cancels at the end of the period only; the reason is
 * optional and travels only when it has text. */
export function CancelDialog({
	viewed,
	plan,
	onClose,
	onConfirm,
}: DialogContext & { onConfirm: (reason: string) => void }): JSX.Element {
	const [reason, setReason] = useState("");
	const reasonId = useId();
	const left = viewed.balances
		.map((balance) => count(balance.available, balance.unit))
		.join(" and ");
	return (
		<PortalDialog
			title={
				<>
					<Icon name="ban" /> Cancel membership · {viewed.name}
				</>
			}
			detail={plan.label}
			onClose={onClose}
			footer={
				<>
					<button
						type="button"
						class="btn"
						data-test="dialog-cancel"
						data-autofocus
						onClick={onClose}
					>
						Keep membership
					</button>
					<button
						type="button"
						class="btn d"
						data-test="dialog-confirm"
						onClick={() => onConfirm(reason.trim())}
					>
						Cancel membership
					</button>
				</>
			}
		>
			<div class="fld c">
				<label>
					<input type="radio" name="cancel-when" checked /> At the end of this
					period ({plan.endsOn})
				</label>
			</div>
			<div class="fld">
				<label for={reasonId}>
					Reason (optional; required to cancel right now)
				</label>
				<textarea
					id={reasonId}
					data-test="cancel-reason"
					value={reason}
					onInput={(event) => setReason(event.currentTarget.value)}
				/>
			</div>
			<div class="prev" data-test="dialog-preview">
				Stays active until {plan.endsOn}. {left} can still be used until then.
				No further charges.
			</div>
		</PortalDialog>
	);
}

/** Resume membership (mockup `vAct('resume')`). */
export function ResumeDialog({
	viewed,
	plan,
	onClose,
	onConfirm,
}: DialogContext & { onConfirm: () => void }): JSX.Element {
	return (
		<PortalDialog
			title={
				<>
					<Icon name="undo" /> Resume membership · {viewed.name}
				</>
			}
			detail={plan.label}
			onClose={onClose}
			footer={
				<>
					<button
						type="button"
						class="btn"
						data-test="dialog-cancel"
						data-autofocus
						onClick={onClose}
					>
						Not now
					</button>
					<button
						type="button"
						class="btn p"
						data-test="dialog-confirm"
						onClick={onConfirm}
					>
						Resume
					</button>
				</>
			}
		>
			<div class="prev" data-test="dialog-preview">
				Billing continues on {plan.endsOn} as normal. Nothing is charged today.
			</div>
		</PortalDialog>
	);
}

const audienceOrder = Object.keys(embedBooksAudienceLabels) as PortalAudience[];
const embedPublicAudience: PortalAudience = "public";

/** The embed modal (mockup `embedModal`): the three steps for the host page, the theme picked in the preview as the
 * CSS the page sets, and the public school-books document, the only one that may be embedded. */
export function EmbedDialog({
	school,
	theme,
	publicYear,
	onClose,
	onCopy,
}: {
	school: School;
	theme: SiteTheme;
	publicYear: string;
	onClose: () => void;
	onCopy: (snippet: string) => void;
}): JSX.Element {
	const snippets = embedSnippets(school.name, theme, publicYear);
	const originsId = useId();
	const audienceId = useId();
	return (
		<PortalDialog
			title={
				<>
					<Icon name="plug" /> Embed the member portal{" "}
					<span class="badge b-warn">Proposed</span>
				</>
			}
			detail={`${school.name} · the portal you are viewing, on your own site`}
			onClose={onClose}
			footer={
				<>
					<button
						type="button"
						class="btn"
						data-test="embed-copy"
						onClick={() => onCopy(snippets.page)}
					>
						<Icon name="copy" />
						Copy snippet
					</button>
					<button
						type="button"
						class="btn p"
						data-test="embed-done"
						data-autofocus
						onClick={onClose}
					>
						Done
					</button>
				</>
			}
		>
			<h5>1. Add it to your page</h5>
			<div class="pre" data-test="embed-snippet" data-step="page">
				{snippets.page}
			</div>
			<h5>2. Mint a session on your server</h5>
			<div class="pre" data-test="embed-snippet" data-step="server">
				{snippets.server}
			</div>
			<h5>3. Match your site</h5>
			<div class="mut" style="margin-bottom:4px">
				With <span class="mono">data-theme="inherit"</span> the portal reads
				these from your page. This is the theme you picked:
			</div>
			<div class="pre" data-test="embed-snippet" data-step="theme">
				{snippets.theme}
			</div>
			<div class="fld">
				<label for={originsId}>Allowed sites (sets frame-ancestors)</label>
				<input
					id={originsId}
					type="text"
					data-test="embed-origins"
					value={embedAllowedSitesDefault}
				/>
			</div>
			<div class="prev">
				<Icon name="info" /> Sign-in is yours: your server proves who the member
				is with a secret key and gets a short-lived token. Changes run in the
				family service, the same as here. Card changes hand off to Stripe. Tier
				switches stay admin-only until atm and the Stripe portal support them.
			</div>
			<h5>
				<Icon name="scale" /> School books on your site
			</h5>
			<div class="fld">
				<label for={audienceId}>Document</label>
				<select
					id={audienceId}
					data-test="embed-books-audience"
					value={embedPublicAudience}
				>
					{audienceOrder.map((audience) => (
						<option
							key={audience}
							value={audience}
							disabled={audience !== embedPublicAudience}
						>
							{embedBooksAudienceLabels[audience]}
						</option>
					))}
				</select>
			</div>
			<div class="pre" data-test="embed-snippet" data-step="books">
				{snippets.books}
			</div>
			<div class="note">
				<Icon name="alert" />
				<span>
					Only the public document may be embedded. Member, governance and
					finance figures need a signed-in session (
					<span class="mono">Cache-Control: private, no-store</span>) and are
					never embeddable; the embedded portal leaves the School books card
					out.
				</span>
			</div>
		</PortalDialog>
	);
}
