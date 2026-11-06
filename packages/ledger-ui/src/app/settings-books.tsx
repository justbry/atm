import type { ComponentChildren, JSX } from "preact";
import { useId, useState } from "preact/hooks";
import {
	applyOverride,
	audienceNames,
	checkOverride,
	classOf,
	type DetailStep,
	type DisclosureChange,
	type DisclosureDelay,
	type DisclosureFile,
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
	type SchoolSize,
} from "../data/disclosure.ts";
import { pinMinimumLength } from "../data/settings.ts";
import type { School } from "../data/types.ts";
import type { Writer } from "../data/writer.ts";
import { Icon } from "./icon.tsx";
import {
	Field,
	type Follow,
	type Section,
	SettingsDialog,
	useDialogChain,
} from "./settings-shared.tsx";
import type { Viewing } from "./viewing.ts";

const disclosureSavedToast =
	"Disclosure saved. Logged as books.disclosure_changed; applies from the next document build.";

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

/** The mailed-link step-up a Public-opening change needs after the PIN (it publishes the books). */
function StepUpDialog({
	minutes,
	onConfirm,
	onCancel,
}: {
	minutes: number;
	onConfirm: () => Promise<void>;
	onCancel: () => void;
}): JSX.Element {
	return (
		<SettingsDialog
			title="Confirm by email: this publishes your books"
			icon="mail"
			confirm={{
				label: "I opened the link",
				icon: "check",
				onConfirm,
			}}
			onCancel={onCancel}
		>
			<p class="mut">
				Public would see more, sooner or finer than today, and anyone can read
				it.
			</p>
			<div class="prev">
				<Icon name="clock" /> A link was mailed to confirm: this publishes your
				books. Nothing changes until you open it. The link works once and
				expires in {minutes} minutes.
			</div>
		</SettingsDialog>
	);
}

/** The save flow of a disclosure change (mockup `dovSave`): the PIN, then (for a change that opens Public) the mailed
 * link. Returns what "Check and save" does for a change the validator accepted. */
function useDisclosureSave({
	school,
	writer,
	draft,
	onSaved,
	onToast,
	onModal,
}: {
	school: School;
	writer: Writer;
	draft: DisclosureOverride;
	onSaved: () => void;
	onToast: (text: string) => void;
	onModal: (modal: ComponentChildren) => void;
}): (change: Exclude<DisclosureChange, "none">) => void {
	const dialogs = useDialogChain(onModal);
	/** The write is the server's: it is recorded and announced even if its dialog was closed meanwhile. */
	const applied = (follow: Follow): void => {
		onSaved();
		follow(null);
		onToast(disclosureSavedToast);
	};
	return (change) => {
		const afterPin = dialogs.show(
			<PinDialog
				change={change}
				onCancel={dialogs.close}
				onSave={async (pin) => {
					const result = await writer.saveDisclosure({
						school: school.id,
						override: draft,
						pin,
					});
					if (result.status !== "step_up") {
						applied(afterPin);
						return;
					}
					const afterLink = afterPin(
						<StepUpDialog
							minutes={result.expiresInMinutes}
							onCancel={dialogs.close}
							onConfirm={async () => {
								await writer.confirmDisclosureStepUp({ school: school.id });
								applied(afterLink);
							}}
						/>,
					);
				}}
			/>,
		);
	};
}

/** The validator's line under the override editor. */
function OverrideMessage({
	check,
	dirty,
	saved,
}: {
	check: ReturnType<typeof checkOverride>;
	dirty: boolean;
	saved: DisclosureOverride;
}): JSX.Element {
	if (check.errors.length > 0)
		return (
			<>
				{check.errors.map(({ code, text }) => (
					<div key={`${code}${text}`} class="err">
						<Icon name="xCircle" /> 400 {code}: {text}
					</div>
				))}
			</>
		);
	if (dirty && check.change !== "none")
		return (
			<div class="ok">
				<Icon name="check" /> {disclosureMessages[check.change]}
			</div>
		);
	return (
		<div class="mut">
			{Object.keys(saved).length > 0
				? `${disclosureMessages.noChange.slice(0, -1)}${disclosureMessages.savedOverrideSuffix}.`
				: disclosureMessages.noChange}
		</div>
	);
}

/** The override editor under the disclosure table (mockup `.kbp`): the selects, the validator's line, the change
 * table and Reset / Check and save. Owners edit; everyone else reads. */
function OverrideEditor({
	file,
	effective,
	selection,
	size,
	own,
	dirty,
	check,
	saved,
	money,
	onSelect,
	onEdit,
	onReset,
	onSave,
}: {
	file: DisclosureFile;
	effective: DisclosureFile;
	selection: OverrideSelection;
	size: SchoolSize;
	own: boolean;
	dirty: boolean;
	check: ReturnType<typeof checkOverride>;
	saved: DisclosureOverride;
	money: (minorUnits: number) => string;
	onSelect: (selection: OverrideSelection) => void;
	onEdit: (change: OverrideEdit) => void;
	onReset: () => void;
	onSave: (change: Exclude<DisclosureChange, "none">) => void;
}): JSX.Element {
	/** The change "Check and save" would send: none while the validator refuses or the draft changes nothing. */
	const savable =
		dirty && check.errors.length === 0 && check.change !== "none"
			? check.change
			: null;
	const rule: Partial<DisclosureRule> =
		effective.disclose[selection.ruleClass]?.[selection.ruleAudience] ?? {};
	const kpis = ruleClasses.flatMap((kpiClass) => file.classes[kpiClass]);
	return (
		<div class="kbp">
			<b>Override</b>
			<div class="kbhint">
				A school may move a KPI between the six classes or make rules stricter.
				Below the floor is refused.
			</div>
			<div class="two">
				<OverrideSelect
					field="kpi"
					label="Move a KPI"
					value={selection.kpi}
					options={kpis.map((kpi) => [kpi, kpi])}
					disabled={!own}
					onChange={(kpi) => onSelect({ ...selection, kpi })}
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
						onEdit({ field: "class", value: value as KpiClass })
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
						onSelect({ ...selection, ruleClass: value as RuledClass })
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
						onSelect({ ...selection, ruleAudience: value as RuledAudience })
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
						onEdit({ field: "detail", value: value as DetailStep | "" })
					}
				/>
				<OverrideSelect
					field="every"
					label="Every"
					value={rule.every ?? "quarter"}
					options={everyChoices.map((grain) => [grain, grain])}
					disabled={!own}
					onChange={(value) =>
						onEdit({ field: "every", value: value as DisclosureGrain })
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
						onEdit({ field: "after", value: value as DisclosureDelay | "" })
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
					onChange={(value) => onEdit({ field: "round", value: Number(value) })}
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
				<OverrideMessage check={check} dirty={dirty} saved={saved} />
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
						onClick={onReset}
					>
						<Icon name="undo" />
						Reset
					</button>
					<button
						type="button"
						class="btn p"
						data-test="disclosure-save"
						disabled={savable === null}
						onClick={() => savable && onSave(savable)}
					>
						<Icon name="check" />
						Check and save
					</button>
				</div>
			)}
		</div>
	);
}

/** School books (mockup `bkSettings`): the disclosure table the school's audiences read, and the owner's override. */
export function BooksSection({
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
	const askForPin = useDisclosureSave({
		school,
		writer,
		draft,
		onSaved: () => setSaved(draft),
		onToast,
		onModal,
	});

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
			<OverrideEditor
				file={file}
				effective={effective}
				selection={selection}
				size={size}
				own={own}
				dirty={dirty}
				check={check}
				saved={saved}
				money={money}
				onSelect={setSelection}
				onEdit={(change) =>
					setDraft(editOverride(file, draft, selection, size, change))
				}
				onReset={() => setDraft(saved)}
				onSave={askForPin}
			/>
		</>
	);
}
