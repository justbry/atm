import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
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
	return (
		<Popover
			trigger={{ class: "btn", "data-test": "school-switcher" }}
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

function SchoolList({
	schools,
	current,
	onChoose,
}: SchoolSwitcherProps): JSX.Element {
	const [search, setSearch] = useState("");
	const searchInput = useRef<HTMLInputElement>(null);
	useEffect(() => searchInput.current?.focus(), []);
	const matches = (name: string): boolean =>
		name.toLowerCase().includes(search.trim().toLowerCase());
	return (
		<>
			<div class="school-search">
				<span class="sbox">
					<input
						ref={searchInput}
						type="search"
						placeholder="Find a school"
						aria-label="Find a school"
						value={search}
						onInput={(event) => setSearch(event.currentTarget.value)}
					/>
				</span>
			</div>
			{matches("All schools") && (
				<button
					type="button"
					class={current === allSchools ? "it on" : "it"}
					data-test="school-option"
					data-school={allSchools}
					aria-current={current === allSchools ? "true" : undefined}
					aria-label={`All schools, ${schools.length} schools`}
					onClick={() => onChoose(allSchools)}
				>
					<Icon name="building" />
					<span class="sp2">All schools</span>
					<span class="mut">{schools.length}</span>
				</button>
			)}
			<hr />
			{schools
				.filter((school) => matches(school.name))
				.map((school) => (
					<button
						key={school.id}
						type="button"
						class={school.id === current ? "it on" : "it"}
						data-test="school-option"
						data-school={school.id}
						aria-current={school.id === current ? "true" : undefined}
						aria-label={[
							school.name,
							school.stale ? "stale" : "",
							school.attentionCount > 0
								? `${school.attentionCount} need attention`
								: "",
						]
							.filter(Boolean)
							.join(", ")}
						onClick={() => onChoose(school.id)}
					>
						<Icon name="building" />
						<span class="sp2">{school.name}</span>
						{school.stale && <span class="badge b-warn">stale</span>}
						{school.attentionCount > 0 && (
							<span class="badge b-warn">{school.attentionCount}</span>
						)}
					</button>
				))}
		</>
	);
}
