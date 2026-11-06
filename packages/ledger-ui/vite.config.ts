import { defineConfig } from "vite";

export default defineConfig({
	esbuild: { jsx: "automatic", jsxImportSource: "preact" },
	build: { target: "es2022", sourcemap: false },
	server: { port: 5181, strictPort: true },
});
