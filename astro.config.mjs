import { defineConfig } from "astro/config";
import node from "@astrojs/node";

export default defineConfig({
  adapter: node({
    mode: "standalone",
  }),
  devToolbar: {
    enabled: false,
  },
  output: "server",
  server: {
    host: true,
  },
});
