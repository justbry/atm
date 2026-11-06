import type { JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { School } from "../data/types.ts";
import { Icon } from "./icon.tsx";
import { Popover } from "./popover.tsx";
import { allSchools } from "./route.ts";

type SchoolSwitcherProps = {
	schools: School[];
	/** A school id, or `all`. */
	current: string;
	onChoose: (schoolId: string) => void;
};

/** The top bar's school switcher (mockup `#sw` and `renderSP`). */
export function SchoolSwitcher({
	schools,
	current,
	onChoose,
}: SchoolSwitcherProps): JSX.Element {
	const currentName =
		schools.find((school) => school.id === current)?.name ?? "All schools";
	const listboxId = useId();
	return (
		<Popover
			trigger={{
				class: "btn",
				"data-test": "school-switcher",
				"aria-haspopup": "listbox",
			}}
			controls={listboxId}
			label={
				<>
					<Icon name="building" />
					<span class="button-label">{currentName}</span>
					<Icon name="chevronDown" />
				</>
			}
		>
			{(close) => (
				<SchoolList
					listboxId={listboxId}
					schools={schools}
					current={current}
					onChoose={(schoolId) => {
						close();
						onChoose(schoolId);
					}}
				/>
			)}
		</Popover>
	);
}

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

/** The search field, then the listbox (mockup `#sp`, its rows `role=option`). The listbox is one Tab stop: the
 * current school's row, or the first row when the search hides it. Arrow Up and Down, Home and End move between
 * rows, Enter and Space choose, and Arrow Down in the search field enters the list. */
function SchoolList({
	listboxId,
	schools,
	current,
	onChoose,
}: SchoolSwitcherProps & { listboxId: string }): JSX.Element {
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
