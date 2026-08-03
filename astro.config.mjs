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
  // TLS eindigt bij Caddy, waardoor Astro de interne HTTP-origin ziet. Alle
  // schrijvende API-routes controleren zelf tegen PUBLIC_ORIGIN.
  security: {
    checkOrigin: false,
  },
  server: {
    host: true,
  },
});
