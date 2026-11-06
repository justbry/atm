/**
 * Whole-app evidence for the final review: every surface x audience, at 1100, 728 and 390 px in light and dark, app and
 * mockup side by side. Nine surfaces (Dashboard, Bookings, Plans, Members, Ledger, Reports, Promos, the Settings drawer,
 * the member portal) and six audiences (owner, finance, admin, governance, member, public). The app is reached by hash
 * route with `as=<audience>`, the Settings drawer and portal by their button and `portal=` route; the mockup by a fresh
 * page, the host tokens, `applyTheme()`, `setSchool()`, its own `setVa()` (the View as menu's action) and the tab, gear
 * or View as member clicks. An audience the signed-in person cannot preview at that school (the mockup's `vaAllowed`) is
 * recorded "not offered" with no shot, and the app is checked to refuse it too (its View as button keeps the viewer's
 * own row). A step the mockup cannot reach is recorded with the reason and drawn as a note tile. Each shot carries a
 * 4-character nonce on a yellow box (pixels only). Output: raw/<cell>-<width>-<theme>-<app|mock>.png, sheets/<cell>.png
 * (6 rows, width x theme; app | mockup), dom/<cell>.txt (#app innerText, 1100 light) and index.md. Usage, from the repo
 * root, with the app on :5191 and the mockup on :5192:
 *   node plans/ledger-ui/loop/tools/whole-app.mjs --out <dir> --nonce K7QX --app http://127.0.0.1:5191 --mock http://127.0.0.1:5192
 * Optional `--only <surface>[,<surface>]` and `--jobs <n>` (default 4). Needs playwright-core in /tmp/ledger-shots
 * (createRequire below) and the cached Chromium headless shell.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire("/tmp/ledger-shots/package.json");
const { chromium } = require("playwright-core");
const argument = (name) => {
	const index = process.argv.indexOf(name);
	return index > 0 ? process.argv[index + 1] : undefined;
};
const appOrigin = argument("--app") ?? "http://127.0.0.1:5191";
const mockOrigin = argument("--mock") ?? "http://127.0.0.1:5192";
const out = resolve(argument("--out") ?? "");
const nonce = argument("--nonce");
const only = argument("--only")?.split(",");
const jobs = Number(argument("--jobs") ?? 4);
if (!argument("--out") || !nonce || nonce.length !== 4)
	throw new Error("usage: --out <dir> --nonce <4 characters>");
const hostCss = readFileSync("plans/ledger-ui/design/mockup-host.css", "utf8");
const executablePath = join(
	homedir(),
	"Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell",
);

const widths = [1100, 728, 390];
const themes = ["light", "dark"];
const rows = widths.flatMap((width) =>
	themes.map((theme) => ({ width, theme })),
);
const audiences = [
	{ id: "owner", name: "Owner" },
	{ id: "finance", name: "Finance admin" },
	{ id: "admin", name: "Admin" },
	{ id: "governance", name: "Governance" },
	{ id: "member", name: "Member" },
	{ id: "public", name: "Public" },
];
const schoolNames = { vol: "Vibes of Light", b4u: "B4 Uni" };
const portalMember = { vol: "m_051", b4u: "s_21" };

/** `mock` runs after the school and View as are set. `app` is the route's path and query, `after` the click on top. */
const mockHelper =
	"const q=s=>{const e=document.querySelector(s);if(!e)throw new Error('the mockup has no '+s);return e};";
const tabSteps = (tab) => `q('.tab[data-p=${tab}]').click()`;
const surfaces = [
	{
		id: "dashboard",
		school: "b4u",
		why: "the audience documents live on B4 Uni",
		path: "dashboard",
		mock: () => tabSteps("dash"),
	},
	{
		id: "bookings",
		school: "vol",
		path: "bookings",
		mock: () => tabSteps("bk"),
	},
	{ id: "plans", school: "vol", path: "plans", mock: () => tabSteps("pl") },
	{
		id: "members",
		school: "vol",
		path: "members",
		mock: () => tabSteps("mem"),
	},
	{ id: "ledger", school: "vol", path: "ledger", mock: () => tabSteps("led") },
	{
		id: "reports",
		school: "vol",
		path: "reports",
		mock: () => tabSteps("rep"),
	},
	{ id: "promos", school: "vol", path: "promos", mock: () => tabSteps("cod") },
	{
		id: "settings",
		school: "vol",
		path: "dashboard",
		after: "[data-test=settings-button]",
		mock: () =>
			`${tabSteps("dash")};q('#gb').click();if(!q('#set').classList.contains('on'))throw new Error('the Settings drawer did not open')`,
	},
	{
		id: "portal",
		school: "b4u",
		why: "the portal fixture family (the Wus) lives on B4 Uni",
		path: "members",
		query: (school) => `portal=${portalMember[school]}`,
		mock: (school) =>
			`${tabSteps("mem")};{const b=document.querySelector('#mb tr.row[data-id=${portalMember[school]}] [data-vm]');if(b&&b.offsetParent!==null){b.click();if(!vm)throw new Error('the member portal did not open')}else window.mockNote='portal unreachable by a person: the Members tab shows a lock or no such row, so the shot is that tab'}`,
	},
];

/** Cells: one per surface x audience at the surface's school; where that school does not offer Owner, a "not offered"
 * cell plus an extra owner cell at Vibes of Light so the Owner document is still compared. */
const cells = [];
for (const surface of surfaces) {
	if (only && !only.includes(surface.id)) continue;
	for (const audience of audiences)
		cells.push({ surface, audience, school: surface.school });
	if (surface.school !== "vol")
		cells.push({
			surface,
			audience: audiences[0],
			school: "vol",
			extra: true,
		});
}
for (const cell of cells)
	cell.id = `${cell.surface.id}-${cell.audience.id}${cell.extra ? `-${cell.school}` : ""}`;

const writeNonce = (value) => {
	const element = document.createElement("div");
	element.textContent = value;
	element.style.cssText =
		"position:fixed;right:6px;bottom:6px;z-index:2147483647;font:bold 14px ui-monospace,monospace;background:#ff0;color:#000;padding:2px 6px;border:1px solid #000";
	document.body.appendChild(element);
};
const appRoute = (cell, theme) => {
	const { surface, school, audience } = cell;
	const parts = [
		surface.query?.(school),
		`as=${audience.id}`,
		`theme=${theme}`,
	].filter(Boolean);
	return `#/${school}/${surface.path}?${parts.join("&")}`;
};
const mockSteps = (cell) =>
	`setSchool('${cell.school}');setVa('${cell.audience.id}');${cell.surface.mock(cell.school)}`;
const firstLine = (error) => String(error?.message ?? error).split("\n")[0];

mkdirSync(join(out, "raw"), { recursive: true });
mkdirSync(join(out, "sheets"), { recursive: true });
mkdirSync(join(out, "dom"), { recursive: true });
mkdirSync(join(out, "sheets-src"), { recursive: true });
const browser = await chromium.launch({ executablePath });

/** Opens the app at the cell's route and clicks the surface's extra control. Returns the page and a note (route that
 * the app normalised, for instance). */
async function openApp(cell, width, theme) {
	const page = await browser.newPage({ viewport: { width, height: 900 } });
	const route = appRoute(cell, theme);
	await page.goto(`${appOrigin}/${route}`);
	let note = "";
	try {
		await page.waitForFunction(
			(hash) => document.getElementById("app")?.dataset.route === hash,
			route,
			{ timeout: 20000 },
		);
	} catch {
		const actual = await page.evaluate(
			() => document.getElementById("app")?.dataset.route ?? "",
		);
		note = `app route settled on ${actual || "nothing"}`;
	}
	if (cell.surface.after) {
		await page
			.locator(cell.surface.after)
			.first()
			.evaluate((e) => e.click());
		await page.waitForTimeout(250);
	}
	await page.waitForTimeout(250);
	return { page, note };
}

async function openMock(cell, width, theme) {
	const page = await browser.newPage({ viewport: { width, height: 900 } });
	await page.goto(`${mockOrigin}/mockup.html`);
	await page.waitForSelector(".tab");
	await page.addStyleTag({ content: hostCss });
	await page.evaluate(
		`theme=${JSON.stringify(theme)};applyTheme();${mockHelper}${mockSteps(cell)}`,
	);
	await page.waitForTimeout(250);
	return { page, note: await page.evaluate(() => window.mockNote ?? "") };
}

async function finishShot(page, width, name) {
	const note =
		(await page.evaluate(() => innerWidth)) === width
			? ""
			: `viewport is not ${width}`;
	await page.evaluate(writeNonce, nonce);
	await page.screenshot({ path: join(out, "raw", name) });
	return note;
}

/** Which audiences each school offers, from the mockup's `vaAllowed`, and whether the app's View as button agrees. */
const gating = {};
async function checkGating() {
	const mock = await browser.newPage({
		viewport: { width: 1100, height: 900 },
	});
	await mock.goto(`${mockOrigin}/mockup.html`);
	await mock.waitForSelector(".tab");
	for (const school of Object.keys(schoolNames)) {
		const allowed = await mock.evaluate(
			`setSchool('${school}');SUBS.map(([k])=>[k,vaAllowed(sch(),k)])`,
		);
		const youRow = await mock.evaluate("SUB_NAME[VW(sch()).you]");
		for (const [audience, offered] of allowed) {
			const name = audiences.find(({ id }) => id === audience).name;
			const page = await browser.newPage({
				viewport: { width: 1100, height: 900 },
			});
			const route = `#/${school}/dashboard?as=${audience}&theme=light`;
			await page.goto(`${appOrigin}/${route}`);
			await page.waitForSelector("[data-test=view-as]", { timeout: 20000 });
			await page.waitForTimeout(300);
			const label = (
				await page.locator("[data-test=view-as]").first().innerText()
			)
				.replace(/\s+/g, " ")
				.trim();
			await page.close();
			const appShows = label.toLowerCase().includes(name.toLowerCase());
			gating[`${school}/${audience}`] = {
				offered,
				youRow,
				label,
				agrees: offered ? appShows : !appShows,
			};
		}
	}
	await mock.close();
}

/** One cell: 12 raw shots (6 app, 6 mock), the DOM text, and the contact sheet. */
async function runCell(cell) {
	const result = {
		...cell,
		status: "shot",
		appNote: "",
		mockNote: "",
		files: [],
	};
	const key = `${cell.school}/${cell.audience.id}`;
	if (!gating[key].offered) {
		result.status = "not offered";
		return result;
	}
	let mockFailure = "";
	for (const { width, theme } of rows) {
		const base = `${cell.id}-${width}-${theme}`;
		const entry = { width, theme, app: null, mock: null, appNote: "" };
		try {
			const { page, note } = await openApp(cell, width, theme);
			if (width === 1100 && theme === "light") {
				const text = await page.evaluate(
					() => document.getElementById("app")?.innerText ?? "",
				);
				writeFileSync(join(out, "dom", `${cell.id}.txt`), `${text}\n`);
			}
			entry.appNote = [note, await finishShot(page, width, `${base}-app.png`)]
				.filter(Boolean)
				.join("; ");
			entry.app = `${base}-app.png`;
			await page.close();
		} catch (error) {
			entry.appNote = `app: ${firstLine(error)}`;
		}
		if (!mockFailure) {
			try {
				const { page, note: stepNote } = await openMock(cell, width, theme);
				const note = await finishShot(page, width, `${base}-mock.png`);
				entry.mock = `${base}-mock.png`;
				entry.mockNote = [stepNote, note].filter(Boolean).join("; ");
				await page.close();
			} catch (error) {
				mockFailure = firstLine(error);
			}
		}
		if (mockFailure)
			entry.mockNote = `unreachable in the mockup: ${mockFailure}`;
		result.files.push(entry);
	}
	result.mockNote = mockFailure
		? `unreachable in the mockup: ${mockFailure}`
		: [
				...new Set(result.files.map((entry) => entry.mockNote).filter(Boolean)),
			].join(" | ");
	result.appNote = [
		...new Set(result.files.map((entry) => entry.appNote).filter(Boolean)),
	].join(" | ");
	if (mockFailure) result.status = "app only (mockup unreachable)";
	else if (result.mockNote.includes("unreachable by a person"))
		result.status = "shot (mockup cannot reach the surface)";
	await renderSheet(result);
	return result;
}

const scale = 0.42;
const tileHeight = Math.round(900 * scale);
function tile(file, note, width) {
	const w = Math.round(width * scale);
	if (file)
		return `<img src="file://${join(out, "raw", file)}" style="width:${w}px;height:${tileHeight}px">`;
	return `<div class="note" style="width:${w}px;height:${tileHeight}px">${note.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</div>`;
}
async function renderSheet(result) {
	const title = `${result.surface.id} · ${result.audience.name} · ${schoolNames[result.school]}`;
	const body = result.files
		.map(
			({ width, theme, app, mock, appNote, mockNote }) => `<tr>
<th>${width}<br>${theme}</th>
<td>${tile(app, appNote || "app shot failed", width)}</td>
<td>${tile(mock, mockNote || "no mockup shot", width)}</td>
</tr>`,
		)
		.join("\n");
	const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:6px;background:#888;font:12px ui-monospace,monospace;color:#000;width:max-content}
h1{font-size:13px;margin:0 0 4px;padding:3px 6px;background:#fff}
table{border-collapse:separate;border-spacing:4px 3px}
th{width:44px;text-align:right;vertical-align:top;color:#fff;font-weight:bold}
td{vertical-align:top;padding:0}
thead th{text-align:left;background:#fff;color:#000;padding:2px 6px}
img{display:block;background:#fff}
.note{box-sizing:border-box;background:#fdd;border:1px dashed #a00;padding:8px;word-break:break-word}
</style><h1>${title}</h1><table><thead><tr><th></th><th>APP</th><th>MOCKUP</th></tr></thead><tbody>${body}</tbody></table>`;
	const source = join(out, "sheets-src", `${result.id}.html`);
	writeFileSync(source, html);
	const page = await browser.newPage({
		viewport: { width: 1100, height: 600 },
	});
	await page.goto(`file://${source}`);
	await page.evaluate(() =>
		Promise.all(
			[...document.images].map((image) => image.decode().catch(() => {})),
		),
	);
	await page.screenshot({
		path: join(out, "sheets", `${result.id}.png`),
		fullPage: true,
	});
	await page.close();
}

await checkGating();
const queue = [...cells];
const results = [];
await Promise.all(
	Array.from({ length: jobs }, async () => {
		while (queue.length) {
			const cell = queue.shift();
			try {
				results.push(await runCell(cell));
			} catch (error) {
				results.push({
					...cell,
					status: `failed: ${firstLine(error)}`,
					appNote: "",
					mockNote: "",
					files: [],
				});
			}
			process.stdout.write(`${cell.id} done\n`);
		}
	}),
);
await browser.close();

const order = new Map(cells.map((cell, index) => [cell.id, index]));
results.sort((a, b) => order.get(a.id) - order.get(b.id));
const lines = [
	"# Whole-app evidence r1",
	"",
	`App ${appOrigin}, mockup ${mockOrigin}. Widths ${widths.join(", ")} px x ${themes.join(", ")}, viewport height 900. Each shot carries a 4-character nonce on a yellow box in the bottom-right corner. Sheets: \`sheets/<cell>.png\` (rows: width x theme; columns: app | mockup). Raw shots: \`raw/\`. App text at 1100 light: \`dom/<cell>.txt\`.`,
	"",
	"## School per surface",
	"",
	...surfaces
		.filter((surface) => !only || only.includes(surface.id))
		.map(
			(surface) =>
				`- **${surface.id}**: ${schoolNames[surface.school]} (\`${surface.school}\`)${surface.why ? `, ${surface.why}` : ""}.${surface.school === "vol" ? "" : ` Owner is not offered there, so an extra owner cell is shot at Vibes of Light (\`${surface.id}-owner-vol\`).`}`,
		),
	"",
	"## Audience gating (View as)",
	"",
	"The mockup's `vaAllowed` decides what is offered; the app is checked by loading `as=<audience>` and reading its View as button. An unoffered audience must leave the button on the viewer's own row.",
	"",
	"| School | Viewer is | Audience | Mockup offers | App View as button reads | Agree |",
	"| --- | --- | --- | --- | --- | --- |",
	...Object.entries(gating).map(([key, value]) => {
		const [school, audience] = key.split("/");
		return `| ${schoolNames[school]} | ${value.youRow} | ${audience} | ${value.offered ? "yes" : "not offered"} | ${value.label} | ${value.agrees ? "yes" : "NO"} |`;
	}),
	"",
	"## Cells",
	"",
	"Mockup steps run on a fresh page after the host CSS, `theme=<theme>;applyTheme()`: `setSchool(<school>)`, `setVa(<audience>)` (the View as menu's action), then the surface's steps. App route shown for the light theme (dark swaps `theme=`).",
	"",
	"| Cell | Surface | Audience | School | Status | App route | Mockup steps | Notes |",
	"| --- | --- | --- | --- | --- | --- | --- | --- |",
	...results.map((result) => {
		const offered = result.status !== "not offered";
		const notes =
			result.status === "not offered"
				? `not offered at ${schoolNames[result.school]} in the mockup or the app (${gating[`${result.school}/${result.audience.id}`].agrees ? "app refuses it too" : "APP DOES NOT REFUSE IT"})`
				: [result.appNote, result.mockNote]
						.filter(Boolean)
						.join(" | ")
						.replace(/\|/g, "/");
		const route = offered ? `\`${appRoute(result, "light")}\`` : "";
		const steps = offered
			? `\`${mockSteps(result).replace(/\|/g, "\\|")}\``
			: "";
		const sheet = offered
			? `[${result.id}](sheets/${result.id}.png)`
			: result.id;
		return `| ${sheet} | ${result.surface.id}${result.surface.after ? " (click settings-button)" : ""} | ${result.audience.id} | ${schoolNames[result.school]} | ${result.status} | ${route} | ${steps} | ${notes} |`;
	}),
	"",
];
writeFileSync(join(out, "index.md"), lines.join("\n"));
const sheetCount = results.filter(
	(result) =>
		result.status !== "not offered" && !result.status.startsWith("failed"),
).length;
process.stdout.write(
	`${sheetCount} sheets, ${results.filter((r) => r.status === "not offered").length} not offered, ${results.filter((r) => r.status.includes("mockup")).length} mockup-unreachable, ${results.filter((r) => r.status.startsWith("failed")).length} failed, in ${out}\n`,
);
