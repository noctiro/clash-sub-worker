import { ConfigurationError } from "./errors";

export const PRIVATE_NO_STORE = "private, no-store, max-age=0";

export function applyBaseSecurityHeaders(headers: Headers): Headers {
  headers.set("Cache-Control", PRIVATE_NO_STORE);
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return headers;
}

export function plainResponse(
  body: string,
  status = 200,
  head = false,
  extraHeaders?: HeadersInit,
): Response {
  const headers = applyBaseSecurityHeaders(new Headers(extraHeaders));
  headers.set("Content-Type", "text/plain; charset=utf-8");
  return new Response(head ? null : body, { status, headers });
}

export function methodNotAllowedResponse(head = false): Response {
  return plainResponse("Method Not Allowed", 405, head, {
    Allow: "GET, HEAD",
  });
}

export function rateLimitedResponse(head = false): Response {
  return plainResponse("Too Many Requests", 429, head, {
    "Retry-After": "60",
  });
}

export function redirectResponse(location: string): Response {
  let target: URL;
  try {
    target = new URL(location);
  } catch {
    throw new ConfigurationError("Shadowban redirect is not a valid URL");
  }
  if (target.protocol !== "https:") {
    throw new ConfigurationError("Shadowban redirect must use HTTPS");
  }

  const headers = applyBaseSecurityHeaders(new Headers());
  headers.set("Location", target.href);
  return new Response(null, { status: 302, headers });
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function contentDisposition(profileName: string): string {
  const normalized = profileName.trim() || "subscription";
  const ascii =
    normalized
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/gu, "")
      .replace(/["\\;]/gu, "_")
      .trim() || "subscription";
  const filename = ascii.endsWith(".yaml") ? ascii : ascii + ".yaml";
  const unicodeFilename = normalized.endsWith(".yaml")
    ? normalized
    : normalized + ".yaml";
  const encoded = encodeURIComponent(unicodeFilename).replace(
    /[!'()*]/gu,
    (character) =>
      "%" + character.charCodeAt(0).toString(16).toUpperCase(),
  );
  return (
    'attachment; filename="' +
    filename +
    '"; filename*=UTF-8\'\'' +
    encoded
  );
}
