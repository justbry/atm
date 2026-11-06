import { afterEach, expect, test } from "bun:test";
import { mountApp } from "../../src/app/mount.tsx";
import { addDays, weekdayName, weekStart } from "../../src/app/period.ts";
import type {
	Booking,
	BookingsQuery,
	CancelBooking,
	RecordOutcome,
} from "../../src/data/bookings.ts";
import { insideCutoff, needsOutcome } from "../../src/data/bookings.ts";
import type { Reader } from "../../src/data/reader.ts";
import type { Writer } from "../../src/data/writer.ts";
import { createFixtureReader } from "../../src/fixtures/reader.ts";
import { createFixtureWriter } from "../../src/fixtures/writer.ts";

const clock = { today: "2026-11-05", now: "2026-11-05T12:00" };
let unmount: (() => void) | null = null;

const macrotask = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));
const element = <Type extends HTMLElement = HTMLElement>(
	selector: string,
): Type => {
	const found = document.querySelector<Type>(selector);
	if (!found) throw new Error(`no element matches ${selector}`);
	return found;
};
const text = (selector: string): string =>
	(element(selector).textContent ?? "").replace(/\s+/g, " ").trim();
const count = (selector: string): number =>
	document.querySelectorAll(selector).length;
const row = (id: string): string =>
	`[data-test=booking-row][data-booking=${id}]`;
const settle = async (): Promise<void> => {
	for (
		let attempt = 0;
		attempt < 400 && element("#app").dataset.route !== window.location.hash;
		attempt += 1
	)
		await macrotask();
	await macrotask();
	await macrotask();
};
const open = async (
	hash: string,
	options: { reader?: Reader; writer?: Writer } = {},
): Promise<void> => {
	window.location.hash = hash;
	const container = document.createElement("div");
	container.id = "app";
	document.body.appendChild(container);
	unmount = mountApp(container, {
		reader: options.reader ?? createFixtureReader({ clock }),
		writer: options.writer ?? createFixtureWriter({ mode: "instant" }),
		clock,
	}).unmount;
	await settle();
};
/** Follows a hash in the app that is already open. */
const go = async (hash: string): Promise<void> => {
	window.location.hash = hash;
	await settle();
};
const click = async (selector: string): Promise<void> => {
	element(selector).click();
	await settle();
};
/** The fixture Reader with every booking passed through `change`. */
const readerWith = (change: (booking: Booking) => Booking): Reader => {
	const reader = createFixtureReader({ clock });
	return {
		...reader,
		bookings: async (query) => ({
			bookings: (await reader.bookings(query)).bookings.map(change),
		}),
	};
};

afterEach(() => {
	unmount?.();
	unmount = null;
	document.body.innerHTML = "";
	window.location.hash = "";
});

test("the week helpers start on Monday and name the weekday", () => {
	expect(weekStart("2026-11-05")).toBe("2026-11-02");
	expect(weekStart("2026-11-08")).toBe("2026-11-02");
	expect(weekStart("2026-11-09")).toBe("2026-11-09");
	expect(weekdayName("2026-11-04")).toBe("Wed");
	expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
});

test("the contract's rules read the clock, state and attendance only", () => {
	const base: Booking = {
		id: "bk_x",
		eventId: "ev_x",
		service: "Facial",
		startsAt: "2026-11-05T11:59",
		endsAt: "2026-11-05T12:30",
		hosts: [],
		attendee: null,
		guest: true,
		state: "confirmed",
		cutoffMinutes: 60,
		seriesId: null,
		attendance: null,
	};
	expect(needsOutcome(base, clock)).toBe(true);
	expect(needsOutcome({ ...base, attendance: "attended" }, clock)).toBe(false);
	expect(needsOutcome({ ...base, state: "requested" }, clock)).toBe(false);
	expect(insideCutoff({ ...base, startsAt: "2026-11-05T12:59" }, clock)).toBe(
		true,
	);
	expect(insideCutoff({ ...base, startsAt: "2026-11-05T13:00" }, clock)).toBe(
		false,
	);
});

test("a filter chip writes only filter= and keeps the period and the preview in the hash", async () => {
	await open("#/vol/bookings?range=day&offset=1&as=admin&theme=light");
	await click("[data-test=booking-filter][data-filter=approval]");
	expect(window.location.hash).toBe(
		"#/vol/bookings?range=day&offset=1&as=admin&theme=light&filter=approval",
	);
	await click("[data-test=booking-filter][data-filter=all]");
	expect(window.location.hash).toBe(
		"#/vol/bookings?range=day&offset=1&as=admin&theme=light",
	);
	expect(text("[data-test=booking-range-label]")).toBe("Tomorrow");
});

test("the pane has no period buttons of its own", async () => {
	await open("#/vol/bookings");
	expect(count("[data-test=booking-range], [data-test=booking-step]")).toBe(0);
});

test("the audiences that may not see bookings get the lock panel and read nothing", async () => {
	const reads: BookingsQuery[] = [];
	const reader = createFixtureReader({ clock });
	await open("#/vol/bookings?as=public&filter=cutoff", {
		reader: {
			...reader,
			bookings: (query) => {
				reads.push(query);
				return reader.bookings(query);
			},
		},
	});
	expect(reads).toEqual([]);
	expect(text("[data-test=lock-panel] h4")).toBe(
		"Owners and admins see bookings",
	);
	expect(element("[data-test=lock-panel]").dataset.lock).toBe("admins_only");
	expect(count("table, [data-test=booking-filter]")).toBe(0);
});

test("a preview the person may not take is ignored; one they may take is honoured", async () => {
	await open("#/b4u/bookings?as=owner");
	expect(count("[data-test=lock-panel]")).toBe(0);
	expect(count("[data-test=booking-row]")).toBe(1);
	await go("#/b4u/bookings?as=member");
	expect(count("[data-test=lock-panel]")).toBe(1);
	await go("#/b4u/bookings?as=finance");
	expect(count("[data-test=lock-panel]")).toBe(0);
	await go("#/b4u/bookings?as=nobody");
	expect(count("[data-test=lock-panel]")).toBe(0);
});

test("a malformed route opens this week with every booking", async () => {
	await open("#/vol/bookings?range=month&offset=soon&filter=everything");
	expect(text("[data-test=booking-range-label]")).toBe("This week");
	expect(text("[data-test=booking-filter].on")).toBe("All");
	expect(count("[data-test=booking-row]")).toBe(5);
});

test("a week beyond last, this and next is named by its Monday and a day by its weekday", async () => {
	await open("#/vol/bookings?range=week&offset=-3");
	expect(text("[data-test=booking-range-label]")).toBe("Week of Oct 12");
	expect(text("[data-test=booking-range-dates]")).toBe(
		"Oct 12 – Oct 18 · change it in the period control",
	);
	await go("#/vol/bookings?range=day&offset=-1");
	expect(text("[data-test=booking-range-label]")).toBe("Yesterday");
});

test("the overdue group is a second read over the 62 days before the range", async () => {
	const queries: BookingsQuery[] = [];
	const reader = createFixtureReader({ clock });
	await open("#/vol/bookings?range=week&offset=1", {
		reader: {
			...reader,
			bookings: (query) => {
				queries.push(query);
				return reader.bookings(query);
			},
		},
	});
	expect(queries).toEqual([
		{ school: "vol", from: "2026-11-09", to: "2026-11-15" },
		{ school: "vol", from: "2026-09-08", to: "2026-11-08" },
	]);
});

test("the Billing column shows free, held credits in the school's unit and paid money", async () => {
	await open("#/vol/bookings?range=week&offset=0");
	expect(text(`${row("bk_6qq")} td:nth-child(4)`)).toBe("Free");
	expect(text(`${row("bk_8zz")} td:nth-child(4)`)).toBe("1 session held");
	expect(text(`${row("bk_5kd")} td:nth-child(4)`)).toBe("2 sessions held");
	await go("#/vol/bookings?offset=1");
	expect(text(`${row("bk_3cd")} td:nth-child(4)`)).toBe("Paid $40.00");
	await go("#/b4u/bookings");
	expect(text(`${row("bk_b12")} td:nth-child(4)`)).toBe("2 credits held");
});

test("a paid booking offers Cancel and refund, disabled, and no Release hold", async () => {
	await open("#/vol/bookings?offset=1");
	const refund = element<HTMLButtonElement>(
		`[data-test=booking-action][data-booking=bk_3cd]`,
	);
	expect(refund.textContent).toContain("Cancel and refund");
	expect(refund.disabled).toBe(true);
	expect(
		count(
			`[data-test=booking-action][data-action=release][data-booking=bk_3cd]`,
		),
	).toBe(0);
});

test("a free upcoming booking has no action; without billing a confirmed upcoming booking offers Release hold", async () => {
	const free = readerWith((booking) => ({
		...booking,
		billing: { kind: "free" },
	}));
	await open("#/vol/bookings", { reader: free });
	expect(count("[data-test=booking-action][data-action=release]")).toBe(0);
	expect(count("[data-test=booking-action][data-action=confirm]")).toBe(2);
	unmount?.();
	document.body.innerHTML = "";
	const unknown = readerWith(({ billing: _billing, ...booking }) => booking);
	await open("#/vol/bookings", { reader: unknown });
	expect(text(`${row("bk_8zz")} td:nth-child(4)`)).toBe("");
	expect(text(`${row("bk_5kd")} td:nth-child(4)`)).toBe("");
	expect(
		count(
			"[data-test=booking-action][data-action=release][data-booking=bk_5kd]",
		),
	).toBe(1);
});

test("a started booking with a recorded outcome shows it and offers nothing", async () => {
	const reader = readerWith((booking) =>
		booking.id === "bk_6qq" ? { ...booking, attendance: "no_show" } : booking,
	);
	await open("#/vol/bookings", { reader });
	expect(text(`${row("bk_6qq")} [data-test=booking-status]`)).toBe("No-show");
	expect(count(`[data-test=booking-action][data-booking=bk_6qq]`)).toBe(0);
	expect(text("[data-test=booking-filter][data-filter=outcome]")).toBe(
		"Needs outcome (1)",
	);
	expect(count("[data-test=booking-bulk]")).toBe(0);
});

test("a guest booking reads Guest and prints no member key", async () => {
	const reader = readerWith((booking) =>
		booking.id === "bk_8zz"
			? { ...booking, attendee: null, guest: true }
			: booking,
	);
	await open("#/vol/bookings", { reader });
	expect(text(`${row("bk_8zz")} [data-test=booking-member]`)).toBe("Guest");
	expect(count(`${row("bk_8zz")} td:nth-child(3) .mono`)).toBe(0);
	await click(
		`[data-test=booking-action][data-action=noshow][data-booking=bk_8zz]`,
	);
	expect(text("[data-test=dialog] .mut")).toBe("Massage 90 · bk_8zz · Guest");
});

test("a bulk confirm starts every write at once, in row order, and toasts when all have answered", async () => {
	const writer = createFixtureWriter({ mode: "hold" });
	await open("#/vol/bookings?range=day", { writer });
	await click("[data-test=booking-bulk][data-day=overdue]");
	expect(
		writer.calls.map(({ args }) => (args[0] as RecordOutcome).bookingId),
	).toEqual(["bk_6qq", "bk_8zz"]);
	expect(text("[data-test=toast]")).toBe("");
	expect(count("[data-test=booking-bulk]")).toBe(0);
	writer.release();
	await settle();
	expect(text("[data-test=toast]")).toBe(
		"Attendance confirmed for 2 bookings.",
	);
});

test("a write that fails offers the booking again and says so", async () => {
	const writer: Writer = {
		...createFixtureWriter({ mode: "instant" }),
		recordOutcome: () => Promise.reject(new Error("offline")),
	};
	await open("#/vol/bookings", { writer });
	await click(
		`[data-test=booking-action][data-action=confirm][data-booking=bk_6qq]`,
	);
	expect(text("[data-test=toast]")).toBe("Could not send. Try again.");
	expect(count(`[data-test=booking-action][data-booking=bk_6qq]`)).toBe(2);
	expect(text(`${row("bk_6qq")} [data-test=booking-status]`)).toBe(
		"Needs outcome",
	);
});

test("the dialog starts on Cancel, closes on the backdrop and opens again with the box clear", async () => {
	await open("#/vol/bookings");
	const release = `[data-test=booking-action][data-action=release][data-booking=bk_5kd]`;
	await click(release);
	expect(document.activeElement).toBe(element("[data-test=dialog-cancel]"));
	expect(text("[data-test=dialog] label")).toBe(
		"Waive the late-cancel forfeit (return the sessions)",
	);
	await click("[data-test=waive-cutoff]");
	expect(count("[data-test=waive-cutoff]:checked")).toBe(1);
	await click(".bg");
	expect(count("[data-test=dialog]")).toBe(0);
	await click(release);
	expect(count("[data-test=waive-cutoff]:checked")).toBe(0);
});

test("a No-show dialog has no waive box and its title names the school", async () => {
	await open("#/b4u/bookings");
	await click(
		`[data-test=booking-action][data-action=noshow][data-booking=bk_b12]`,
	);
	expect(text("[data-test=dialog-title]")).toBe("Mark no-show · B4 Uni");
	expect(count("[data-test=waive-cutoff]")).toBe(0);
	expect(text("[data-test=dialog] .mut")).toBe(
		"Tutoring · bk_b12 · Dana W. · s_21",
	);
});

test("the fixture Writer records each call and, held, answers only on release", async () => {
	const writer = createFixtureWriter({ mode: "hold" });
	const request: CancelBooking = {
		school: "vol",
		bookingId: "bk_7hq",
		reason: "admin_release",
	};
	let answered = false;
	const cancelled = writer.cancelBooking(request).then(() => {
		answered = true;
	});
	await macrotask();
	expect(writer.calls).toEqual([{ method: "cancelBooking", args: [request] }]);
	expect(answered).toBe(false);
	writer.release();
	await cancelled;
	expect(answered).toBe(true);
	expect(
		await createFixtureWriter({ mode: "instant" }).recordOutcome({
			school: "vol",
			bookingId: "bk_6qq",
			state: "attended",
		}),
	).toEqual({ creditEffect: "not_wired" });
});

test("the fixture Reader answers a range inclusively and a school without bookings with none", async () => {
	const reader = createFixtureReader({ clock });
	const days = async (from: string, to: string): Promise<string[]> =>
		(await reader.bookings({ school: "vol", from, to })).bookings.map(
			({ id }) => id,
		);
	expect(await days("2026-11-04", "2026-11-04")).toEqual(["bk_8zz", "bk_6qq"]);
	expect(await days("2026-11-13", "2026-11-30")).toEqual([]);
	expect(
		(
			await reader.bookings({
				school: "nw",
				from: "2026-01-01",
				to: "2026-12-31",
			})
		).bookings,
	).toEqual([]);
});

test("a booking waiting for approval offers Remind host, which toasts the host names and writes nothing", async () => {
	const writer = createFixtureWriter({ mode: "instant" });
	const reader = readerWith((booking) =>
		booking.id === "bk_rq1"
			? {
					...booking,
					hosts: [
						{ id: "kim", name: "Kim" },
						{ id: "ravi", name: "Ravi" },
					],
				}
			: booking,
	);
	await open("#/vol/bookings", { reader, writer });
	const remind = `[data-test=booking-action][data-action=remind][data-booking=bk_rq1]`;
	expect(text(remind)).toBe("Remind host");
	expect(count("[data-test=booking-action][data-booking=bk_rq1]")).toBe(1);
	await click(remind);
	expect(text("[data-test=toast]")).toBe("Reminder sent to Kim, Ravi.");
	expect(writer.calls).toEqual([]);
});

test("Remind host is disabled under View as preview, like the other writes", async () => {
	await open("#/vol/bookings?as=admin");
	const remind = element<HTMLButtonElement>(
		`[data-test=booking-action][data-action=remind][data-booking=bk_rq1]`,
	);
	expect(remind.disabled).toBe(true);
	remind.click();
	await settle();
	expect(text("[data-test=toast]")).toBe("");
});

test("a release inside the cutoff opens the waive dialog only where a late cancel is spent", async () => {
	const startingSoon = readerWith((booking) =>
		booking.id === "bk_b12"
			? { ...booking, startsAt: "2026-11-05T13:00", endsAt: "2026-11-05T14:00" }
			: booking,
	);
	const release = (id: string): string =>
		`[data-test=booking-action][data-action=release][data-booking=${id}]`;

	const spends = createFixtureWriter({ mode: "instant" });
	await open("#/vol/bookings", { reader: startingSoon, writer: spends });
	await click(release("bk_5kd"));
	expect(count("[data-test=waive-cutoff]")).toBe(1);
	expect(spends.calls).toEqual([]);
	await click("[data-test=waive-cutoff]");
	await click("[data-test=dialog-confirm]");
	expect(spends.calls).toEqual([
		{
			method: "cancelBooking",
			args: [
				{
					school: "vol",
					bookingId: "bk_5kd",
					reason: "admin_release",
					waiveCutoff: true,
				},
			],
		},
	]);

	unmount?.();
	document.body.innerHTML = "";
	const releases = createFixtureWriter({ mode: "instant" });
	await open("#/b4u/bookings", { reader: startingSoon, writer: releases });
	await click(release("bk_b12"));
	expect(count("[data-test=dialog]")).toBe(0);
	expect(releases.calls).toEqual([
		{
			method: "cancelBooking",
			args: [{ school: "b4u", bookingId: "bk_b12", reason: "admin_release" }],
		},
	]);
	expect(text("[data-test=toast]")).toBe("Hold released for Dana W.");
});

test("a booking's series label is shown as the server worded it, after the other badges", async () => {
	await open("#/vol/bookings");
	expect(text(`${row("bk_7hq")} [data-test=booking-status]`)).toBe(
		"weekly · 3 left",
	);
	expect(text(`${row("bk_rq1")} [data-test=booking-status]`)).toBe(
		"Waiting for approval",
	);
	unmount?.();
	document.body.innerHTML = "";
	const reader = readerWith((booking) =>
		booking.id === "bk_rq1"
			? { ...booking, seriesLabel: "every other week" }
			: booking,
	);
	await open("#/vol/bookings", { reader });
	expect(text(`${row("bk_rq1")} [data-test=booking-status]`)).toBe(
		"Waiting for approval every other week",
	);
});

test("the member's name is a button that opens their drawer on the Members tab, keeping the shared parameters", async () => {
	await open("#/vol/bookings?theme=light&range=day&offset=-1&filter=outcome");
	const name = element(`${row("bk_8zz")} [data-test=booking-member]`);
	expect(name.tagName).toBe("BUTTON");
	expect(element(row("bk_8zz")).onclick).toBeNull();
	await click(`${row("bk_8zz")} [data-test=booking-member]`);
	expect(window.location.hash).toBe(
		"#/vol/members?theme=light&range=day&offset=-1&member=m_204",
	);
	expect(count("[data-test=member-drawer]")).toBe(1);
});

test("a guest has no member button", async () => {
	const reader = readerWith((booking) =>
		booking.id === "bk_8zz"
			? { ...booking, attendee: null, guest: true }
			: booking,
	);
	await open("#/vol/bookings", { reader });
	expect(element(`${row("bk_8zz")} [data-test=booking-member]`).tagName).toBe(
		"SPAN",
	);
});

test("paid money is the shared formatter's, in the booking's own currency", async () => {
	const reader = readerWith((booking) =>
		booking.id === "bk_6qq"
			? {
					...booking,
					billing: { kind: "paid", amountMinor: 123_456, currency: "CAD" },
				}
			: booking,
	);
	await open("#/vol/bookings", { reader });
	expect(text(`${row("bk_6qq")} td:nth-child(4)`)).toBe("Paid CA$1,234.56");
});

test("while a read is on its way the tools bar and the note stay and the list is empty, with no counts", async () => {
	const reader = createFixtureReader({ clock });
	await open("#/vol/bookings?range=day&offset=1", {
		reader: { ...reader, bookings: () => new Promise(() => undefined) },
	});
	expect(text("[data-test=booking-range-label]")).toBe("Tomorrow");
	expect(
		Array.from(
			document.querySelectorAll("[data-test=booking-filter]"),
			(chip) => chip.textContent,
		),
	).toEqual(["All", "Needs outcome", "Waiting for approval", "Inside cutoff"]);
	expect(count("table")).toBe(1);
	expect(count("[data-test=booking-row], [data-test=booking-empty]")).toBe(0);
	expect(count("[data-test=booking-note]")).toBe(1);
});

test("the actions column is named and a disabled refund's reason reaches assistive technology", async () => {
	await open("#/vol/bookings?offset=1");
	const heads = Array.from(document.querySelectorAll("th"), (head) =>
		(head.textContent ?? "").trim(),
	);
	expect(heads.at(-1)).toBe("Actions");
	const refund = element(
		`[data-test=booking-action][data-action=refund][data-booking=bk_3cd]`,
	);
	const reasonId = refund.getAttribute("aria-describedby");
	expect(reasonId).toBeTruthy();
	expect(document.getElementById(reasonId ?? "")?.textContent).toBe(
		"Refunds from this tab are not available yet.",
	);
});

test("the filter chips and the table carry no inline styles", async () => {
	await open("#/vol/bookings?range=day&offset=1&filter=approval");
	expect(count("[style]")).toBe(0);
	await go("#/vol/bookings?range=day&offset=4");
	expect(count("[data-test=booking-empty]")).toBe(1);
	expect(
		count("[data-test=booking-empty][style], .bookings-empty[style]"),
	).toBe(0);
});
