import type { JSX, RefObject } from "preact";
import { useId, useState } from "preact/hooks";
import type { ViewAs } from "../data/disclosure.ts";
import type { Clock, School } from "../data/types.ts";
import {
	bookingsDays,
	bookingsLabel,
	bookingsPeriodRoute,
	readBookingsPeriod,
} from "./bookings-period.ts";
import { CoreIcon } from "./core-icon.tsx";
import {
	formatPeriod,
	monthAndDay,
	type Period,
	periodName,
	periodWord,
	samePeriod,
	snapPeriod,
} from "./period.ts";
import { Popover } from "./popover.tsx";
import { type Route, withQuery } from "./route.ts";
import { ownRowName, type Viewing } from "./viewing.ts";

/** The popovers' content, loaded after the first paint (`menus.tsx`). */
export type Menus = typeof import("./menus.tsx");

type TopBarProps = {
	route: Route;
	schools: School[];
	/** The route's school; undefined on All schools. */
	school: School | undefined;
	clock: Clock;
	/** The money period the viewed audience may see: the route's `month=`, snapped (mockup `snapP`). */
	period: Period;
	/** The popovers' content, once loaded. */
	menus: Menus | null;
	/** What the route views, once the school's disclosure has loaded. */
	viewing: Viewing | null;
	inert: boolean;
	drawerId: string;
	settingsOpen: boolean;
	settingsButton: RefObject<HTMLButtonElement>;
	navigate: (route: Route) => void;
	onChooseSchool: (schoolId: string) => void;
	onToggleSettings: () => void;
	onToast: (text: string) => void;
};

/** The mockup's top bar (`.top`): brand, school switcher, the one period control, View as, then help and settings,
 * pinned on the first row at phone widths (the stylesheet's orders). */
export function TopBar({
	route,
	schools,
	school,
	clock,
	period,
	menus,
	viewing,
	inert,
	drawerId,
	settingsOpen,
	settingsButton,
	navigate,
	onChooseSchool,
	onToggleSettings,
	onToast,
}: TopBarProps): JSX.Element {
	const switcherList = useId();
	const viewAsList = useId();
	/** Only the checkbox reads it until Reports compares periods; kept here so it outlives the popover. */
	const [compare, setCompare] = useState(false);
	const { today } = clock;
	const schoolName = school?.name ?? "All schools";

	const onBookings = school !== undefined && route.tab === "bookings";
	const bookingsPeriod = readBookingsPeriod(route.query);
	const days = bookingsDays(bookingsPeriod, today);
	const bookingsName = bookingsLabel(bookingsPeriod, days.from);
	const moneyName = periodName(period);
	const periodButton = onBookings
		? {
				word: bookingsPeriod.range === "day" ? "Day" : "Week",
				label: `Bookings period: ${bookingsName}`,
				title: `${bookingsName} · ${monthAndDay(days.from)}${days.from === days.to ? "" : ` – ${monthAndDay(days.to)}`}`,
				changed: bookingsPeriod.range !== "week" || bookingsPeriod.offset !== 0,
			}
		: {
				word: periodWord(period),
				label: `Period: ${moneyName}`,
				title: moneyName,
				changed: formatPeriod(period, today) !== null,
			};

	/** Picking a row of View as: the route gets `as=` (none for the viewer's own row), and a period the new audience
	 * may not pick becomes the nearest one it may, with a toast that says so (mockup `setVa`). */
	const chooseViewAs = (value: ViewAs): void => {
		if (!viewing || !menus) return;
		const { disclosure } = viewing;
		const own = value === disclosure.viewer.viewAs;
		const nextView = menus.resolveViewing(disclosure, value).view;
		const snapped = snapPeriod(period, nextView);
		let target = withQuery(route, "as", own ? null : value);
		if (!samePeriod(snapped, period)) {
			target = withQuery(target, "month", formatPeriod(snapped, today));
			onToast(`Period changed to ${periodName(snapped)}: ${nextView.sees}`);
		}
		navigate(target);
	};

	return (
		<div class="top" inert={inert}>
			<span class="logo" data-test="brand">
				atm
			</span>
			<Popover
				wrapperClass="tsw"
				trigger={{
					id: "sw",
					class: "btn",
					"data-test": "school-switcher",
					"aria-haspopup": "listbox",
					title: schoolName,
				}}
				controls={switcherList}
				label={
					<>
						<CoreIcon name="building" />
						<span class="swn">{schoolName}</span>
						<CoreIcon name="chevronDown" />
					</>
				}
			>
				{(close) =>
					menus && (
						<menus.SchoolList
							listboxId={switcherList}
							schools={schools}
							current={route.schoolId}
							onChoose={(schoolId) => {
								close();
								onChooseSchool(schoolId);
							}}
						/>
					)
				}
			</Popover>
			<Popover
				wrapperClass="tper"
				trigger={{
					id: "pb",
					class: periodButton.changed ? "btn tb pnd" : "btn tb",
					"data-test": "period-button",
					"aria-haspopup": "dialog",
					"aria-label": periodButton.label,
					title: periodButton.title,
				}}
				panelId="pp"
				panel={{ role: "dialog", "aria-label": "Period" }}
				label={
					<>
						<CoreIcon name="calendar" />
						<span class="pbw">{periodButton.word}</span>
						<i class="pdot" aria-hidden="true" />
					</>
				}
			>
				{(close) => {
					if (!menus) return null;
					if (onBookings)
						return (
							<menus.BookingsPeriodPanel
								period={bookingsPeriod}
								today={today}
								moneyPeriod={period}
								timeZone={school.timeZone}
								onChoose={(chosen, shut) => {
									if (shut) close();
									navigate(bookingsPeriodRoute(route, chosen));
								}}
							/>
						);
					return (
						<menus.PeriodPanel
							period={period}
							today={today}
							view={viewing?.view ?? null}
							previewing={viewing?.preview ?? false}
							timeZoneNote={
								school
									? `Times in ${school.timeZone}`
									: "Each school's own time zone"
							}
							compare={compare}
							onCompareChange={setCompare}
							onChoose={(chosen, shut) => {
								if (shut) close();
								navigate(
									withQuery(route, "month", formatPeriod(chosen, today)),
								);
							}}
						/>
					);
				}}
			</Popover>
			{school && viewing && (
				<Popover
					wrapperClass="tva"
					trigger={{
						id: "kview",
						class: viewing.preview ? "btn tb kview pnd" : "btn tb kview",
						"data-test": "view-as",
						"aria-haspopup": "listbox",
						"aria-label": `View as ${viewing.option.name}`,
						title: `View as ${viewing.option.name}. You are ${ownRowName(viewing.disclosure)} in ${school.name}. Owners and admins own the dashboard and see everyone's data. Members see only themselves and their family.`,
					}}
					panelClass="pop vapop"
					panelId="kvp"
					panel={{
						role: "listbox",
						"aria-label": "View as",
						"aria-describedby": `${viewAsList}-top ${viewAsList}-portal`,
					}}
					label={
						<>
							<CoreIcon name="eye" />
							<span class="va-l">View as </span>
							<b class="va-r">{viewing.option.name}</b>
							<CoreIcon name="chevronDown" />
						</>
					}
				>
					{(close) =>
						menus && (
							<menus.ViewAsPanel
								listboxId={viewAsList}
								disclosure={viewing.disclosure}
								chosen={viewing.option}
								onChoose={(value) => {
									close();
									chooseViewAs(value);
								}}
							/>
						)
					}
				</Popover>
			)}
			<span class="sp tsp" />
			<span class="tbrk" aria-hidden="true" />
			<Popover
				wrapperClass="thb"
				trigger={{
					id: "hb",
					class: "ib",
					"data-test": "help-button",
					title: "Help and SDK",
					"aria-label": "Help and SDK",
				}}
				alignRight
				label={<CoreIcon name="help" />}
			>
				{(close) =>
					menus && <menus.HelpPanel close={close} onToast={onToast} />
				}
			</Popover>
			<button
				ref={settingsButton}
				id="gb"
				type="button"
				class="ib"
				data-test="settings-button"
				title="Settings"
				aria-label="Settings"
				aria-haspopup="dialog"
				aria-controls={drawerId}
				aria-expanded={settingsOpen}
				onClick={onToggleSettings}
			>
				<CoreIcon name="gear" />
			</button>
		</div>
	);
}
