import type { ProxiedProviderDefinition } from "../config/providers";
import { PRIVATE_SETTINGS } from "../generated/private-config";
import {
  DEFAULT_PROVIDER_USER_AGENT,
  PROVIDER_LIMITS,
} from "../config/provider-limits";
import { UpstreamError } from "./errors";
import { PRIVATE_NO_STORE, applyBaseSecurityHeaders } from "./http";
import {
  PROVIDER_YAML_CACHE_REVISION,
  sanitizeProviderYaml,
} from "./provider-yaml";

const MAX_REDIRECTS = 5;
const MAX_PROVIDER_BODY_BYTES = PROVIDER_LIMITS.bodyBytes;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FORWARDED_RESPONSE_HEADERS = new Set([
  "content-language",
  "content-type",
  "profile-update-interval",
  "subscription-userinfo",
]);

function structuredCacheError(event: string, error: unknown): void {
  console.error(
    JSON.stringify({
      event,
      error: error instanceof Error ? error.name : "UnknownError",
    }),
  );
}

function sanitizedHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of source) {
    if (FORWARDED_RESPONSE_HEADERS.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  }
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/octet-stream");
  }
  return headers;
}

function transformedYamlHeaders(source: Headers): Headers {
  const headers = sanitizedHeaders(source);
  headers.set("Content-Type", "text/yaml; charset=utf-8");
  return headers;
}

function clientResponse(response: Response, head: boolean): Response {
  const headers = applyBaseSecurityHeaders(new Headers(response.headers));
  headers.set("Cache-Control", PRIVATE_NO_STORE);
  return new Response(head ? null : response.body, {
    status: response.status,
    headers,
  });
}

async function fetchFollowingRedirects(
  initialUrl: string,
  userAgent: string,
  signal: AbortSignal,
): Promise<Response> {
  let currentUrl = initialUrl;

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetch(currentUrl, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: {
        Accept: "*/*",
        "Accept-Encoding": "identity",
        "User-Agent": userAgent,
      },
      cf: {
        cacheTtl: 0,
      },
    });

    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("Location");
    if (!location) return response;
    if (response.body) {
      await response.body.cancel().catch(() => undefined);
    }
    if (redirect === MAX_REDIRECTS) {
      throw new UpstreamError(502, "Upstream redirected too many times");
    }

    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.protocol !== "https:") {
      throw new UpstreamError(502, "Upstream redirected to an unsafe URL");
    }
    if (nextUrl.username || nextUrl.password) {
      throw new UpstreamError(502, "Upstream redirected to an unsafe URL");
    }
    nextUrl.hash = "";
    currentUrl = nextUrl.href;
  }

  throw new UpstreamError(502, "Upstream redirect failure");
}

async function fetchWithTimeout(
  url: string,
  userAgent: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchFollowingRedirects(url, userAgent, controller.signal);
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new UpstreamError(504, "Upstream timeout");
    }
    throw new UpstreamError(502, "Failed to reach upstream");
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedBody(
  response: Response,
  timeoutMs: number,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();

  const rawContentLength = response.headers.get("Content-Length");
  const contentLength =
    rawContentLength !== null && /^\d+$/u.test(rawContentLength)
      ? Number(rawContentLength)
      : undefined;
  if (
    contentLength !== undefined &&
    contentLength > MAX_PROVIDER_BODY_BYTES
  ) {
    await response.body.cancel().catch(() => undefined);
    throw new UpstreamError(502, "Upstream subscription is too large");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const preallocated =
    contentLength !== undefined ? new Uint8Array(contentLength) : undefined;
  let usingPreallocated = preallocated !== undefined;
  let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel("Upstream body timeout").catch(() => undefined);
  }, timeoutMs);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw new UpstreamError(504, "Upstream timeout");
      if (done) break;
      const chunkOffset = total;
      total += value.byteLength;
      if (total > MAX_PROVIDER_BODY_BYTES) {
        await reader.cancel("Upstream body too large").catch(() => undefined);
        throw new UpstreamError(502, "Upstream subscription is too large");
      }
      if (
        usingPreallocated &&
        preallocated !== undefined &&
        total <= preallocated.byteLength
      ) {
        preallocated.set(value, chunkOffset);
      } else {
        if (usingPreallocated && preallocated !== undefined) {
          if (chunkOffset > 0) {
            chunks.push(preallocated.subarray(0, chunkOffset));
          }
          usingPreallocated = false;
        }
        chunks.push(value);
      }
    }
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    if (timedOut) throw new UpstreamError(504, "Upstream timeout");
    throw new UpstreamError(502, "Failed to read upstream");
  } finally {
    clearTimeout(timer);
  }

  if (usingPreallocated && preallocated !== undefined) {
    return total === preallocated.byteLength
      ? preallocated
      : preallocated.slice(0, total);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function proxyProvider(
  request: Request,
  ctx: ExecutionContext,
  providerName: string,
  provider: ProxiedProviderDefinition,
  head: boolean,
): Promise<Response> {
  const timeoutMs = PRIVATE_SETTINGS.runtime.upstreamTimeoutMs;
  const cacheTtl = PRIVATE_SETTINGS.runtime.providerCacheTtlSeconds;
  const upstreamUrl = provider.url;
  const upstreamUserAgent =
    provider.userAgent?.trim() || DEFAULT_PROVIDER_USER_AGENT;
  const cache = caches.default;
  let cacheUsable = cacheTtl > 0;
  let cacheKey: string | undefined;

  if (cacheUsable) {
    const cacheUrl = new URL(request.url);
    cacheUrl.pathname =
      "/_cf_worker_internal/" +
      PROVIDER_YAML_CACHE_REVISION +
      "/ttl/" +
      String(cacheTtl) +
      "/provider/" +
      encodeURIComponent(providerName) +
      "/" +
      provider.cacheKey;
    cacheUrl.search = "";
    cacheKey = cacheUrl.href;

    try {
      const cached = await cache.match(cacheKey);
      if (cached) return clientResponse(cached, head);
    } catch (error) {
      cacheUsable = false;
      structuredCacheError("provider_cache_read_error", error);
    }
  }

  const upstream = await fetchWithTimeout(
    upstreamUrl,
    upstreamUserAgent,
    timeoutMs,
  );
  if (!upstream.ok) {
    if (upstream.body) {
      await upstream.body.cancel().catch(() => undefined);
    }
    throw new UpstreamError(502, "Upstream returned an error");
  }

  const upstreamBody = await readBoundedBody(upstream, timeoutMs);
  const sanitizedYaml = sanitizeProviderYaml(
    upstreamBody,
    upstream.headers.get("Content-Type"),
  );
  const headers = sanitizedYaml
    ? transformedYamlHeaders(upstream.headers)
    : sanitizedHeaders(upstream.headers);
  headers.set("Cache-Control", "public, max-age=" + String(cacheTtl));
  const body =
    upstream.status === 204 || upstream.status === 205
      ? null
      : (sanitizedYaml?.body ?? upstreamBody);
  const normalized = new Response(body, {
    status: upstream.status,
    headers,
  });

  if (sanitizedYaml) {
    console.log(
      JSON.stringify({
        event: "provider_yaml_sanitized",
        provider: providerName,
        kept: sanitizedYaml.kept,
        removed: sanitizedYaml.removed,
      }),
    );
  }

  if (
    cacheUsable &&
    cacheKey !== undefined &&
    upstream.status === 200 &&
    normalized.body !== null
  ) {
    const cacheCopy = normalized.clone();
    ctx.waitUntil(
      cache
        .put(cacheKey, cacheCopy)
        .catch((error) =>
          structuredCacheError("provider_cache_write_error", error),
        ),
    );
  }

  return clientResponse(normalized, head);
}
