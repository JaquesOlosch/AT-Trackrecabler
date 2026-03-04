import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// Required for OAuth redirect: Audiotool sends users back to http://127.0.0.1:5173/
// Add this exact URL as Redirect URI at https://developer.audiotool.com/applications
export default defineConfig({
  plugins: [nodePolyfills()],
  base: process.env.GITHUB_PAGES === "true" ? "/AT-Trackrecabler/" : "/",
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});
