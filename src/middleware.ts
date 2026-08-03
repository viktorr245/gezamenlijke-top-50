import { defineMiddleware } from "astro:middleware";
import { authenticatedMember, isAuthenticationEnabled } from "./server/auth";

export const onRequest = defineMiddleware(async (context, next) => {
  if (!isAuthenticationEnabled()) return next();
  const path = context.url.pathname;
  if (path === "/aanmelden" || path.startsWith("/api/auth/")) return next();
  if (authenticatedMember(context.request)) return next();
  if (path.startsWith("/api/")) {
    return Response.json({ error: "Meld je opnieuw aan." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const returnTo = `${path}${context.url.search}`;
  return context.redirect(`/aanmelden?volgende=${encodeURIComponent(returnTo)}`);
});
