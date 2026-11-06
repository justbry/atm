/**
 * Evidence screenshots (protocol §8) with headless Chromium, the fallback while the T3 preview tools are unreachable.
 * Same recipe: each golden entry with `shot.full` at 1100, 728 and 390 px in light and dark; app by hash route plus the
 * entry's steps; mockup by a fresh page, the host tokens, `applyTheme()` and `mockupSteps`; a 4-character nonce written
 * outside #app into every shot (pixels only). Usage, from the repo root, with the app on :5181 and the mockup on :5182:
 *   node plans/ledger-ui/loop/tools/shoot.mjs --slice S0 --out <dir> --side app|mock --nonce K7QX --commit <sha>
 * Optional `--app <origin>` and `--mock <origin>` override the two servers (default http://localhost:5181 and :5182).
 * Needs playwright-core in /tmp/ledger-shots (createRequire below) and the cached Chromium headless shell.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire("/tmp/ledger-shots/package.json");
const { chromium } = require("playwright-core");
const argument = (name) => {
	const index = process.argv.indexOf(name);
	return index > 0 ? process.argv[index + 1] : undefined;
};
const appOrigin = argument("--app") ?? "http://localhost:5181";
const mockOrigin = argument("--mock") ?? "http://localhost:5182";
const slice = argument("--slice");
const out = argument("--out");
const side = argument("--side");
const nonce = argument("--nonce");
const commit = argument("--commit");
const golden = JSON.parse(readFileSync(`packages/ledger-ui/test/golden/${slice}.json`, "utf8"));
const hostCss = readFileSync("plans/ledger-ui/design/mockup-host.css", "utf8");
const executablePath = join(
	homedir(),
	"Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell",
);
const widths = [1100, 728, 390];
const themes = ["light", "dark"];
const writeNonce = (value) => {
	const element = document.createElement("div");
	element.textContent = value;
	element.style.cssText =
		"position:fixed;right:6px;bottom:6px;z-index:2147483647;font:bold 14px ui-monospace,monospace;background:#ff0;color:#000;padding:2px 6px;border:1px solid #000";
	document.body.appendChild(element);
};

mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath });
const files = {};
for (const entry of golden.entries.filter((candidate) => candidate.shot?.full)) {
	for (const width of widths) {
		for (const theme of themes) {
			const page = await browser.newPage({ viewport: { width, height: 900 } });
			if (side === "app") {
				const route = entry.route.replace(/theme=\w+/, `theme=${theme}`);
				await page.goto(`${appOrigin}/${route}`);
				await page.waitForFunction((hash) => document.getElementById("app")?.dataset.route === hash, route);
				for (const step of entry.steps ?? []) {
					if (step.click) await page.click(step.click);
					else if (step.fill) await page.locator(step.fill).evaluate((input, value) => {
						input.value = value;
						input.dispatchEvent(new Event("input", { bubbles: true }));
						input.dispatchEvent(new Event("change", { bubbles: true }));
					}, step.value);
					else if (step.key) await page.locator(step.target).press(step.key);
				}
				await page.waitForTimeout(150);
			} else {
				await page.goto(`${mockOrigin}/mockup.html`);
				await page.waitForSelector(".tab");
				await page.addStyleTag({ content: hostCss });
				await page.evaluate(`theme=${JSON.stringify(theme)};applyTheme();${entry.shot.mockupSteps}`);
				await page.waitForTimeout(150);
			}
			if ((await page.evaluate(() => innerWidth)) !== width) throw new Error(`viewport is not ${width}`);
			await page.evaluate(writeNonce, nonce);
			const name = `${entry.id}-${width}-${theme}.png`;
			await page.screenshot({ path: join(out, name) });
			files[name] = width;
			await page.close();
		}
	}
}
await browser.close();
writeFileSync(join(out, "manifest.json"), `${JSON.stringify({ side, slice, commit, files: Object.keys(files) }, null, "\t")}\n`);
process.stdout.write(`${Object.keys(files).length} shots in ${out}\n`);
