import { mountApp } from "../src/app/mount.tsx";
import { nullReader, nullWriter } from "./null-adapters.ts";

const root = document.getElementById("app");
if (root)
	mountApp(root, {
		reader: nullReader,
		writer: nullWriter,
		clock: { today: "2026-11-05", now: "2026-11-05T12:00" },
	});
