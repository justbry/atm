import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The inline theme script in src/app.html (it sets data-theme before first paint, so there is no flash). */
const THEME_SCRIPT = /<script data-theme-script>([\s\S]*?)<\/script>/;

const appHtml = readFileSync(
	fileURLToPath(new URL("./src/app.html", import.meta.url)),
	"utf8",
);
const match = THEME_SCRIPT.exec(appHtml);
if (!match?.[1])
	throw new Error("src/app.html has no <script data-theme-script>");

/** The CSP source for that script, so the prerendered pages' CSP allows exactly it. */
export const THEME_SCRIPT_HASH =
	`sha256-${createHash("sha256").update(match[1]).digest("base64")}` as const;
