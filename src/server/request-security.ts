function configuredPublicOrigin(): string | undefined {
  const value = process.env.PUBLIC_ORIGIN?.trim();
  if (!value) return undefined;
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("PUBLIC_ORIGIN moet alleen een geldige http(s)-origin bevatten.");
  }
  return url.origin;
}

export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  return origin === (configuredPublicOrigin() ?? new URL(request.url).origin);
}
