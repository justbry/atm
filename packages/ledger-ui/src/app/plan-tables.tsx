import type { JSX } from "preact";
import {
	type Menu,
	type MenuAddon,
	type MenuTier,
	type PlanSummary,
	type PlanTierCount,
	planLimits,
} from "../data/plans.ts";
import { Icon } from "./icon.tsx";
import { formatMoney } from "./money.ts";
import {
	audienceName,
	grantText,
	monthlyAmount,
	type PlanKind,
	type PlansView,
	priceText,
	tierAudience,
	tierCount,
} from "./plans-menu.ts";
import { exitPreviewTitle } from "./viewing.ts";

/** cell-rules `minContributors`: under this many payers a per-plan count shows as <10 and a per-plan amount is hidden. */
const minimumContributors = 5;
export const financeOnlyText = "Finance or governance only";
const governanceUpText = "Governance and up see this";

/** A figure the audience may not see, with why (mockup `kFigHtml`). */
export function Withheld({ text }: { text: string }): JSX.Element {
	return (
		<span class="khid" data-test="plan-hid" data-hid="no_grant" title={text}>
			<Icon name="lock" />
			{text}
		</span>
	);
}

/** A membership's Members and Monthly cells for the audience (mockup `cntC`, `revC`): exact for owner and finance
 * admins, banded for governance, withheld below. Monthly is the draft's monthly price times the active units. */
function tierFigures(
	view: PlansView,
	menu: Menu,
	tier: MenuTier,
	count: PlanTierCount,
	onMembers: () => void,
): { members: JSX.Element; monthly: JSX.Element } {
	const monthly = formatMoney(
		(monthlyAmount(tier) ?? 0) * count.activeUnits,
		menu.currency,
	);
	if (view.finance)
		return {
			members: (
				<>
					<button
						type="button"
						class="link"
						data-test="plan-members"
						title="Show these members"
						onClick={(event) => {
							event.stopPropagation();
							onMembers();
						}}
					>
						{count.active}
					</button>
					{count.ending > 0 && (
						<span class="mut" data-test="plan-ending">
							{" "}
							+{count.ending} ending
						</span>
					)}
				</>
			),
			monthly: <span data-test="plan-monthly">{monthly}</span>,
		};
	if (view.audience === "governance") {
		const few = count.active > 0 && count.active < minimumContributors;
		return {
			members: (
				<span data-test="plan-members">
					{few ? (
						<span
							class="kapprox"
							data-test="plan-hid"
							data-hid="approx"
							title={`Rounded to the nearest 10: fewer than ${minimumContributors} members`}
						>
							&lt;10
						</span>
					) : (
						count.active
					)}
				</span>
			),
			monthly: (
				<span data-test="plan-monthly">
					{few ? (
						<span
							class="kcutv"
							data-test="plan-hid"
							data-hid="suppressed"
							title={`Hidden: fewer than ${minimumContributors} payers`}
						>
							—
						</span>
					) : (
						monthly
					)}
				</span>
			),
		};
	}
	const text = view.audience === "admin" ? financeOnlyText : governanceUpText;
	return {
		members: (
			<span data-test="plan-members">
				<Withheld text={text} />
			</span>
		),
		monthly: (
			<span data-test="plan-monthly">
				<Withheld text={text} />
			</span>
		),
	};
}

function grantsCell(
	menu: Menu,
	item: MenuTier | MenuAddon,
	options: { perUnit: boolean; once: boolean },
): JSX.Element {
	return (
		<td data-test="plan-grants">
			{item.grants.map((grant, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a grant has no identity beyond its place in the list
				<span key={index}>
					{index > 0 && <br />}
					{grantText(menu, grant, options)}
				</span>
			))}
		</td>
	);
}

const draftBadge = (
	<>
		{" "}
		<span class="badge b-warn" data-test="plan-changed">
			draft
		</span>
	</>
);

function EditButton({
	name,
	onOpen,
}: {
	name: string;
	onOpen: () => void;
}): JSX.Element {
	return (
		<button
			type="button"
			class="btn ico s"
			data-test="plan-edit"
			aria-label={`Edit ${name}`}
			title="Edit"
			onClick={onOpen}
		>
			<Icon name="edit" />
		</button>
	);
}

type RowProps = { menu: Menu; changed: boolean; onOpen: () => void };

function TierRow({
	view,
	menu,
	tier,
	count,
	changed,
	onOpen,
	onMembers,
}: RowProps & {
	view: PlansView;
	tier: MenuTier;
	count: PlanTierCount;
	onMembers: () => void;
}): JSX.Element {
	const { members, monthly } = tierFigures(view, menu, tier, count, onMembers);
	const audience = tierAudience(tier);
	return (
		<tr
			class={changed ? "row chg" : "row"}
			data-test="plan-row"
			data-plan={tier.id}
			data-kind="tiers"
			onClick={onOpen}
		>
			<td>
				<b data-test="plan-name">{tier.name}</b>{" "}
				{!tier.public && (
					<span class="badge" data-test="plan-hidden">
						Hidden
					</span>
				)}
				{audience !== "member" && (
					<>
						{" "}
						<span
							class="badge"
							data-test="plan-audience"
							title="The audience this plan names: what its members see of the school's books"
						>
							<Icon name="scale" />
							Audience: {audienceName[audience]}
						</span>
					</>
				)}
				{changed && draftBadge}
				<div class="mut" data-test="plan-blurb">
					{tier.blurb}
				</div>
			</td>
			<td>
				<span data-test="plan-price">{priceText(menu, tier)}</span>
				{tier.quantities && (
					<div class="mut" data-test="plan-sizes">
						Sold in {tier.quantities.join(", ")}
					</div>
				)}
			</td>
			{grantsCell(menu, tier, {
				perUnit: tier.quantities !== undefined,
				once: false,
			})}
			<td class="r">{members}</td>
			<td class="r">{monthly}</td>
			<td class="r">
				<EditButton name={tier.name} onOpen={onOpen} />
			</td>
		</tr>
	);
}

function AddonRow({
	menu,
	addon,
	changed,
	onOpen,
}: RowProps & { addon: MenuAddon }): JSX.Element {
	return (
		<tr
			class={changed ? "row chg" : "row"}
			data-test="plan-row"
			data-plan={addon.id}
			data-kind="addons"
			onClick={onOpen}
		>
			<td>
				<b data-test="plan-name">{addon.name}</b>
				{changed && draftBadge}
			</td>
			<td>
				<span data-test="plan-price">{priceText(menu, addon)}</span>
			</td>
			{grantsCell(menu, addon, {
				perUnit: false,
				once: addon.price.every === "once",
			})}
			<td class="r" />
			<td class="r" />
			<td class="r">
				<EditButton name={addon.name} onOpen={onOpen} />
			</td>
		</tr>
	);
}

const emptyRow = (kind: PlanKind, text: string): JSX.Element => (
	<tr>
		<td
			colSpan={6}
			class="mut empty-row"
			data-test="plan-empty"
			data-kind={kind}
		>
			{text}
		</td>
	</tr>
);

type PlanTablesProps = {
	view: PlansView;
	/** The menu the rows are drawn from: the draft for admins, the live menu for the rest. */
	menu: Menu;
	/** The memberships listed (an audience below admin sees only some). */
	tiers: MenuTier[];
	summary: PlanSummary;
	/** Plans the draft changes (admins see them marked) and names of those it removes. */
	changedIds: ReadonlySet<string>;
	removedNames: string[];
	/** The draft already holds as many memberships or packs as the menu allows. */
	full: Record<PlanKind, boolean>;
	/** The signed-in person owns the school: admins are told that owners publish. */
	owner: boolean;
	onOpen: (kind: PlanKind, id: string | null) => void;
	onMembers: (tierId: string) => void;
};

/** Edit mode (mockup `editBody`): the memberships and the packs, each with its Add button, and the note below. */
export function PlanTables({
	view,
	menu,
	tiers,
	summary,
	changedIds,
	removedNames,
	full,
	owner,
	onOpen,
	onMembers,
}: PlanTablesProps): JSX.Element {
	const add = (kind: PlanKind, label: string): JSX.Element => (
		<div class="add-row">
			<button
				type="button"
				class="btn s"
				data-test="plan-add"
				data-kind={kind}
				title={
					view.preview
						? exitPreviewTitle
						: full[kind]
							? `Up to ${planLimits[kind]}${kind === "tiers" ? " memberships" : ""}`
							: undefined
				}
				disabled={view.preview || full[kind]}
				onClick={() => onOpen(kind, null)}
			>
				<Icon name="plus" />
				{label}
			</button>
		</div>
	);
	const them = removedNames.length === 1 ? "it" : "them";
	return (
		<>
			{removedNames.length > 0 && (
				<div class="note">
					<Icon name="alert" />
					<span data-test="plan-removed-note">
						Removed in the draft: {removedNames.join(", ")}. Publishing archives{" "}
						{them} in Stripe. Discard the draft to bring {them} back.
					</span>
				</div>
			)}
			<h5>
				<Icon name="layers" /> Memberships{" "}
				<span class="mut count" data-test="plan-count" data-kind="tiers">
					{menu.tiers.length} of {planLimits.tiers}
				</span>
			</h5>
			<table>
				<thead>
					<tr>
						<th>Plan</th>
						<th>Price</th>
						<th>Members get</th>
						<th class="r">Members</th>
						<th class="r">Monthly</th>
						<th />
					</tr>
				</thead>
				<tbody>
					{tiers.length > 0
						? tiers.map((tier) => (
								<TierRow
									key={tier.id}
									view={view}
									menu={menu}
									tier={tier}
									count={tierCount(summary, tier.id)}
									changed={view.admin && changedIds.has(tier.id)}
									onOpen={() => onOpen("tiers", tier.id)}
									onMembers={() => onMembers(tier.id)}
								/>
							))
						: emptyRow("tiers", "No memberships yet.")}
				</tbody>
			</table>
			{add("tiers", "Add membership")}
			<h5>
				<Icon name="gift" /> Packs and add-ons{" "}
				<span class="mut count" data-test="plan-count" data-kind="addons">
					{menu.addons.length} of {planLimits.addons}
				</span>
			</h5>
			<table>
				<thead>
					<tr>
						<th>Name</th>
						<th>Price</th>
						<th>Gives</th>
						<th />
						<th />
						<th />
					</tr>
				</thead>
				<tbody>
					{menu.addons.length > 0
						? menu.addons.map((addon) => (
								<AddonRow
									key={addon.id}
									menu={menu}
									addon={addon}
									changed={view.admin && changedIds.has(addon.id)}
									onOpen={() => onOpen("addons", addon.id)}
								/>
							))
						: emptyRow("addons", "None yet.")}
				</tbody>
			</table>
			{add("addons", "Add pack")}
			<p class="mut plan-note" data-test="plan-note">
				<Icon name="info" /> A change starts a new version for new purchases.
				Members keep the version they bought.
				{owner ? "" : " Admins edit the draft; owners publish."}
			</p>
		</>
	);
}
