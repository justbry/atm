import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { Menu, MenuGrant } from "../data/plans.ts";
import { Icon } from "./icon.tsx";
import { formatMoney } from "./money.ts";
import {
	grantText,
	monthlyAmount,
	type PlanChange,
	type PlanKind,
	slug,
	yearlyAmount,
} from "./plans-menu.ts";

export type PreviewSource = "live" | "draft";

type PlanPreviewProps = {
	schoolName: string;
	/** The live version's number; 0 before the first publish. */
	version: number;
	live: Menu;
	draft: Menu;
	changes: PlanChange[];
	show: PreviewSource;
	yearly: boolean;
	onShow: (show: PreviewSource) => void;
	onBilling: (yearly: boolean) => void;
	onEdit: (kind: PlanKind, id: string) => void;
	onToast: (text: string) => void;
};

/** What one card shows of a plan, before the size picked multiplies it. */
type CardModel = {
	kind: PlanKind;
	id: string;
	name: string;
	blurb: string;
	hidden: boolean;
	/** One unit's price now, and in the live version (undefined when the plan is not live). */
	amount: number;
	publishedAmount: number | undefined;
	/** "month", "year" or "" for a pack charged once. */
	period: string;
	quantities: number[] | undefined;
	grants: MenuGrant[];
	once: boolean;
	inLive: boolean;
};

const chooseToast = "Preview only. Members would continue to Stripe Checkout.";
const liveEmpty =
	"Nothing is published yet. Switch to Draft to see what you've set up, or add a plan in Edit.";
const draftEmpty = "No plans yet. Switch to Edit to add a membership.";

/** The purchase page as members see it (mockup `planPreview`): the live plans or the draft, monthly or yearly, each
 * plan a card that opens its editor. Choose is a preview only. The sizes picked are this view's own. */
export function PlanPreview({
	schoolName,
	version,
	live,
	draft,
	changes,
	show,
	yearly,
	onShow,
	onBilling,
	onEdit,
	onToast,
}: PlanPreviewProps): JSX.Element {
	const [sizes, setSizes] = useState<Record<string, number>>({});
	const showingLive = show === "live";
	const menu = showingLive ? live : draft;
	const tiers = menu.tiers.filter((tier) => !showingLive || tier.public);
	const anyYearly = tiers.some((tier) => yearlyAmount(tier) !== undefined);
	const changedIds = new Set(changes.map(({ id }) => id));

	const models: CardModel[] = [
		...tiers.map((tier): CardModel => {
			const yearlyPrice = yearly && yearlyAmount(tier) !== undefined;
			const before = live.tiers.find(({ id }) => id === tier.id);
			const pick = yearlyPrice ? yearlyAmount : monthlyAmount;
			return {
				kind: "tiers",
				id: tier.id,
				name: tier.name,
				blurb: tier.blurb,
				hidden: !tier.public && !showingLive,
				amount: pick(tier) ?? 0,
				publishedAmount: before ? pick(before) : undefined,
				period: yearlyPrice ? "year" : "month",
				quantities: tier.quantities,
				grants: tier.grants,
				once: false,
				inLive: before !== undefined,
			};
		}),
		...menu.addons.map((addon): CardModel => {
			const before = live.addons.find(({ id }) => id === addon.id);
			return {
				kind: "addons",
				id: addon.id,
				name: addon.name,
				blurb: "",
				hidden: false,
				amount: addon.price.amount,
				publishedAmount: before?.price.amount,
				period: addon.price.every === "once" ? "" : addon.price.every,
				quantities: undefined,
				grants: addon.grants,
				once: addon.price.every === "once",
				inLive: before !== undefined,
			};
		}),
	];

	const card = (model: CardModel): JSX.Element => {
		const size = model.quantities
			? (sizes[model.id] ?? model.quantities[0] ?? 1)
			: 1;
		const price = model.amount * size;
		const publishedPrice =
			model.publishedAmount === undefined ? null : model.publishedAmount * size;
		const changed = !showingLive && changedIds.has(model.id);
		const showWas =
			changed && publishedPrice !== null && publishedPrice !== price;
		const open = (): void => onEdit(model.kind, model.id);
		return (
			// biome-ignore lint/a11y/useSemanticElements: the card holds buttons of its own (sizes, Choose), which a <button> cannot
			<div
				key={`${model.kind}:${model.id}`}
				class={`pcard${changed ? " chg" : ""}${model.hidden ? " ghost" : ""}`}
				role="button"
				tabIndex={0}
				aria-label={`Edit ${model.name}`}
				data-test="plan-card"
				data-plan={model.id}
				onClick={open}
				onKeyDown={(event) => {
					if (
						event.target === event.currentTarget &&
						(event.key === "Enter" || event.key === " ")
					) {
						event.preventDefault();
						open();
					}
				}}
			>
				<span class="ed">
					<Icon name="edit" />
				</span>
				<div class="pn">{model.name}</div>
				<div class="pvh">
					{changed && (
						<span class="badge b-warn" data-test="plan-card-flag">
							{model.inLive ? "Draft change" : "New"}
						</span>
					)}{" "}
					{model.hidden && (
						<span class="badge" data-test="plan-card-flag">
							Hidden
						</span>
					)}
				</div>
				{model.blurb && <div class="mut">{model.blurb}</div>}
				<div class="pr">
					{showWas && (
						<s data-test="plan-card-was">
							{formatMoney(publishedPrice, menu.currency)}
						</s>
					)}
					<span data-test="plan-card-price">
						{formatMoney(price, menu.currency)}
					</span>
					<small data-test="plan-card-period">
						{model.period ? `/ ${model.period}` : "one time"}
					</small>
				</div>
				{model.quantities && (
					<div class="szs">
						<small class="mut">How many</small>
						{model.quantities.map((quantity) => (
							<button
								key={quantity}
								type="button"
								class={`chip${quantity === size ? " on" : ""}`}
								aria-pressed={quantity === size}
								data-test="plan-size"
								data-plan={model.id}
								data-size={quantity}
								onClick={(event) => {
									event.stopPropagation();
									setSizes((before) => ({ ...before, [model.id]: quantity }));
								}}
							>
								{quantity}
							</button>
						))}
					</div>
				)}
				<ul>
					{model.grants.map((grant) => (
						<li
							key={`${grant.featureId}:${grant.every}:${grant.amount}`}
							data-test="plan-card-grants"
						>
							<Icon name="check" />
							{grantText(
								menu,
								grant,
								{ perUnit: false, once: model.once },
								size,
							)}
						</li>
					))}
				</ul>
				<button
					type="button"
					class="btn p go"
					tabIndex={-1}
					data-test="plan-choose"
					onClick={(event) => {
						event.stopPropagation();
						onToast(chooseToast);
					}}
				>
					Choose {model.name}
				</button>
			</div>
		);
	};

	return (
		<>
			<div class="mut preview-intro" data-test="plan-preview-intro">
				<Icon name="eye" /> How the purchase page looks at b4uni.com/join/
				{slug(schoolName)}. Click a plan to edit it.
			</div>
			<div class="pvbar">
				{/* biome-ignore lint/a11y/useSemanticElements: the mockup's segmented control is a div; a fieldset brings its own border and padding */}
				<div class="seg" role="group" aria-label="Live or draft">
					<button
						type="button"
						class={showingLive ? "on" : undefined}
						aria-pressed={showingLive}
						data-test="plan-show"
						data-show="live"
						onClick={() => onShow("live")}
					>
						Live{version > 0 ? ` v${version}` : ""}
					</button>
					<button
						type="button"
						class={showingLive ? undefined : "on"}
						aria-pressed={!showingLive}
						data-test="plan-show"
						data-show="draft"
						onClick={() => onShow("draft")}
					>
						Draft{changes.length > 0 ? ` · ${changes.length}` : ""}
					</button>
				</div>
				{/* biome-ignore lint/a11y/useSemanticElements: the mockup's segmented control is a div; a fieldset brings its own border and padding */}
				<div class="seg" role="group" aria-label="Billing period">
					<button
						type="button"
						class={yearly ? undefined : "on"}
						aria-pressed={!yearly}
						data-test="plan-billing"
						data-billing="month"
						onClick={() => onBilling(false)}
					>
						Monthly
					</button>
					<button
						type="button"
						class={yearly ? "on" : undefined}
						aria-pressed={yearly}
						disabled={!anyYearly}
						data-test="plan-billing"
						data-billing="year"
						onClick={() => onBilling(true)}
					>
						Yearly
					</button>
				</div>
			</div>
			{!showingLive && changes.length > 0 && (
				<div class="note">
					<Icon name="info" />
					<span data-test="plan-preview-note">
						Showing the draft. Members see the live version until an owner
						publishes.
					</span>
				</div>
			)}
			{models.length > 0 ? (
				<>
					{tiers.length > 0 && (
						<>
							<h5>
								<Icon name="layers" /> Memberships
							</h5>
							<div class="pgrid">
								{models.filter(({ kind }) => kind === "tiers").map(card)}
							</div>
						</>
					)}
					{menu.addons.length > 0 && (
						<>
							<h5>
								<Icon name="gift" /> Packs and add-ons
							</h5>
							<div class="pgrid">
								{models.filter(({ kind }) => kind === "addons").map(card)}
							</div>
						</>
					)}
				</>
			) : (
				<div class="card mut preview-empty" data-test="plan-preview-empty">
					{showingLive ? liveEmpty : draftEmpty}
				</div>
			)}
		</>
	);
}
