import { afterEach, expect, test } from "bun:test";
import { cleanUp, count, element, open, text } from "../s5/helpers.ts";

afterEach(cleanUp);

const plansNote = "[data-test=plan-books-note]";
const reviewButton = "[data-test=plan-review]";

// ---- Round 7: the Plans tab shows only what the mockup shows

test("Plans in Edit draws no revenue lock panel; each audience keeps its note and the locks in the cells", async () => {
	for (const audience of ["public", "member", "admin"]) {
		await open(`#/vol/plans?as=${audience}`);
		expect(count("[data-test=lock-panel][data-surface=plans-revenue]")).toBe(0);
		expect(count("[data-test=lock-panel]")).toBe(0);
		expect(text(plansNote)).toContain(
			"Per-plan members and revenue are a breakdown: finance admins, the owner and governance see them.",
		);
		cleanUp();
	}
	await open("#/vol/plans?as=admin");
	expect(text(plansNote)).toContain(
		"Admins without the finance grant see the plan structure",
	);
});

test("the reason Review and publish is disabled is in its title and a hidden description, never visible text beside it", async () => {
	await open("#/vol/plans?as=admin");
	const button = element<HTMLButtonElement>(reviewButton);
	expect(button.disabled).toBe(true);
	expect(button.title).toBe("Exit preview to act");
	const description = element(
		`#${button.getAttribute("aria-describedby") ?? "missing"}`,
	);
	expect(description.textContent).toBe("Exit preview to act");
	expect(description.classList.contains("visually-hidden")).toBe(true);
	expect(description.classList.contains("mut")).toBe(false);
	const toolbar = element(".tools");
	const visible = [...toolbar.querySelectorAll("span")].filter(
		(span) =>
			!span.classList.contains("visually-hidden") &&
			span.textContent === "Exit preview to act",
	);
	expect(visible).toEqual([]);
});

test("Collected names the month the viewed period reads from while the admin's figure is withheld", async () => {
	await open("#/vol/plans?as=admin&month=2026-04-01..2026-06-30");
	expect(text("[data-stat=collected] [data-test=plan-stat-label]")).toBe(
		"Collected in Jun",
	);
	cleanUp();
	// The Member document's last shown period is Q2, so an admin who has just been viewed as Member reads Jun too.
	await open("#/vol/plans?as=admin");
	expect(text("[data-stat=collected] [data-test=plan-stat-label]")).toBe(
		"Collected in Jun",
	);
	cleanUp();
	// With the figure shown, the label names the month the server summed.
	await open("#/vol/plans");
	expect(text("[data-stat=collected] [data-test=plan-stat-label]")).toBe(
		"Collected in Nov",
	);
});
