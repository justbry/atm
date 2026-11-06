import type { JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import {
	type Menu,
	type MenuAddon,
	type MenuAudience,
	type MenuGrant,
	type MenuInterval,
	type MenuTier,
	planLimits,
} from "../data/plans.ts";
import type { School } from "../data/types.ts";
import { useFocusTrap } from "./focus-trap.ts";
import { Icon } from "./icon.tsx";
import {
	audienceName,
	currencySymbol,
	monthlyAmount,
	type PlanKind,
	problems,
	slug,
	tierAudience,
	unitWords,
	withAddon,
	withTier,
	yearlyAmount,
} from "./plans-menu.ts";
import { exitPreviewTitle } from "./view-as.ts";

const audienceHint =
	"What members of this plan see of the school's books. Member: quarters, money rounded, totals and categories. Governance: months, exact, with plan and fund breakdowns and how gifts spread, but no names. Public: nothing beyond what anyone sees. A governance plan is usually hidden (not for sale) and given by the owner. Finance and Owner are never a tier's audience. Access moves at once for current members, with a notice.";
const centsPerUnit = 100;
const defaultGrantAmount = 8;
const audienceChoices: Array<[MenuAudience, string]> = [
	["member", `${audienceName.member} (default)`],
	["governance", audienceName.governance],
	["public", audienceName.public],
];
const intervalChoices = ["month", "year"] as const;
const intervalLabels: Record<MenuInterval, string> = {
	month: "Each month",
	year: "Each year",
};
const charges = ["once", "month", "year"] as const;
type Charge = (typeof charges)[number];
const chargeLabels: Record<Charge, string> = {
	once: "One time",
	month: "Monthly",
	year: "Yearly",
};
const audienceChoice = (value: string): MenuAudience =>
	audienceChoices.find(([choice]) => choice === value)?.[0] ?? "member";
const chargeChoice = (value: string): Charge =>
	charges.find((choice) => choice === value) ?? "once";

/** What the fields hold as typed: amounts in major units, sizes as "1, 2, 4". */
type GrantForm = {
	featureId: string;
	amount: string;
	every: MenuInterval;
	rollover: string;
	/** Stored, not offered: kept as it was. */
	max: number | undefined;
};
type PlanForm = {
	name: string;
	blurb: string;
	isPublic: boolean;
	audience: MenuAudience;
	month: string;
	year: string;
	quantities: string;
	price: string;
	charge: Charge;
	grants: GrantForm[];
};

const majorText = (cents: number | undefined): string =>
	cents ? String(cents / centsPerUnit) : "";
const grantForm = (grant: MenuGrant): GrantForm => ({
	featureId: grant.featureId,
	amount: String(grant.amount),
	every: grant.every,
	rollover: String(grant.rollover?.months ?? 0),
	max: grant.rollover?.max,
});

function formOf(
	item: MenuTier | MenuAddon | null,
	kind: PlanKind,
	menu: Menu,
): PlanForm {
	const blank: PlanForm = {
		name: "",
		blurb: "",
		isPublic: true,
		audience: "member",
		month: "",
		year: "",
		quantities: "",
		price: "",
		charge: "once",
		grants: [
			grantForm({
				featureId: menu.features[0]?.id ?? "",
				amount: defaultGrantAmount,
				every: "month",
			}),
		],
	};
	if (kind === "tiers" && item && "prices" in item)
		return {
			...blank,
			name: item.name,
			blurb: item.blurb,
			isPublic: item.public,
			audience: tierAudience(item),
			month: majorText(monthlyAmount(item)),
			year: majorText(yearlyAmount(item)),
			quantities: item.quantities?.join(", ") ?? "",
			grants: item.grants.map(grantForm),
		};
	if (item && "price" in item)
		return {
			...blank,
			name: item.name,
			price: majorText(item.price.amount),
			charge: item.price.every,
			grants: item.grants.map(grantForm),
		};
	return blank;
}

const wholeNumber = (text: string): number => Number.parseInt(text, 10) || 0;
const cents = (text: string): number =>
	Math.round((Number.parseFloat(text) || 0) * centsPerUnit);
/** Mockup `readPE`: sizes that are not numbers become 0, which the problems then name. */
function sizesOf(text: string): number[] | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	const sizes = trimmed
		.split(",")
		.map((size) => Number.parseInt(size.trim(), 10));
	return sizes.some(Number.isNaN) ? [0] : sizes;
}

function grantsOf(form: PlanForm): MenuGrant[] {
	return form.grants.map((grant) => {
		const months = wholeNumber(grant.rollover);
		return {
			featureId: grant.featureId,
			amount: wholeNumber(grant.amount),
			every: grant.every,
			...(months > 0
				? {
						rollover: {
							months,
							...(grant.max === undefined ? {} : { max: grant.max }),
						},
					}
				: {}),
		};
	});
}

function tierOf(form: PlanForm, id: string): MenuTier {
	const month = cents(form.month);
	const year = cents(form.year);
	const sizes = sizesOf(form.quantities);
	return {
		id,
		name: form.name,
		blurb: form.blurb,
		public: form.isPublic,
		prices: [
			...(month === 0 ? [] : [{ interval: "month" as const, amount: month }]),
			...(year > 0 ? [{ interval: "year" as const, amount: year }] : []),
		],
		grants: grantsOf(form),
		...(sizes ? { quantities: sizes } : {}),
		...(form.audience === "member" ? {} : { audience: form.audience }),
	};
}

const addonOf = (form: PlanForm, id: string): MenuAddon => ({
	id,
	name: form.name,
	price: { amount: cents(form.price), every: form.charge },
	grants: grantsOf(form),
});

type PlanDrawerProps = {
	school: School;
	/** The draft the plan is part of. */
	menu: Menu;
	kind: PlanKind;
	/** The plan being edited, or null for a new one. */
	item: MenuTier | MenuAddon | null;
	/** The tier's active members, for the subtitle; null for a new plan or a pack. */
	activeMembers: number | null;
	/** An audience other than your own is shown: Save is off. */
	preview: boolean;
	onSave: (menu: Menu) => void;
	onClose: () => void;
};

/** The plan editor (mockup `#pe`, `drawPE`, `readPE`, `savePE`): one membership or pack of the draft. Save to draft hands
 * back the whole menu with the plan replaced (or added, its id from its name); it stays off while the menu has problems. */
export function PlanDrawer({
	school,
	menu,
	kind,
	item,
	activeMembers,
	preview,
	onSave,
	onClose,
}: PlanDrawerProps): JSX.Element {
	const [form, setForm] = useState(() => formOf(item, kind, menu));
	const tier = kind === "tiers";
	const drawer = useRef<HTMLElement>(null);
	const nameField = useRef<HTMLInputElement>(null);
	const ids = {
		title: useId(),
		name: useId(),
		blurb: useId(),
		audience: useId(),
		month: useId(),
		year: useId(),
		sizes: useId(),
		price: useId(),
		charge: useId(),
		grants: useId(),
	};
	useFocusTrap(true, drawer, onClose);
	useEffect(() => {
		const opener = document.activeElement;
		nameField.current?.focus();
		return () => {
			if (opener instanceof HTMLElement) opener.focus();
		};
	}, []);

	const id = item?.id ?? (slug(form.name) || "new");
	const edited = tier ? tierOf(form, id) : addonOf(form, id);
	const replaces = item?.id ?? null;
	const candidate =
		"prices" in edited
			? withTier(menu, edited, replaces)
			: withAddon(menu, edited, replaces);
	const found = problems(candidate);
	const symbol = currencySymbol(menu.currency);
	const unit = unitWords(menu, form.grants[0]?.featureId ?? "");
	const sized = sizesOf(form.quantities) !== undefined;
	const change = (patch: Partial<PlanForm>): void =>
		setForm((before) => ({ ...before, ...patch }));
	const changeGrant = (index: number, patch: Partial<GrantForm>): void =>
		setForm((before) => ({
			...before,
			grants: before.grants.map((grant, at) =>
				at === index ? { ...grant, ...patch } : grant,
			),
		}));
	const heading =
		item === null ? `New ${tier ? "membership" : "pack"}` : item.name;
	const packOnce = !tier && form.charge === "once";

	return (
		<aside
			ref={drawer}
			class="drawer on"
			id="pe"
			role="dialog"
			aria-modal="true"
			aria-labelledby={ids.title}
			data-test="plan-drawer"
		>
			<button
				type="button"
				class="x"
				aria-label="Close"
				data-test="plan-drawer-close"
				onClick={onClose}
			>
				×
			</button>
			<h3 id={ids.title} data-test="plan-drawer-title">
				<Icon name={tier ? "layers" : "gift"} /> {heading}
			</h3>
			<div class="mut" data-test="plan-drawer-sub">
				{school.name} · editing the draft
				{activeMembers !== null &&
					` · ${activeMembers} active member${activeMembers === 1 ? "" : "s"}`}
			</div>
			<div class="fld">
				<label for={ids.name}>Name</label>
				<input
					ref={nameField}
					id={ids.name}
					type="text"
					data-test="plan-field"
					data-field="name"
					value={form.name}
					onInput={(event) => change({ name: event.currentTarget.value })}
				/>
			</div>
			{tier && (
				<div class="fld">
					<label for={ids.blurb}>Description</label>
					<input
						id={ids.blurb}
						type="text"
						data-test="plan-field"
						data-field="blurb"
						value={form.blurb}
						onInput={(event) => change({ blurb: event.currentTarget.value })}
					/>
				</div>
			)}
			{tier && (
				<div class="fld c">
					<label>
						<input
							type="checkbox"
							data-test="plan-field"
							data-field="public"
							checked={form.isPublic}
							onChange={(event) =>
								change({ isPublic: event.currentTarget.checked })
							}
						/>{" "}
						On sale (public). Hidden plans can't be bought; current members keep
						them.
					</label>
				</div>
			)}
			{tier && (
				<div class="fld">
					<label for={ids.audience}>Audience</label>
					<select
						id={ids.audience}
						data-test="plan-field"
						data-field="audience"
						value={form.audience}
						onInput={(event) =>
							change({ audience: audienceChoice(event.currentTarget.value) })
						}
					>
						{audienceChoices.map(([choice, label]) => (
							<option key={choice} value={choice}>
								{label}
							</option>
						))}
					</select>
					<div class="kbhint" data-test="plan-drawer-hint">
						{audienceHint}
					</div>
				</div>
			)}
			{tier ? (
				<>
					<div class="two">
						<div class="fld">
							<label for={ids.month}>
								Monthly price ({symbol}
								{sized ? `, per ${unit.one}` : ""})
							</label>
							<input
								id={ids.month}
								type="number"
								step="0.01"
								data-test="plan-field"
								data-field="month"
								value={form.month}
								onInput={(event) =>
									change({ month: event.currentTarget.value })
								}
							/>
						</div>
						<div class="fld">
							<label for={ids.year}>Yearly price (optional)</label>
							<input
								id={ids.year}
								type="number"
								step="0.01"
								data-test="plan-field"
								data-field="year"
								value={form.year}
								onInput={(event) => change({ year: event.currentTarget.value })}
							/>
						</div>
					</div>
					<div class="fld">
						<label for={ids.sizes}>
							Sold in sizes (optional, for example 1, 2, 4). Prices and amounts
							are then per {unit.one}.
						</label>
						<input
							id={ids.sizes}
							type="text"
							placeholder="One size"
							data-test="plan-field"
							data-field="quantities"
							value={form.quantities}
							onInput={(event) =>
								change({ quantities: event.currentTarget.value })
							}
						/>
					</div>
				</>
			) : (
				<div class="two">
					<div class="fld">
						<label for={ids.price}>Price ({symbol})</label>
						<input
							id={ids.price}
							type="number"
							step="0.01"
							data-test="plan-field"
							data-field="price"
							value={form.price}
							onInput={(event) => change({ price: event.currentTarget.value })}
						/>
					</div>
					<div class="fld">
						<label for={ids.charge}>Charged</label>
						<select
							id={ids.charge}
							data-test="plan-field"
							data-field="every"
							value={form.charge}
							onInput={(event) =>
								change({ charge: chargeChoice(event.currentTarget.value) })
							}
						>
							{charges.map((choice) => (
								<option key={choice} value={choice}>
									{chargeLabels[choice]}
								</option>
							))}
						</select>
					</div>
				</div>
			)}
			<h5>
				<Icon name="ticket" /> What members get
			</h5>
			{form.grants.map((grant, index) => {
				const fieldId = (field: string): string =>
					`${ids.grants}-${index}-${field}`;
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: a grant has no identity beyond its place in the list
					<div class="gr" key={index} data-test="plan-grant">
						<div>
							<label class="mut grant-label" for={fieldId("amount")}>
								Amount
							</label>
							<input
								id={fieldId("amount")}
								type="number"
								data-test="plan-grant-field"
								data-field="amount"
								data-index={index}
								value={grant.amount}
								onInput={(event) =>
									changeGrant(index, { amount: event.currentTarget.value })
								}
							/>
						</div>
						<div>
							<label class="mut grant-label" for={fieldId("unit")}>
								{menu.features.find(
									({ id: featureId }) => featureId === grant.featureId,
								)?.name ?? grant.featureId}
							</label>
							<input
								id={fieldId("unit")}
								type="text"
								disabled
								data-test="plan-grant-field"
								data-field="unit"
								data-index={index}
								value={unitWords(menu, grant.featureId).other}
							/>
						</div>
						<div>
							<label class="mut grant-label" for={fieldId("every")}>
								How often
							</label>
							<select
								id={fieldId("every")}
								disabled={packOnce}
								data-test="plan-grant-field"
								data-field="every"
								data-index={index}
								value={packOnce ? "once" : grant.every}
								onInput={(event) =>
									changeGrant(index, {
										every:
											event.currentTarget.value === "year" ? "year" : "month",
									})
								}
							>
								{packOnce ? (
									<option value="once">Once</option>
								) : (
									intervalChoices.map((interval) => (
										<option key={interval} value={interval}>
											{intervalLabels[interval]}
										</option>
									))
								)}
							</select>
						</div>
						<div>
							<label class="mut grant-label" for={fieldId("rollover")}>
								Rolls over (mo)
							</label>
							<input
								id={fieldId("rollover")}
								type="number"
								min="0"
								data-test="plan-grant-field"
								data-field="rollover"
								data-index={index}
								value={grant.rollover}
								onInput={(event) =>
									changeGrant(index, { rollover: event.currentTarget.value })
								}
							/>
						</div>
						<button
							type="button"
							class="btn ico s"
							aria-label="Remove grant"
							title={preview ? exitPreviewTitle : "Remove"}
							data-test="plan-grant-remove"
							disabled={preview || form.grants.length < 2}
							onClick={() =>
								setForm((before) => ({
									...before,
									grants: before.grants.filter((_, at) => at !== index),
								}))
							}
						>
							<Icon name="trash" />
						</button>
					</div>
				);
			})}
			<div class="grant-add">
				<button
					type="button"
					class="btn s"
					data-test="plan-grant-add"
					title={preview ? exitPreviewTitle : undefined}
					disabled={preview || form.grants.length >= planLimits.grants}
					onClick={() =>
						setForm((before) => ({
							...before,
							grants: [
								...before.grants,
								grantForm({
									featureId: menu.features[0]?.id ?? "",
									amount: defaultGrantAmount,
									every: "month",
								}),
							],
						}))
					}
				>
					<Icon name="plus" />
					Add another
				</button>{" "}
				<span class="mut" data-test="plan-drawer-note">
					A cap on rollover isn't enforced yet, so it isn't offered.
				</span>
			</div>
			{found.length > 0 && (
				<div class="prev drawer-problems">
					{found.map((problem) => (
						<div class="err" key={problem} data-test="plan-drawer-problem">
							<Icon name="alert" /> {problem}
						</div>
					))}
				</div>
			)}
			<div class="mf">
				<button
					type="button"
					class="btn"
					data-test="plan-drawer-cancel"
					onClick={onClose}
				>
					Cancel
				</button>
				<button
					type="button"
					class="btn p"
					data-test="plan-drawer-save"
					title={preview ? exitPreviewTitle : undefined}
					disabled={preview || found.length > 0}
					onClick={() => onSave(candidate)}
				>
					<Icon name="check" />
					Save to draft
				</button>
			</div>
		</aside>
	);
}
