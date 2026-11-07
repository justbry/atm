import { defineConfig } from "vite";

/** The size gate's build: the app mounted with null adapters, no fixtures (protocol §6 S). */
export default defineConfig({
	esbuild: { jsx: "automatic", jsxImportSource: "preact" },
	build: {
		target: "es2022",
		sourcemap: false,
		outDir: "dist-size",
		manifest: true,
		emptyOutDir: true,
		rollupOptions: { input: "gates/size-entry.html" },
	},
});
