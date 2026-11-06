import { Fragment, type JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
	type AudienceView,
	audienceNames,
	type Disclosure,
	resolveViewAs,
	type ViewAs,
	type ViewAsOption,
} from "../data/disclosure.ts";
import type { School } from "../data/types.ts";
import {
	type BookingsPeriod,
	bookingsChoices,
	bookingsDays,
	bookingsLabel,
} from "./bookings-period.ts";
import { Icon, type IconName } from "./icon.tsx";
import {
	monthAndDay,
	type Period,
	periodLabel,
	periodName,
	periodPresets,
	samePeriod,
	shiftPeriod,
	stepAllowed,
} from "./period.ts";
import { allSchools } from "./route.ts";
import { ownRowName, type Viewing } from "./viewing.ts";

/** What the top bar's popovers hold. The shell loads this module as soon as it has mounted, so the first page load
 * is the bar and the tabs only; the popovers are never opened before it is there. */

const assistantPrompt = [
	"You are helping an owner or admin of a school on atm, the bookings and payments service behind ledger.b4uni.com.",
	"Treat this as read-only context: you can read what I paste from the ledger, and nothing you say changes plans, bookings, promos or payments.",
	"The ledger is an append-only list of events; reports come from it through hledger and DuckDB, and apps use the School SDK, @b4uni/school.",
	"When you are not sure what an event means, say so and point me to the ledger event reference.",
].join(" ");
const copyFailedToast =
	"Could not copy the prompt: the browser blocked the clipboard.";
const helpLinks: Array<{
	label: string;
	detail?: string;
	icon: IconName;
	toast: string;
	/** Text the link puts on the clipboard before its toast. */
	copy?: string;
}> = [
	{
		label: "School SDK",
		detail: "@b4uni/school",
		icon: "box",
		toast: "Opening the School SDK readme…",
	},
	{
		label: "Ledger event reference",
		icon: "list",
		toast: "Opening the event reference…",
	},
	{
		label: "Reports with hledger and DuckDB",
		icon: "chart",
		toast: "Opening the recipes…",
	},
	{
		label: "Copy a prompt for an AI assistant",
		icon: "copy",
		toast: "Prompt copied. It gives an assistant read-only context.",
		copy: assistantPrompt,
	},
];

/** The help menu (mockup `renderHP`): a link shows its toast; the prompt link says so only once the clipboard has
 * taken the text. */
export function HelpPanel({
	close,
	onToast,
}: {
	close: () => void;
	onToast: (text: string) => void;
}): JSX.Element {
	const follow = async (link: (typeof helpLinks)[number]): Promise<void> => {
		close();
		if (!link.copy) {
			onToast(link.toast);
			return;
		}
		try {
			await navigator.clipboard.writeText(link.copy);
			onToast(link.toast);
		} catch {
			onToast(copyFailedToast);
		}
	};
	return (
		<>
			{helpLinks.map((link, index) => (
				<Fragment key={link.label}>
					{index === helpLinks.length - 1 && <hr />}
					<button
						type="button"
						class="it"
						data-test="help-link"
						onClick={() => follow(link)}
					>
						<Icon name={link.icon} />
						<span class="sp2">{link.label}</span>
						{link.detail && <span class="mut">{link.detail}</span>}
					</button>
				</Fragment>
			))}
		</>
	);
}

type SchoolListProps = {
	listboxId: string;
	schools: School[];
	/** A school id, or `all`. */
	current: string;
	onChoose: (schoolId: string) => void;
};

const schoolLabel = (school: School): string =>
	[
		school.name,
		school.stale ? "stale" : "",
		school.attentionCount > 0 ? `${school.attentionCount} need attention` : "",
	]
		.filter(Boolean)
		.join(", ");

type Move = (index: number, count: number) => number;
const moves: Record<string, Move> = {
	ArrowDown: (index) => index + 1,
	ArrowUp: (index) => index - 1,
	Home: () => 0,
	End: (_index, count) => count - 1,
};

/** The school switcher's content (mockup `#sp`, `renderSP`): the search field, then the listbox, its rows
 * `role=option`. The listbox is one Tab stop: the current school's row, or the first row when the search hides it.
 * Arrow Up and Down, Home and End move between rows, Enter and Space choose, and Arrow Down in the search field
 * enters the list. */
export function SchoolList({
	listboxId,
	schools,
	current,
	onChoose,
}: SchoolListProps): JSX.Element {
	const [search, setSearch] = useState("");
	const searchInput = useRef<HTMLInputElement>(null);
	const listbox = useRef<HTMLDivElement>(null);
	useEffect(() => searchInput.current?.focus(), []);
	const matches = (name: string): boolean =>
		name.toLowerCase().includes(search.trim().toLowerCase());
	const allShown = matches("All schools");
	const shownSchools = schools.filter((school) => matches(school.name));
	const shownIds = [
		...(allShown ? [allSchools] : []),
		...shownSchools.map((school) => school.id),
	];
	const tabStop = shownIds.includes(current) ? current : shownIds[0];

	const rows = (): HTMLElement[] => [
		...(listbox.current?.querySelectorAll<HTMLElement>("[role=option]") ?? []),
	];
	const onListKeyDown = (
		event: JSX.TargetedKeyboardEvent<HTMLDivElement>,
	): void => {
		const move = moves[event.key];
		if (move) {
			event.preventDefault();
			const options = rows();
			const focused = document.activeElement;
			const index =
				focused instanceof HTMLElement ? options.indexOf(focused) : -1;
			const target = Math.max(
				0,
				Math.min(options.length - 1, move(index, options.length)),
			);
			options[target]?.focus();
			return;
		}
		if (event.key !== "Enter" && event.key !== " ") return;
		const option =
			event.target instanceof HTMLElement
				? event.target.closest<HTMLElement>("[role=option]")
				: null;
		const schoolId = option?.dataset.school;
		if (schoolId === undefined) return;
		event.preventDefault();
		onChoose(schoolId);
	};
	const onSearchKeyDown = (
		event: JSX.TargetedKeyboardEvent<HTMLInputElement>,
	): void => {
		if (event.key !== "ArrowDown") return;
		event.preventDefault();
		rows()
			.find((option) => option.dataset.school === tabStop)
			?.focus();
	};
	const optionProps = (schoolId: string, label: string) => ({
		type: "button" as const,
		role: "option" as const,
		class: schoolId === current ? "it on" : "it",
		"data-test": "school-option",
		"data-school": schoolId,
		"aria-selected": schoolId === current,
		"aria-label": label,
		tabIndex: schoolId === tabStop ? 0 : -1,
		onClick: () => onChoose(schoolId),
	});

	return (
		<>
			<div class="school-search">
				<span class="sbox">
					<input
						ref={searchInput}
						type="search"
						placeholder="Find a school"
						aria-label="Find a school"
						aria-controls={listboxId}
						value={search}
						onInput={(event) => setSearch(event.currentTarget.value)}
						onKeyDown={onSearchKeyDown}
					/>
				</span>
			</div>
			<div
				ref={listbox}
				id={listboxId}
				role="listbox"
				aria-label="Schools"
				onKeyDown={onListKeyDown}
			>
				{allShown && (
					<button
						{...optionProps(
							allSchools,
							`All schools, ${schools.length} schools`,
						)}
					>
						<Icon name="building" />
						<span class="sp2">All schools</span>
						<span class="mut">{schools.length}</span>
					</button>
				)}
				{/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: an hr is not focusable; inside the listbox it is only a line, so it leaves the accessibility tree. */}
				<hr aria-hidden="true" />
				{shownSchools.map((school) => (
					<button
						key={school.id}
						{...optionProps(school.id, schoolLabel(school))}
					>
						<Icon name="building" />
						<span class="sp2">{school.name}</span>
						{school.stale && <span class="badge b-warn">stale</span>}
						{school.attentionCount > 0 && (
							<span class="badge b-warn">{school.attentionCount}</span>
						)}
					</button>
				))}
			</div>
		</>
	);
}

type Step = { disabled: boolean; title: string | null; onClick: () => void };

/** The heading of the period popover: the previous and next steps around the period's name. */
function PeriodHeading({
	label,
	previous,
	next,
}: {
	label: string;
	previous: Step;
	next: Step;
}): JSX.Element {
	const button = (
		hook: "prev" | "next",
		{ disabled, title, onClick }: Step,
	): JSX.Element => (
		<button
			type="button"
			class="btn ico s"
			data-test={`period-${hook}`}
			aria-label={hook === "prev" ? "Previous period" : "Next period"}
			disabled={disabled}
			title={title ?? undefined}
			onClick={onClick}
		>
			<Icon name={hook === "prev" ? "chevronLeft" : "chevronRight"} />
		</button>
	);
	return (
		<div class="pph">
			{button("prev", previous)}
			<b class="pplab" data-test="period-label">
				{label}
			</b>
			{button("next", next)}
		</div>
	);
}

type PeriodPanelProps = {
	period: Period;
	today: string;
	/** The viewed audience's periods and presets; null on All schools, where everything is pickable. */
	view: AudienceView | null;
	previewing: boolean;
	timeZoneNote: string;
	compare: boolean;
	onCompareChange: (compare: boolean) => void;
	/** `close` is true when the popover should shut (a preset, a chip, Apply); the steps keep it open. */
	onChoose: (period: Period, close: boolean) => void;
};

/** The period popover's content (mockup `renderPP`): the steps and the period's name, the audience's note, the eight
 * presets, the audience's own periods as chips, Custom range, Compare. An option the viewed audience may not pick is
 * disabled with the reason; days show to finance admins and the owner only. Opening it focuses the chosen preset, or
 * the custom range's start. A custom range may not start after the clock's today. */
export function PeriodPanel({
	period,
	today,
	view,
	previewing,
	timeZoneNote,
	compare,
	onCompareChange,
	onChoose,
}: PeriodPanelProps): JSX.Element {
	const [from, setFrom] = useState(period.from);
	const [to, setTo] = useState(period.to);
	const chosenPreset = useRef<HTMLButtonElement>(null);
	const fromInput = useRef<HTMLInputElement>(null);
	useEffect(() => (chosenPreset.current ?? fromInput.current)?.focus(), []);
	let problem = "";
	if (!from || !to) problem = "Pick both dates.";
	else if (from > today) problem = "Start is after today.";
	else if (from > to) problem = "Start is after the end.";
	const presets = periodPresets(today);
	const chosenLabel = presets.find((preset) =>
		samePeriod(preset.period, period),
	)?.label;
	const step = (direction: 1 | -1) => {
		const target = shiftPeriod(period, direction);
		const { ok, title } = stepAllowed(target, view, today);
		return {
			disabled: !ok,
			title,
			onClick: () => onChoose(target, false),
		};
	};
	return (
		<>
			<PeriodHeading
				label={periodName(period)}
				previous={step(-1)}
				next={step(1)}
			/>
			{view && (
				<div class="mut ppsub" data-test="period-note">
					{previewing ? "Previewing " : ""}
					{view.periodNote}
				</div>
			)}
			<hr />
			{presets.map((preset) => {
				const gate = view?.presets.find(({ label }) => label === preset.label);
				const pickable = !gate || gate.state === "shown";
				const chosen = preset.label === chosenLabel;
				let detail = periodLabel(preset.period);
				if (gate?.state === "embargoed") detail = gate.title ?? detail;
				else if (gate?.state === "hidden") detail = "—";
				return (
					<button
						key={preset.label}
						ref={chosen ? chosenPreset : null}
						type="button"
						class={chosen ? "it on" : "it"}
						data-test="period-option"
						aria-current={chosen ? "true" : undefined}
						disabled={!pickable}
						aria-disabled={pickable ? undefined : "true"}
						title={pickable ? undefined : (gate?.title ?? undefined)}
						onClick={() => onChoose(preset.period, true)}
					>
						<span class="sp2">{preset.label}</span>
						<span class="mut">{detail}</span>
					</button>
				);
			})}
			{view && !view.live && (
				<>
					<hr />
					{/* biome-ignore lint/a11y/useSemanticElements: the mockup's chip grid is a div; a fieldset brings its own border and padding */}
					<div class="ppgrid" role="group" aria-label={`${view.grain}s`}>
						{view.periods.map((gate) => {
							const gatePeriod = { from: gate.from, to: gate.to };
							const pickable = gate.state === "shown";
							return (
								<button
									key={gate.period}
									type="button"
									class={samePeriod(gatePeriod, period) ? "chip on" : "chip"}
									data-test="period-chip"
									data-period={gate.period}
									disabled={!pickable}
									aria-disabled={pickable ? undefined : "true"}
									title={pickable ? undefined : (gate.title ?? undefined)}
									onClick={() => onChoose(gatePeriod, true)}
								>
									{gate.label}
								</button>
							);
						})}
					</div>
				</>
			)}
			<hr />
			<div class="cus" data-test="period-option">
				<span class="range-title">Custom range</span>
				{view?.customRangeNote ? (
					<div class="mut">{view.customRangeNote}</div>
				) : (
					<>
						<div class="two">
							<input
								ref={fromInput}
								type="date"
								aria-label="From"
								max={today}
								value={from}
								onInput={(event) => setFrom(event.currentTarget.value)}
							/>
							<input
								type="date"
								aria-label="To"
								max={today}
								value={to}
								onInput={(event) => setTo(event.currentTarget.value)}
							/>
						</div>
						<div class="cnote" aria-live="polite">
							{problem}
						</div>
						<button
							type="button"
							class="btn p s"
							disabled={problem !== ""}
							onClick={() => onChoose({ from, to }, true)}
						>
							Apply
						</button>
					</>
				)}
			</div>
			<hr />
			<label class="chk">
				<input
					type="checkbox"
					checked={compare}
					onChange={(event) => onCompareChange(event.currentTarget.checked)}
				/>{" "}
				Compare with previous period
			</label>
			<div class="mut tzn">{timeZoneNote}</div>
		</>
	);
}

/** The period popover on the Bookings tab (mockup `renderPP`): bookings look ahead, so the choices are a day or a
 * week and the steps move one of them. The money period is not touched. */
export function BookingsPeriodPanel({
	period,
	today,
	moneyPeriod,
	timeZone,
	onChoose,
}: {
	period: BookingsPeriod;
	today: string;
	moneyPeriod: Period;
	timeZone: string;
	/** `close` is true for a choice; the steps keep the popover open. */
	onChoose: (period: BookingsPeriod, close: boolean) => void;
}): JSX.Element {
	const { from, to } = bookingsDays(period, today);
	const step = (direction: 1 | -1) => ({
		disabled: false,
		title: null,
		onClick: () =>
			onChoose({ ...period, offset: period.offset + direction }, false),
	});
	return (
		<>
			<PeriodHeading
				label={bookingsLabel(period, from)}
				previous={step(-1)}
				next={step(1)}
			/>
			<div class="mut ppsub">
				{monthAndDay(from)}
				{from === to ? "" : ` – ${monthAndDay(to)}`} · bookings ahead
			</div>
			<hr />
			{bookingsChoices.map((choice) => {
				const chosen =
					choice.range === period.range && choice.offset === period.offset;
				return (
					<button
						key={choice.label}
						type="button"
						class={chosen ? "it on" : "it"}
						data-test="period-option"
						aria-current={chosen ? "true" : undefined}
						onClick={() => onChoose(choice, true)}
					>
						<span class="sp2">{choice.label}</span>
					</button>
				);
			})}
			<hr />
			<div class="mut tzn">
				The money period ({periodName(moneyPeriod)}) comes back when you leave
				Bookings. Times in {timeZone}.
			</div>
		</>
	);
}

/** What a route views: `as=` when it names a row the viewer holds, else their own (`resolveViewAs`), and the audience
 * view that row shows. Here, not in the shell, so that the entry carries none of the disclosure rules. */
export function resolveViewing(
	disclosure: Disclosure,
	asked: string | null,
): Viewing {
	const { option, preview } = resolveViewAs(asked, disclosure);
	return {
		disclosure,
		option,
		preview,
		view: disclosure.views[option.audience],
	};
}

/** The banner under the tabs while previewing (mockup `#vab`): who is shown, who you are, Exit preview. */
export function PreviewBanner({
	viewing: { disclosure, option },
	inert,
	onExit,
}: {
	viewing: Viewing;
	inert: boolean;
	onExit: () => void;
}): JSX.Element {
	return (
		// biome-ignore lint/a11y/useSemanticElements: the mockup's banner is a div; an output element is inline
		<div
			class="banner vab"
			data-test="preview-banner"
			role="status"
			inert={inert}
		>
			<Icon name="eye" />
			<span>
				{`Preview: this is what `}
				<b>{option.name}</b>
				{` sees. You are ${ownRowName(disclosure)}.${
					option.value === "admin"
						? ` Their books follow their own membership: shown as ${audienceNames[option.audience]}.`
						: ""
				} Writes are off.`}
			</span>
			<span class="sp" />
			<button
				type="button"
				class="btn s"
				data-test="preview-exit"
				onClick={onExit}
			>
				<Icon name="xCircle" />
				Exit preview
			</button>
		</div>
	);
}

const viewAsIcons: Record<ViewAs, IconName> = {
	owner: "key",
	finance: "coin",
	admin: "sliders",
	governance: "users",
	member: "user",
	public: "eye",
};

/** The View as list (mockup `renderVA`): the viewer's own row and what each role sees. A row the viewer does not hold
 * is disabled; the Custom audiences row is a later release. Opening it focuses the chosen row. */
export function ViewAsPanel({
	disclosure,
	chosen,
	onChoose,
}: {
	disclosure: Disclosure;
	chosen: ViewAsOption;
	onChoose: (value: ViewAs) => void;
}): JSX.Element {
	const own = disclosure.viewer.viewAs;
	const chosenRow = useRef<HTMLButtonElement>(null);
	useEffect(() => chosenRow.current?.focus(), []);
	return (
		<>
			<div class="vah mut" data-test="view-as-note" data-note="top">
				You are {ownRowName(disclosure)} here. This previews what each role
				sees: the same document that audience gets, not a person. Owners and
				admins own the dashboard and see everyone's data. Members see only
				themselves and their family.
			</div>
			<hr />
			{disclosure.viewAs.map((option) => {
				const selected = option.value === chosen.value;
				return (
					<button
						key={option.value}
						ref={selected ? chosenRow : null}
						type="button"
						role="option"
						class={selected ? "it vao on" : "it vao"}
						data-test="view-as-option"
						data-as={option.value}
						aria-selected={selected}
						disabled={!option.held}
						aria-disabled={option.held ? undefined : "true"}
						title={option.held ? undefined : "You do not hold this audience"}
						onClick={() => onChoose(option.value)}
					>
						<Icon name={viewAsIcons[option.value]} />
						<span class="sp2">
							<b data-test="view-as-name">
								{option.name}
								{option.value === own && <span class="mut"> (you)</span>}
							</b>
							<small data-test="view-as-summary">{option.summary}</small>
						</span>
						{selected && <Icon name="check" />}
					</button>
				);
			})}
			<button
				type="button"
				role="option"
				class="it vao"
				data-test="view-as-later"
				aria-selected="false"
				disabled
				aria-disabled="true"
				title="Custom audiences are not accepted in the first release"
			>
				<Icon name="plus" />
				<span class="sp2">
					<b>Custom audiences: later</b>
					<small>
						Etc.: any audience a school defines (a donor tier) comes in a later
						release.
					</small>
				</span>
			</button>
			<hr />
			<div class="vah mut" data-test="view-as-note" data-note="portal">
				<Icon name="info" /> To see one person's portal, use View as member on
				their row in Members.
			</div>
		</>
	);
}
