import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import {
	type Capabilities,
	type Member,
	type MemberDetail,
	type Person,
	previewLock,
} from "../data/members.ts";
import { Icon, type IconName } from "./icon.tsx";
import {
	type Change,
	capabilityReason,
	changeWaiting,
	pendingBookingIds,
	type RoleChange,
	roleGuard,
	standingOf,
	type Viewer,
} from "./members-model.ts";
import { releasable } from "./members-writes.ts";

/** The actions of the ⋯ menu and the drawer's buttons (the golden file's `data-action`). */
export type MenuAction =
	| "view-as-member"
	| "invoice"
	| "adjust"
	| "refund"
	| "release"
	| "switch"
	| "cancel"
	| "resume"
	| "make-admin"
	| "remove-admin"
	| "remove-owner"
	| "grant-finance"
	| "revoke-finance"
	| "csv"
	| "audit"
	| "stripe"
	| "receipt";

export const roleActions: Partial<Record<MenuAction, RoleChange>> = {
	"make-admin": "make",
	"remove-admin": "remove",
	"remove-owner": "remove",
	"grant-finance": "grant",
	"revoke-finance": "revoke",
};
/** What a preview leaves on: the portal link, the CSV, Stripe and the receipt (mockup `WRITE_SEL`). */
const previewKeeps: ReadonlySet<MenuAction> = new Set([
	"view-as-member",
	"csv",
	"stripe",
	"receipt",
]);

type MenuItem = {
	action: MenuAction;
	label: string;
	icon: IconName;
	/** Why it is off, or "". */
	reason: string;
	destructive?: boolean;
	/** A hint on an item that is on. */
	hint?: string;
};

/** Everything the menu and the drawer's buttons need to know about one person. */
export type PersonContext = {
	person: Person;
	people: Person[];
	member: Member | null;
	detail: MemberDetail;
	capabilities: Capabilities;
	viewer: Viewer;
	changes: Change[];
	creditUnit: string;
};

const noPlanReason = "No plan, so there is no member portal to view";

/** The menu's items in order, `null` between groups (mockup `kMenuHtml`, `roleMenu`). Every per-member action lives
 * here; the rows and the drawer share it. */
function menuItems(context: PersonContext): Array<MenuItem | null> {
	const { person, member, capabilities, viewer, changes, detail } = context;
	const reasonOf = (reason: string, action: MenuAction): string =>
		viewer.preview && !previewKeeps.has(action) ? previewLock : reason;
	const item = (
		action: MenuAction,
		label: string,
		icon: IconName,
		reason = "",
		extra: Partial<MenuItem> = {},
	): MenuItem => ({
		action,
		label,
		icon,
		reason: reasonOf(reason, action),
		...extra,
	});
	const financeOnly = (reason: string): string =>
		viewer.finance ? reason : "Finance only";
	const items: Array<MenuItem | null> = [
		item("view-as-member", "View as member", "eye", member ? "" : noPlanReason),
	];
	if (member) {
		const standing = standingOf(member, changes);
		const waiting = changeWaiting(changes, person.id);
		const waitReason = waiting ? "A change is already on its way" : "";
		const held = releasable(detail, person, pendingBookingIds(changes)).length;
		/** The mockup's `cx`: canceled, or ending at the period's end. Resume replaces Cancel, and Switch waits. */
		const ended = standing.canceled || standing.cancelsAtPeriodEnd;
		items.push(
			null,
			item(
				"invoice",
				"Send invoice…",
				"mail",
				financeOnly(capabilityReason(capabilities, "invoice", "menu")),
			),
			item(
				"adjust",
				`Adjust ${context.creditUnit}…`,
				"sliders",
				financeOnly(capabilityReason(capabilities, "adjustCredits", "menu")),
			),
			item(
				"refund",
				"Refund a payment…",
				"undo",
				capabilityReason(capabilities, "refund", "menu"),
			),
			item(
				"release",
				"Release a booking…",
				"unlock",
				held > 0
					? capabilityReason(capabilities, "releaseBooking", "menu")
					: "No held bookings to release",
			),
			item(
				"switch",
				"Switch plan…",
				"layers",
				ended
					? "Resume the membership first"
					: waitReason || capabilityReason(capabilities, "switchTier", "menu"),
			),
			ended
				? item(
						"resume",
						"Resume membership…",
						"undo",
						waitReason ||
							capabilityReason(capabilities, "cancelMembership", "menu"),
					)
				: item(
						"cancel",
						"Cancel membership…",
						"ban",
						waitReason ||
							capabilityReason(capabilities, "cancelMembership", "menu"),
						{ destructive: true },
					),
		);
	}
	const roleItem = (
		action: MenuAction,
		label: string,
		icon: IconName,
		change: RoleChange,
		destructive = false,
	): MenuItem =>
		item(
			action,
			label,
			icon,
			roleGuard(capabilities, context.people, person, change),
			{ destructive },
		);
	items.push(null);
	if (person.role === "owner")
		items.push(
			roleItem("remove-owner", "Remove owner role", "ban", "remove", true),
		);
	else if (person.role === "admin")
		items.push(
			roleItem("remove-admin", "Remove admin", "ban", "remove", true),
			person.financeGrant
				? roleItem("revoke-finance", "Revoke finance", "coin", "revoke", true)
				: roleItem("grant-finance", "Grant finance", "coin", "grant"),
		);
	else items.push(roleItem("make-admin", "Make admin", "key", "make"));
	items.push(
		null,
		item(
			"csv",
			"Download CSV",
			"download",
			!viewer.finance
				? "Finance admins only"
				: member
					? ""
					: "No plan, so no payment history",
			{ hint: "Download this member's payment history as CSV" },
		),
	);
	if (member)
		items.push(
			null,
			item("audit", "Audit member", "check"),
			item("stripe", "View in Stripe", "ext"),
			item("receipt", "Resend receipt", "mail"),
		);
	return items;
}

/** The ⋯ button of a row or the drawer. */
export function MenuButton({
	name,
	expanded,
	onOpen,
}: {
	/** Empty in the drawer, whose heading already names the person. */
	name: string;
	expanded: boolean;
	/** `focusFirst`: opened from the keyboard, so focus moves into the menu. */
	onOpen: (button: HTMLElement, focusFirst: boolean) => void;
}): JSX.Element {
	return (
		<button
			type="button"
			class="btn ico s"
			data-test="member-menu-button"
			aria-label={name === "" ? "More actions" : `More actions for ${name}`}
			aria-haspopup="menu"
			aria-expanded={expanded}
			title="More actions"
			onClick={(event) => onOpen(event.currentTarget, event.detail === 0)}
			onKeyDown={(event) => {
				if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
				event.preventDefault();
				onOpen(event.currentTarget, true);
			}}
		>
			<Icon name="more" />
		</button>
	);
}

const compactWidth = 600;
const menuGap = 4;
const screenMargin = 8;

/** The open menu (mockup `#kmm`): arrows, Home and End move between the items that are on, Escape closes it and
 * returns focus to its button, Tab or a click elsewhere closes it. Above 600px it sits under (or over) its button;
 * below, the stylesheet makes it a sheet at the bottom. */
export function MemberMenu({
	context,
	anchor,
	focusFirst,
	onChoose,
	onClose,
}: {
	context: PersonContext;
	anchor: HTMLElement;
	focusFirst: boolean;
	onChoose: (action: MenuAction) => void;
	/** `returnFocus`: put focus back on the button. */
	onClose: (returnFocus: boolean) => void;
}): JSX.Element {
	const menu = useRef<HTMLDivElement>(null);
	const closeNow = useRef(onClose);
	closeNow.current = onClose;
	useLayoutEffect(() => {
		const element = menu.current;
		if (!element) return;
		element.style.removeProperty("top");
		element.style.removeProperty("left");
		if (window.innerWidth <= compactWidth) return;
		const button = anchor.getBoundingClientRect();
		const { offsetWidth, offsetHeight } = element;
		const below =
			button.bottom + menuGap + offsetHeight <= window.innerHeight ||
			button.top < offsetHeight + screenMargin;
		const top = below
			? button.bottom + menuGap
			: button.top - offsetHeight - menuGap;
		const left = Math.min(
			button.right - offsetWidth,
			window.innerWidth - offsetWidth - screenMargin,
		);
		element.style.top = `${Math.max(screenMargin, top)}px`;
		element.style.left = `${Math.max(screenMargin, left)}px`;
	}, [anchor]);
	useEffect(() => {
		if (focusFirst)
			menu.current
				?.querySelector<HTMLElement>("button:not([disabled])")
				?.focus();
	}, [focusFirst]);
	useEffect(() => {
		const onClick = (event: MouseEvent): void => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			/* A ⋯ button opens or closes its own menu. */
			const inside =
				menu.current?.contains(target) ||
				target.closest('[aria-haspopup="menu"]') !== null;
			if (!inside) closeNow.current(false);
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			event.stopPropagation();
			closeNow.current(true);
		};
		document.addEventListener("click", onClick);
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("click", onClick);
			document.removeEventListener("keydown", onKeyDown, true);
		};
	}, []);

	const onMenuKeyDown = (
		event: JSX.TargetedKeyboardEvent<HTMLDivElement>,
	): void => {
		if (event.key === "Tab") {
			onClose(false);
			return;
		}
		const enabled = [
			...event.currentTarget.querySelectorAll<HTMLElement>(
				"button:not([disabled])",
			),
		];
		const current = enabled.indexOf(event.target as HTMLElement);
		const targets: Record<string, number> = {
			ArrowDown: current + 1,
			ArrowUp: current - 1,
			Home: 0,
			End: -1,
		};
		const target = targets[event.key];
		if (target === undefined || enabled.length === 0) return;
		event.preventDefault();
		enabled[(target + enabled.length) % enabled.length]?.focus();
	};

	return (
		<div
			ref={menu}
			class="menu kmenu on"
			role="menu"
			aria-label="Member actions"
			data-test="member-menu"
			onKeyDown={onMenuKeyDown}
		>
			{menuItems(context).map((entry, index) =>
				entry === null ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: the separators are positions, not data
					<hr key={`rule-${index}`} />
				) : (
					<button
						key={entry.action}
						type="button"
						role="menuitem"
						tabIndex={-1}
						class={entry.destructive ? "d" : undefined}
						data-test="member-menu-item"
						data-action={entry.action}
						disabled={entry.reason !== ""}
						aria-disabled={entry.reason === "" ? undefined : "true"}
						title={entry.reason === "" ? entry.hint : entry.reason}
						onClick={() => onChoose(entry.action)}
					>
						<Icon name={entry.icon} />
						{entry.label}
					</button>
				),
			)}
		</div>
	);
}
