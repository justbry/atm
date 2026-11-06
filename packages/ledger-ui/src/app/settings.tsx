import type { ComponentChildren, JSX } from "preact";
import { useEffect, useId, useState } from "preact/hooks";
import {
	applyOverride,
	audienceNames,
	checkOverride,
	classOf,
	type DetailStep,
	type DisclosureChange,
	type DisclosureDelay,
	type DisclosureGrain,
	type DisclosureOverride,
	type DisclosureRule,
	disclosureCell,
	disclosureMessages,
	editOverride,
	initialOverrideSelection,
	type KpiClass,
	kpiClasses,
	kpiClassNames,
	type OverrideEdit,
	type OverrideSelection,
	type RuledAudience,
	type RuledClass,
	ruledAudiences,
} from "../data/disclosure.ts";
import type { Reader } from "../data/reader.ts";
import {
	type AccountingBasis,
	type ApiKey,
	type ApiKeyKind,
	basisExample,
	type CreatedKey,
	maxLiveKeysPerKind,
	pinMinimumLength,
	restrictedKeyMessage,
	type SchoolSettings as SettingsData,
	stripePermissions,
	zeffyKeyMinimumLength,
} from "../data/settings.ts";
import type { School } from "../data/types.ts";
import type { Writer } from "../data/writer.ts";
import { Dialog } from "./dialog.tsx";
import { Icon, type IconName } from "./icon.tsx";
import { LockPanel } from "./lock-panel.tsx";
import { monthAndDay } from "./period.ts";
import { Popover } from "./popover.tsx";
import { exitPreviewTitle, type Viewing } from "./viewing.ts";

const currencySymbols: Record<string, string> = { USD: "$", CAD: "C$" };
const minorUnitsPerUnit = 100;
const saveFailed = "Could not save. Try again.";
const disclosureSavedToast =
	"Disclosure saved. Logged as books.disclosure_changed; applies from the next document build.";

/** The school's money without decimals, as the mockup's `kusd0` writes it; minor units in. */
const moneyOf =
	(currency: string) =>
	(minorUnits: number): string =>
		`${currencySymbols[currency] ?? `${currency} `}${Math.round(minorUnits / minorUnitsPerUnit).toLocaleString("en-US")}`;

type Section = {
	school: School;
	writer: Writer;
	settings: SettingsData;
	update: (change: (current: SettingsData) => SettingsData) => void;
	/** Owners change settings; an admin reads them; while previewing, nothing is written. */
	writeOff: { disabled: boolean; title: string | undefined };
	money: (minorUnits: number) => string;
	onToast: (text: string) => void;
	onModal: (modal: ComponentChildren) => void;
};

/** The drawer's note on All schools (mockup `settings()`). */
export function AllSchoolsNote(): JSX.Element {
	return (
		<div class="prev settings-all-note" data-test="settings-all-note">
			<Icon name="info" /> Accounting, keys and connections are set per school.
			Open a school to change them.
		</div>
	);
}

/** A dialog over the drawer (mockup `#md`): a title, a body, Cancel and the confirming action. Escape, a click on the
 * backdrop and Cancel close it; Tab stays inside; focus starts on the first field, else on the first button. The
 * action stays busy until it answers, and says so if it fails. */
function SettingsDialog({
	title,
	icon,
	children,
	confirm,
	extra,
	onCancel,
	cancelable = true,
}: {
	title: string;
	icon?: IconName;
	children: ComponentChildren;
	confirm: {
		label: string;
		icon?: IconName;
		danger?: boolean;
		disabled?: boolean;
		onConfirm: () => Promise<void> | void;
	};
	extra?: ComponentChildren;
	onCancel: () => void;
	/** False for a dialog with only its closing button. */
	cancelable?: boolean;
}): JSX.Element {
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const run = async (): Promise<void> => {
		setBusy(true);
		setFailed(false);
		try {
			await confirm.onConfirm();
		} catch {
			setFailed(true);
		}
		setBusy(false);
	};
	return (
		<Dialog
			title={
				<>
					{icon && <Icon name={icon} />} {title}
				</>
			}
			onClose={onCancel}
		>
			{children}
			{failed && (
				<div class="err" role="alert">
					{saveFailed}
				</div>
			)}
			<div class="mf">
				{extra}
				{cancelable && (
					<button
						type="button"
						class="btn"
						data-test="dialog-cancel"
						onClick={onCancel}
					>
						Cancel
					</button>
				)}
				<button
					type="button"
					class={confirm.danger ? "btn d" : "btn p"}
					data-test="dialog-confirm"
					disabled={busy || confirm.disabled}
					aria-busy={busy || undefined}
					onClick={run}
				>
					{confirm.icon && <Icon name={confirm.icon} />}
					{confirm.label}
				</button>
			</div>
		</Dialog>
	);
}

/** A labelled field of a dialog (hook `dialog-field`, by `data-field`). */
function Field({
	label,
	field,
	value,
	onInput,
	placeholder,
	secret = true,
	numeric = false,
}: {
	label: string;
	field: "label" | "key" | "pin" | "apiKey";
	value: string;
	onInput: (value: string) => void;
	placeholder?: string;
	secret?: boolean;
	numeric?: boolean;
}): JSX.Element {
	const id = useId();
	return (
		<div class="fld">
			<label for={id}>{label}</label>
			<input
				id={id}
				type={secret ? "password" : "text"}
				inputMode={numeric ? "numeric" : undefined}
				maxLength={numeric ? 6 : undefined}
				autoComplete="off"
				placeholder={placeholder}
				data-test="dialog-field"
				data-field={field}
				value={value}
				onInput={(event) => onInput(event.currentTarget.value)}
			/>
		</div>
	);
}

/** One row of Keys and Connections (mockup `crow`). */
function Row({
	icon,
	name,
	badges,
	detail,
	actions,
	hooks,
	detailHook,
}: {
	icon: IconName;
	name: ComponentChildren;
	badges: ComponentChildren;
	detail: ComponentChildren;
	actions: ComponentChildren;
	hooks: Record<string, string>;
	detailHook: string;
}): JSX.Element {
	return (
		<div class="crow" {...hooks}>
			<span class="cic">
				<Icon name={icon} />
			</span>
			<div class="cm">
				{name} {badges}
				<div class="mut" data-test={detailHook}>
					{detail}
				</div>
			</div>
			<div class="ca">{actions}</div>
		</div>
	);
}

function BasisSection({
	school,
	writer,
	settings,
	update,
	writeOff,
	money,
	onToast,
}: Section): JSX.Element {
	const [selected, setSelected] = useState<AccountingBasis>(settings.basis);
	const [from, setFrom] = useState(settings.basisFrom);
	const [busy, setBusy] = useState(false);
	const cash = selected === "cash";
	const save = async (): Promise<void> => {
		setBusy(true);
		try {
			await writer.saveAccountingBasis({
				school: school.id,
				basis: selected,
				from,
			});
			update((current) => ({ ...current, basis: selected, basisFrom: from }));
			onToast(
				`Accounting basis saved: ${selected} from ${monthAndDay(from)}. Logged as a policy change.`,
			);
		} catch {
			onToast(saveFailed);
		}
		setBusy(false);
	};
	return (
		<>
			<h5 data-test="settings-section" data-section="basis">
				<Icon name="scale" /> Accounting basis
			</h5>
			{/* biome-ignore lint/a11y/useSemanticElements: the mockup's segmented control is a div; a fieldset brings its own border and padding */}
			<div class="seg" role="group" aria-label="Accounting basis">
				{(["cash", "deferred"] as const).map((basis) => (
					<button
						key={basis}
						type="button"
						class={basis === selected ? "on" : undefined}
						data-test="basis-option"
						data-basis={basis}
						{...writeOff}
						onClick={() => setSelected(basis)}
					>
						{basis === "cash" ? "Cash" : "Deferred"}
					</button>
				))}
			</div>
			<p class="mut basis-note" data-test="basis-note">
				{cash
					? "Income counts when the money arrives."
					: "Income counts as the service is given. Gifts are a liability until redeemed."}{" "}
				A {money(basisExample.yearly)} yearly plan counts{" "}
				<b>
					{cash
						? `${money(basisExample.yearly)} at once`
						: `${money(basisExample.monthly)} a month`}
				</b>
				.
			</p>
			<div class="row2">
				<label class="mut" for="bfrom">
					From
				</label>
				<input
					id="bfrom"
					type="date"
					data-test="basis-from"
					value={from}
					{...writeOff}
					onInput={(event) => setFrom(event.currentTarget.value)}
				/>
				<button
					type="button"
					class="btn p"
					data-test="basis-save"
					{...writeOff}
					disabled={writeOff.disabled || busy}
					aria-busy={busy || undefined}
					onClick={save}
				>
					Save
				</button>
			</div>
		</>
	);
}

const detailChoices: DetailStep[] = [
	"total",
	"categories",
	"breakdown",
	"spread",
];
const everyChoices: DisclosureGrain[] = ["year", "quarter", "month"];
const afterChoices: DisclosureDelay[] = [
	"6 weeks",
	"3 months",
	"12 months",
	"24 months",
];
const roundChoices = [1000, 10_000, 100_000, 1_000_000];
const ruleClasses = kpiClasses.filter(
	(kpiClass): kpiClass is RuledClass => kpiClass !== "personal",
);
const changeTable: Array<[string, string, string]> = [
	["Stricter", "Owner", "PIN open"],
	["More open for Member or Governance", "Owner", "PIN open"],
	[
		"More open for Public",
		"Owner",
		"PIN and the mailed-link step-up (it publishes); audited",
	],
	["Below the floor", "Nobody", "Refused"],
];
const changeNotes: Record<Exclude<DisclosureChange, "none">, string> = {
	stricter:
		"This is stricter than today. Already-published documents for periods still inside their delay are withdrawn. It applies from the next document build.",
	open: "This makes the Member or Governance document more open. It applies from the next document build.",
	public_open:
		"This makes the Public document more open. After your PIN, a mailed link confirms it: it publishes your books. It applies from the next document build.",
};

/** A table cell of the disclosure: "—" muted, "(as Public)" muted. */
function DisclosureCell({
	text,
	kpiClass,
	audience,
}: {
	text: string;
	kpiClass: KpiClass;
	audience: string;
}): JSX.Element {
	const inherited = text.indexOf(" (as ");
	return (
		<td
			data-test="disclosure-cell"
			data-class={kpiClass}
			data-audience={audience}
		>
			{text === "—" && <span class="mut">—</span>}
			{text !== "—" && inherited < 0 && text}
			{inherited >= 0 && (
				<>
					{text.slice(0, inherited)}{" "}
					<span class="mut">{text.slice(inherited + 1)}</span>
				</>
			)}
		</td>
	);
}

/** One select of the override editor. */
function OverrideSelect({
	field,
	label,
	value,
	options,
	disabled,
	onChange,
}: {
	field: string;
	label: string;
	value: string;
	options: Array<[string, string]>;
	disabled: boolean;
	onChange: (value: string) => void;
}): JSX.Element {
	const id = useId();
	return (
		<div>
			<label for={id} data-test="override-label" data-field={field}>
				{label}
			</label>
			<select
				id={id}
				data-test="override-field"
				data-field={field}
				disabled={disabled}
				onInput={(event) => onChange(event.currentTarget.value)}
			>
				{options.map(([optionValue, text]) => (
					<option
						key={optionValue}
						value={optionValue}
						selected={optionValue === value}
					>
						{text}
					</option>
				))}
			</select>
		</div>
	);
}

/** Save the disclosure change: the PIN first (mockup `dovSave`). */
function PinDialog({
	change,
	onSave,
	onCancel,
}: {
	change: Exclude<DisclosureChange, "none">;
	onSave: (pin: string) => Promise<void>;
	onCancel: () => void;
}): JSX.Element {
	const [pin, setPin] = useState("");
	return (
		<SettingsDialog
			title="Save the disclosure change"
			icon="lock"
			confirm={{
				label: "Confirm with PIN",
				icon: "check",
				disabled: pin.length < pinMinimumLength,
				onConfirm: () => onSave(pin),
			}}
			onCancel={onCancel}
		>
			<p class="mut">{changeNotes[change]}</p>
			<Field
				label="Your family PIN"
				field="pin"
				value={pin}
				onInput={setPin}
				numeric
			/>
		</SettingsDialog>
	);
}

function BooksSection({
	school,
	writer,
	money,
	onToast,
	onModal,
	viewing,
}: Section & { viewing: Viewing }): JSX.Element {
	const { disclosure } = viewing;
	const { file, size, year } = disclosure;
	const own = viewing.option.value === "owner";
	const [saved, setSaved] = useState<DisclosureOverride>(disclosure.override);
	const [draft, setDraft] = useState<DisclosureOverride>(disclosure.override);
	const [selection, setSelection] = useState<OverrideSelection>(
		initialOverrideSelection,
	);
	const effective = applyOverride(file, draft);
	const check = checkOverride(file, saved, draft, money);
	const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
	const rule: Partial<DisclosureRule> =
		effective.disclose[selection.ruleClass]?.[selection.ruleAudience] ?? {};
	const kpis = ruleClasses.flatMap((kpiClass) => file.classes[kpiClass]);
	const edit = (change: OverrideEdit): void =>
		setDraft(editOverride(file, draft, selection, size, change));
	const closeModal = (): void => onModal(null);
	const applied = (): void => {
		setSaved(draft);
		closeModal();
		onToast(disclosureSavedToast);
	};
	const askForLink = (minutes: number): void =>
		onModal(
			<SettingsDialog
				title="Confirm by email: this publishes your books"
				icon="mail"
				confirm={{
					label: "I opened the link",
					icon: "check",
					onConfirm: async () => {
						await writer.confirmDisclosureStepUp({ school: school.id });
						applied();
					},
				}}
				onCancel={closeModal}
			>
				<p class="mut">
					Public would see more, sooner or finer than today, and anyone can read
					it.
				</p>
				<div class="prev">
					<Icon name="clock" /> A link was mailed to confirm: this publishes
					your books. Nothing changes until you open it. The link works once and
					expires in {minutes} minutes.
				</div>
			</SettingsDialog>,
		);
	const askForPin = (): void => {
		const [first] = check.errors;
		if (first) {
			onToast(`Refused: 400 ${first.code}`);
			return;
		}
		const { change } = check;
		if (change === "none") return;
		onModal(
			<PinDialog
				change={change}
				onCancel={closeModal}
				onSave={async (pin) => {
					const result = await writer.saveDisclosure({
						school: school.id,
						override: draft,
						pin,
					});
					if (result.status === "step_up") askForLink(result.expiresInMinutes);
					else applied();
				}}
			/>,
		);
	};
	let message: ComponentChildren;
	if (check.errors.length > 0)
		message = check.errors.map(({ code, text }) => (
			<div key={`${code}${text}`} class="err">
				<Icon name="xCircle" /> 400 {code}: {text}
			</div>
		));
	else if (dirty && check.change !== "none")
		message = (
			<div class="ok">
				<Icon name="check" /> {disclosureMessages[check.change]}
			</div>
		);
	else
		message = (
			<div class="mut">
				{Object.keys(saved).length > 0
					? `${disclosureMessages.noChange.slice(0, -1)}${disclosureMessages.savedOverrideSuffix}.`
					: disclosureMessages.noChange}
			</div>
		);

	return (
		<>
			<h5 data-test="settings-section" data-section="books">
				<Icon name="eye" /> School books{" "}
				<span class="mut section-note">who sees what, how fine, how soon</span>
			</h5>
			<p class="mut books-intro" data-test="books-intro">
				From the disclosure file (<span class="mono">disclosure.v1.json</span>,
				B4 Uni policy) and this school's override. Finance admins and the owner
				always see everything, names included.
			</p>
			<div class="kdtw">
				<table class="kdt">
					<thead>
						<tr>
							<th>Class</th>
							<th>KPIs</th>
							{ruledAudiences.map((audience) => (
								<th key={audience}>{audienceNames[audience]}</th>
							))}
							<th>Finance · Owner</th>
						</tr>
					</thead>
					<tbody>
						{kpiClasses.map((kpiClass) => (
							<tr
								key={kpiClass}
								data-test="disclosure-row"
								data-class={kpiClass}
							>
								<td>
									<b>{kpiClassNames[kpiClass]}</b>
								</td>
								<td
									class="mono kdk"
									data-test="disclosure-kpis"
									data-class={kpiClass}
								>
									{effective.classes[kpiClass].join(", ")}
								</td>
								{ruledAudiences.map((audience) => (
									<DisclosureCell
										key={audience}
										kpiClass={kpiClass}
										audience={audience}
										text={disclosureCell(effective, kpiClass, audience)}
									/>
								))}
								<DisclosureCell
									kpiClass={kpiClass}
									audience="finance"
									text="names · live"
								/>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<p class="mut rounding-note" data-test="rounding-note">
				Money for Public and Member is rounded by school size: under{" "}
				{money(file.rounding.largeFrom)} of income in the last closed year,{" "}
				{money(file.rounding.small.public)} for both; from{" "}
				{money(file.rounding.largeFrom)}, {money(file.rounding.large.public)}{" "}
				for Public and {money(file.rounding.large.member)} for Member.
				Governance and up: exact.{" "}
				<b>
					{school.name} is {size}
				</b>{" "}
				for {year} (fixed on 1 Jan {year}).
			</p>
			{!own && (
				<div class="lock" data-test="books-readonly">
					<Icon name="lock" /> Owners change the disclosure. You can read it.
				</div>
			)}
			<div class="kbp">
				<b>Override</b>
				<div class="kbhint">
					A school may move a KPI between the six classes or make rules
					stricter. Below the floor is refused.
				</div>
				<div class="two">
					<OverrideSelect
						field="kpi"
						label="Move a KPI"
						value={selection.kpi}
						options={kpis.map((kpi) => [kpi, kpi])}
						disabled={!own}
						onChange={(kpi) => setSelection({ ...selection, kpi })}
					/>
					<OverrideSelect
						field="class"
						label="to class"
						value={classOf(effective, selection.kpi) ?? ""}
						options={kpiClasses.map((kpiClass) => [
							kpiClass,
							kpiClassNames[kpiClass],
						])}
						disabled={!own}
						onChange={(value) =>
							edit({ field: "class", value: value as KpiClass })
						}
					/>
				</div>
				<div class="two">
					<OverrideSelect
						field="rule-class"
						label="Rule for class"
						value={selection.ruleClass}
						options={ruleClasses.map((kpiClass) => [
							kpiClass,
							kpiClassNames[kpiClass],
						])}
						disabled={!own}
						onChange={(value) =>
							setSelection({ ...selection, ruleClass: value as RuledClass })
						}
					/>
					<OverrideSelect
						field="rule-audience"
						label="audience"
						value={selection.ruleAudience}
						options={ruledAudiences.map((audience) => [
							audience,
							audienceNames[audience],
						])}
						disabled={!own}
						onChange={(value) =>
							setSelection({
								...selection,
								ruleAudience: value as RuledAudience,
							})
						}
					/>
				</div>
				<div class="two kdr3">
					<OverrideSelect
						field="detail"
						label="Detail"
						value={rule.detail ?? ""}
						options={[
							["", "(inherit or none)"],
							...detailChoices.map((step): [string, string] => [step, step]),
						]}
						disabled={!own}
						onChange={(value) =>
							edit({ field: "detail", value: value as DetailStep | "" })
						}
					/>
					<OverrideSelect
						field="every"
						label="Every"
						value={rule.every ?? "quarter"}
						options={everyChoices.map((grain) => [grain, grain])}
						disabled={!own}
						onChange={(value) =>
							edit({ field: "every", value: value as DisclosureGrain })
						}
					/>
					<OverrideSelect
						field="after"
						label="After"
						value={rule.after ?? ""}
						options={[
							["", "at close"],
							...afterChoices.map((delay): [string, string] => [delay, delay]),
						]}
						disabled={!own}
						onChange={(value) =>
							edit({ field: "after", value: value as DisclosureDelay | "" })
						}
					/>
				</div>
				<div class="two">
					<OverrideSelect
						field="round"
						label={`Round Public (${size} school) to`}
						value={String(effective.rounding[size].public)}
						options={roundChoices.map((units): [string, string] => [
							String(units),
							money(units),
						])}
						disabled={!own}
						onChange={(value) => edit({ field: "round", value: Number(value) })}
					/>
					<div />
				</div>
				{/* biome-ignore lint/a11y/useSemanticElements: the validator's line holds block children; an output element is inline */}
				<div
					class="kmsg"
					role="status"
					aria-live="polite"
					data-test="override-message"
				>
					{message}
				</div>
				<div class="kdcust" aria-disabled="true" data-test="custom-audiences">
					<Icon name="plus" />
					<span>
						<b>Custom audiences: later</b>{" "}
						<span class="mut">
							A school-defined audience (a donor tier) is allowed by the schema
							from version 1, not accepted in the first release.
						</span>
					</span>
					<button
						type="button"
						class="btn s"
						disabled
						title="Not in the first release"
					>
						Add audience
					</button>
				</div>
				<table class="kdperm">
					<thead>
						<tr>
							<th>Change</th>
							<th>Who</th>
							<th>Check</th>
						</tr>
					</thead>
					<tbody>
						{changeTable.map(([change, who, rowCheck]) => (
							<tr key={change} data-test="disclosure-change-row">
								<td>{change}</td>
								<td>{who}</td>
								<td>{rowCheck}</td>
							</tr>
						))}
					</tbody>
				</table>
				{own && (
					<div class="row2">
						<button
							type="button"
							class="btn"
							data-test="disclosure-reset"
							disabled={!dirty}
							onClick={() => setDraft(saved)}
						>
							<Icon name="undo" />
							Reset
						</button>
						<button
							type="button"
							class="btn p"
							data-test="disclosure-save"
							disabled={
								!dirty || check.errors.length > 0 || check.change === "none"
							}
							onClick={askForPin}
						>
							<Icon name="check" />
							Check and save
						</button>
					</div>
				)}
			</div>
		</>
	);
}

const keyNames: Record<ApiKeyKind, string> = {
	pk: "publishable key",
	sk: "secret key",
	rd: "ledger read credential",
};
const keyHints: Record<ApiKeyKind, string> = {
	pk: "For browsers, from your allowed origins. Reads public school data.",
	sk: "For servers only. A browser request with it is refused.",
	rd: "Read-only, limited to your school's folder.",
};
const keyBadges: Record<ApiKeyKind, string> = {
	pk: "Publishable",
	sk: "Secret",
	rd: "Ledger read",
};
const keyIcons: Record<ApiKeyKind, IconName> = {
	pk: "key",
	sk: "key",
	rd: "db",
};
const keyMenuLabels: Record<ApiKeyKind, string> = {
	pk: "Publishable key",
	sk: "Secret key",
	rd: "Ledger read credential",
};
const keyKinds: ApiKeyKind[] = ["pk", "sk", "rd"];

function KeyCreateDialog({
	kind,
	onCreate,
	onCancel,
}: {
	kind: ApiKeyKind;
	onCreate: (label: string) => Promise<void>;
	onCancel: () => void;
}): JSX.Element {
	const [label, setLabel] = useState("");
	return (
		<SettingsDialog
			title={`Create ${keyNames[kind]}`}
			icon="key"
			confirm={{ label: "Create", onConfirm: () => onCreate(label) }}
			onCancel={onCancel}
		>
			<p class="mut">{keyHints[kind]}</p>
			<Field
				label="Label"
				field="label"
				value={label}
				onInput={setLabel}
				placeholder="For example: Website"
				secret={false}
			/>
		</SettingsDialog>
	);
}

function KeyCreatedDialog({
	created,
	onDone,
	onToast,
}: {
	created: CreatedKey;
	onDone: () => void;
	onToast: (text: string) => void;
}): JSX.Element {
	const copyButton = (label: string, toast: string): JSX.Element => (
		<div class="row2">
			<button type="button" class="btn p" onClick={() => onToast(toast)}>
				<Icon name="copy" />
				{label}
			</button>
		</div>
	);
	if (created.kind === "rd") {
		const { endpoint, bucket, prefix, keyId, secret } = created.credential;
		return (
			<SettingsDialog
				title="Credential created"
				confirm={{ label: "I stored it", onConfirm: onDone }}
				cancelable={false}
				onCancel={onDone}
			>
				<div class="mut">The secret is shown once.</div>
				<div class="pre">
					{`endpoint  ${endpoint}\nbucket    ${bucket}\nprefix    ${prefix}\nkey id    ${keyId}\nsecret    ${secret}`}
				</div>
				{copyButton("Copy all", "Credential copied.")}
			</SettingsDialog>
		);
	}
	return (
		<SettingsDialog
			title="Key created"
			confirm={{ label: "I stored it", onConfirm: onDone }}
			cancelable={false}
			onCancel={onDone}
		>
			<div class="mut">Shown once. Copy it now.</div>
			<div class="codebig mono">{created.secret}</div>
			{copyButton("Copy key", "Key copied.")}
			<p class="mut">
				Only the SHA-256 and the first 15 characters are stored.
			</p>
		</SettingsDialog>
	);
}

function KeysSection({
	school,
	writer,
	settings,
	update,
	writeOff,
	onToast,
	onModal,
}: Section): JSX.Element {
	const closeModal = (): void => onModal(null);
	const startCreate = (kind: ApiKeyKind): void => {
		const live = settings.keys.filter((key) => key.kind === kind).length;
		if (kind !== "rd" && live >= maxLiveKeysPerKind) {
			onToast("Two live keys of this kind already. Revoke one first.");
			return;
		}
		onModal(
			<KeyCreateDialog
				kind={kind}
				onCancel={closeModal}
				onCreate={async (label) => {
					const created = await writer.createKey({
						school: school.id,
						kind,
						label: label || "No label",
					});
					update((current) => ({
						...current,
						keys: [...current.keys, created.key],
					}));
					onModal(
						<KeyCreatedDialog
							created={created}
							onDone={closeModal}
							onToast={onToast}
						/>,
					);
				}}
			/>,
		);
	};
	const startRevoke = (key: ApiKey): void =>
		onModal(
			<SettingsDialog
				title={`Revoke this ${key.kind === "rd" ? "credential" : "key"}?`}
				confirm={{
					label: "Revoke",
					icon: "trash",
					danger: true,
					onConfirm: async () => {
						await writer.revokeKey({ school: school.id, keyId: key.id });
						update((current) => ({
							...current,
							keys: current.keys.filter(({ id }) => id !== key.id),
						}));
						closeModal();
						onToast("Revoked.");
					},
				}}
				onCancel={closeModal}
			>
				<p class="mut">
					<span class="mono">{key.prefix}…</span> ({key.label}). Anything using
					it stops working at once. This can't be undone.
				</p>
			</SettingsDialog>,
		);
	return (
		<>
			<h5 data-test="settings-section" data-section="keys">
				<Icon name="key" /> Keys and access{" "}
				<span class="mut section-note">we give you</span>
			</h5>
			{settings.keys.map((key) => (
				<Row
					key={key.id}
					icon={keyIcons[key.kind]}
					hooks={{ "data-test": "key-row", "data-key": key.id }}
					name={<b data-test="key-label">{key.label}</b>}
					badges={<span class="badge">{keyBadges[key.kind]}</span>}
					detailHook="key-detail"
					detail={
						<>
							<span class="mono">{key.prefix}…</span> · used {key.used}
						</>
					}
					actions={
						<button
							type="button"
							class="btn ico s d"
							data-test="key-revoke"
							data-key={key.id}
							aria-label={`Revoke ${key.label}`}
							{...writeOff}
							title={writeOff.title ?? "Revoke"}
							onClick={() => startRevoke(key)}
						>
							<Icon name="trash" />
						</button>
					}
				/>
			))}
			{settings.keys.length === 0 && (
				<div class="mut" data-test="keys-empty">
					No keys yet.
				</div>
			)}
			<Popover
				wrapperClass="key-create"
				trigger={{
					class: "btn",
					"data-test": "key-create",
					"aria-haspopup": "menu",
					...writeOff,
				}}
				panelClass="menu"
				label={
					<>
						<Icon name="plus" />
						Create
						<Icon name="chevronDown" />
					</>
				}
			>
				{(close) =>
					keyKinds.map((kind) => (
						<button
							key={kind}
							type="button"
							role="menuitem"
							data-test="key-create-option"
							data-kind={kind}
							onClick={() => {
								close();
								startCreate(kind);
							}}
						>
							<Icon name={keyIcons[kind]} />
							{keyMenuLabels[kind]}
						</button>
					))
				}
			</Popover>
		</>
	);
}

function PermissionsDialog({
	settings,
	onClose,
	onToast,
}: {
	settings: SettingsData;
	onClose: () => void;
	onToast: (text: string) => void;
}): JSX.Element | null {
	const { stripe } = settings;
	if (!stripe.connected) return null;
	const missing = stripe.missing;
	const mark = (name: string, ok: boolean): JSX.Element => (
		<div
			key={name}
			class={ok ? "ok" : "no"}
			data-test="permission-item"
			data-permission={name}
			data-ok={String(ok)}
		>
			<Icon name={ok ? "check" : "xCircle"} />
			<span class="permission-name">{name}</span>
		</div>
	);
	return (
		<SettingsDialog
			title="Stripe permissions"
			icon="card"
			confirm={{ label: "Done", onConfirm: onClose }}
			cancelable={false}
			onCancel={onClose}
			extra={
				<button
					type="button"
					class="btn"
					onClick={() => onToast("Opening Stripe…")}
				>
					<Icon name="ext" />
					Open Stripe
				</button>
			}
		>
			<div class="mut">
				{stripe.account} · key ending {stripe.last4}
			</div>
			<h5>Needed to sell plans</h5>
			<div class="permg">
				{[...stripePermissions.write, ...stripePermissions.read].map((name) =>
					mark(name, true),
				)}
			</div>
			<h5>Needed for Send invoice and Refund</h5>
			<div class="permg">
				{stripePermissions.money.map((name) =>
					mark(name, !missing.includes(name)),
				)}
			</div>
			{missing.length > 0 ? (
				<div class="prev">
					<b class="err">{missing.length} missing.</b> {missing.join(" and ")}{" "}
					stay disabled until you add {missing.length === 1 ? "it" : "them"} to
					the key in Stripe (Developers, API keys).
				</div>
			) : (
				<div class="prev ok">
					<Icon name="check" /> All permissions are present.
				</div>
			)}
		</SettingsDialog>
	);
}

function StripeKeyDialog({
	replacing,
	onSave,
	onCancel,
}: {
	replacing: boolean;
	onSave: (restrictedKey: string, pin: string) => Promise<void>;
	onCancel: () => void;
}): JSX.Element {
	const [key, setKey] = useState("");
	const [pin, setPin] = useState("");
	const { text, ok } = restrictedKeyMessage(key);
	const mistake = key.trim() !== "" && !ok && !text.startsWith("Keep typing");
	return (
		<SettingsDialog
			title={`${replacing ? "Replace" : "Connect"} Stripe`}
			icon="card"
			confirm={{
				label: "Save key",
				icon: "check",
				disabled: !(ok && pin.length >= pinMinimumLength),
				onConfirm: () => onSave(key.trim(), pin),
			}}
			onCancel={onCancel}
		>
			<p class="mut">
				Paste a <b>restricted</b> key from your own Stripe account. It is stored
				encrypted and only its last four characters are shown afterwards.
			</p>
			<Field
				label="Restricted key"
				field="key"
				value={key}
				onInput={setKey}
				placeholder="rk_live_…"
			/>
			<Field
				label="Your family PIN"
				field="pin"
				value={pin}
				onInput={setPin}
				numeric
			/>
			<div class="prev" data-test="dialog-message">
				{ok && <Icon name="check" />}
				{mistake ? <b class="err">{text}</b> : text}
			</div>
		</SettingsDialog>
	);
}

function ZeffyKeyDialog({
	replacing,
	onSave,
	onCancel,
}: {
	replacing: boolean;
	onSave: (apiKey: string) => Promise<void>;
	onCancel: () => void;
}): JSX.Element {
	const [apiKey, setApiKey] = useState("");
	return (
		<SettingsDialog
			title={`${replacing ? "Replace" : "Connect"} Zeffy`}
			icon="heart"
			confirm={{
				label: "Save key",
				icon: "check",
				disabled: apiKey.trim().length < zeffyKeyMinimumLength,
				onConfirm: () => onSave(apiKey.trim()),
			}}
			onCancel={onCancel}
		>
			<p class="mut">
				Paste the API key a Zeffy admin created. It is stored encrypted, used
				only to read payments, and never shown again.
			</p>
			<Field
				label="Zeffy API key"
				field="apiKey"
				value={apiKey}
				onInput={setApiKey}
			/>
			<div class="prev">
				<Icon name="info" /> Zeffy doesn't document webhook signing, so every
				payment is verified by looking it up in Zeffy before it is recorded.
			</div>
		</SettingsDialog>
	);
}

function RemoveDialog({
	what,
	note,
	onRemove,
	onCancel,
}: {
	what: string;
	note: string;
	onRemove: (pin: string) => Promise<void>;
	onCancel: () => void;
}): JSX.Element {
	const [pin, setPin] = useState("");
	return (
		<SettingsDialog
			title={`Remove ${what}?`}
			confirm={{
				label: "Remove",
				icon: "trash",
				danger: true,
				disabled: pin.length < pinMinimumLength,
				onConfirm: () => onRemove(pin),
			}}
			onCancel={onCancel}
		>
			<p class="mut">{note}</p>
			<Field
				label="Your family PIN"
				field="pin"
				value={pin}
				onInput={setPin}
				numeric
			/>
		</SettingsDialog>
	);
}

function ConnectionsSection({
	school,
	writer,
	settings,
	update,
	writeOff,
	onToast,
	onModal,
}: Section): JSX.Element {
	const { stripe, zeffy } = settings;
	const closeModal = (): void => onModal(null);
	const saveStripe = (): void =>
		onModal(
			<StripeKeyDialog
				replacing={stripe.connected}
				onCancel={closeModal}
				onSave={async (restrictedKey, pin) => {
					await writer.saveStripeKey({ school: school.id, restrictedKey, pin });
					update((current) => ({
						...current,
						stripe: {
							connected: true,
							account: school.name,
							mode: "live",
							last4: restrictedKey.slice(-4),
							missing: current.stripe.connected ? current.stripe.missing : [],
						},
					}));
					closeModal();
					onToast("Stripe key saved. Run Check to confirm permissions.");
				}}
			/>,
		);
	const removeStripe = (): void =>
		onModal(
			<RemoveDialog
				what="the Stripe key"
				note="Plans stop being sold and new payments can't be taken until you connect again."
				onCancel={closeModal}
				onRemove={async (pin) => {
					await writer.removeStripeKey({ school: school.id, pin });
					update((current) => ({ ...current, stripe: { connected: false } }));
					closeModal();
				}}
			/>,
		);
	const saveZeffy = (): void =>
		onModal(
			<ZeffyKeyDialog
				replacing={zeffy.connected}
				onCancel={closeModal}
				onSave={async (apiKey) => {
					await writer.saveZeffyKey({ school: school.id, apiKey });
					update((current) => ({
						...current,
						zeffy: { connected: true, last4: apiKey.slice(-4) },
					}));
					closeModal();
					onToast("Zeffy connected.");
				}}
			/>,
		);
	const removeZeffy = (): void =>
		onModal(
			<RemoveDialog
				what="the Zeffy key"
				note="Fundraising payments stop being recorded."
				onCancel={closeModal}
				onRemove={async (pin) => {
					await writer.removeZeffyKey({ school: school.id, pin });
					update((current) => ({ ...current, zeffy: { connected: false } }));
					closeModal();
				}}
			/>,
		);
	const removeButton = (
		hook: string,
		label: string,
		onClick: () => void,
	): JSX.Element => (
		<button
			type="button"
			class="btn s d"
			data-test={hook}
			aria-label={label}
			{...writeOff}
			onClick={onClick}
		>
			<Icon name="trash" />
		</button>
	);
	return (
		<>
			<h5 id="conn" data-test="settings-section" data-section="connections">
				<Icon name="plug" /> Connections{" "}
				<span class="mut section-note">you give us</span>
			</h5>
			<Row
				icon="card"
				hooks={{ "data-test": "connection-row", "data-connection": "stripe" }}
				name={<b>Stripe</b>}
				badges={
					stripe.connected ? (
						<>
							<span class="badge b-ok">
								<Icon name="check" />
								Connected
							</span>{" "}
							<span class="badge">{stripe.mode}</span>
							{stripe.missing.length > 0 && (
								<>
									{" "}
									<span class="badge b-warn">
										<Icon name="alert" />
										{stripe.missing.length} permission
										{stripe.missing.length === 1 ? "" : "s"} missing
									</span>
								</>
							)}
						</>
					) : (
						<span class="badge">Not connected</span>
					)
				}
				detailHook="connection-detail"
				detail={
					stripe.connected
						? `${stripe.account} · key ending ${stripe.last4}`
						: "Sell plans and take payments through your own Stripe account."
				}
				actions={
					stripe.connected ? (
						<>
							<button
								type="button"
								class="btn s"
								data-test="stripe-check"
								onClick={() =>
									onModal(
										<PermissionsDialog
											settings={settings}
											onClose={closeModal}
											onToast={onToast}
										/>,
									)
								}
							>
								<Icon name="check" />
								Check
							</button>
							<button
								type="button"
								class="btn s"
								data-test="stripe-connect"
								{...writeOff}
								onClick={saveStripe}
							>
								Replace
							</button>
							{removeButton(
								"stripe-remove",
								"Remove the Stripe key",
								removeStripe,
							)}
						</>
					) : (
						<button
							type="button"
							class="btn p s"
							data-test="stripe-connect"
							{...writeOff}
							onClick={saveStripe}
						>
							Connect
						</button>
					)
				}
			/>
			<Row
				icon="heart"
				hooks={{ "data-test": "connection-row", "data-connection": "zeffy" }}
				name={<b>Zeffy</b>}
				badges={
					zeffy.connected ? (
						<span class="badge b-ok">
							<Icon name="check" />
							Connected
						</span>
					) : (
						<span class="badge">Not connected</span>
					)
				}
				detailHook="connection-detail"
				detail={
					zeffy.connected
						? `Reads fundraising payments · key ending ${zeffy.last4}`
						: "Record donations from your Zeffy campaigns in your ledger."
				}
				actions={
					zeffy.connected ? (
						<>
							<button
								type="button"
								class="btn s"
								data-test="zeffy-connect"
								{...writeOff}
								onClick={saveZeffy}
							>
								Replace
							</button>
							{removeButton(
								"zeffy-remove",
								"Remove the Zeffy key",
								removeZeffy,
							)}
						</>
					) : (
						<button
							type="button"
							class="btn p s"
							data-test="zeffy-connect"
							{...writeOff}
							onClick={saveZeffy}
						>
							Connect
						</button>
					)
				}
			/>
			<Row
				icon="cloud"
				hooks={{ "data-test": "connection-row", "data-connection": "bucket" }}
				name={<b>Your own bucket (S3 or R2)</b>}
				badges={<span class="badge">Later</span>}
				detailHook="connection-detail"
				detail="Send a copy of your ledger to a bucket you own. Not available yet."
				actions={
					<button type="button" class="btn s" data-test="bucket-setup" disabled>
						Set up
					</button>
				}
			/>
		</>
	);
}

/** The drawer's school settings (mockup `settings()`): the school's heading, the owners-only line, Accounting basis,
 * School books (the disclosure table and its override editor, or a lock panel for a viewer below the admins), Keys
 * and access, Connections. Owners change them with the PIN where the mockup asks for it; an admin reads them; while
 * previewing, every write control is disabled. A write's dialog stays open until the Writer answers. */
export function SchoolSettings({
	reader,
	writer,
	school,
	viewing,
	onToast,
	onModal,
}: {
	reader: Reader;
	writer: Writer;
	school: School;
	viewing: Viewing;
	onToast: (text: string) => void;
	onModal: (modal: ComponentChildren) => void;
}): JSX.Element | null {
	const [settings, setSettings] = useState<SettingsData | null>(null);
	useEffect(() => {
		let current = true;
		reader.settings(school.id).then((loaded) => {
			if (current) setSettings(loaded);
		});
		return () => {
			current = false;
		};
	}, [reader, school.id]);
	if (!settings) return null;
	const own = viewing.option.value === "owner";
	const section: Section = {
		school,
		writer,
		settings,
		update: (change) =>
			setSettings((current) => (current ? change(current) : current)),
		writeOff: {
			disabled: !own,
			title: viewing.preview ? exitPreviewTitle : undefined,
		},
		money: moneyOf(school.currency),
		onToast,
		onModal,
	};
	const booksLock = viewing.option.locks["settings-books"];
	return (
		<>
			<div class="sechead" data-test="settings-school">
				<Icon name="building" /> {school.name}{" "}
				<span class="mut section-note">school settings</span>
			</div>
			{!own && (
				<div class="lock" data-test="settings-readonly">
					<Icon name="lock" /> Owners only. You are an admin here: you can look,
					not change.
				</div>
			)}
			<BasisSection {...section} />
			{booksLock ? (
				<LockPanel lock={booksLock} surface="settings-books" />
			) : (
				<BooksSection {...section} viewing={viewing} />
			)}
			<KeysSection {...section} />
			<ConnectionsSection {...section} />
		</>
	);
}
