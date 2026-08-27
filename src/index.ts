import { getProvider } from "./config/providers";
import { authenticate } from "./lib/auth";
import {
  ConfigurationError,
  HttpError,
  UpstreamError,
} from "./lib/errors";
import {
  methodNotAllowedResponse,
  plainResponse,
  rateLimitedResponse,
} from "./lib/http";
import { proxyProvider } from "./lib/proxy";
import {
  browserUiResponse,
  parseTags,
  shouldRenderHtml,
  subscriptionResponse,
} from "./lib/subscription";

const PROXY_PATH_PATTERN = /^\/proxy\/([a-z0-9][a-z0-9_-]{0,31})$/u;

async function enforceRateLimit(
  limiter: RateLimit,
  key: string,
  head: boolean,
): Promise<Response | undefined> {
  const { success } = await limiter.limit({ key });
  return success ? undefined : rateLimitedResponse(head);
}

async function routeRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const head = request.method === "HEAD";

  if (url.pathname === "/healthz") {
    if (request.method !== "GET" && !head) {
      return methodNotAllowedResponse(head);
    }
    return plainResponse("ok", 200, head);
  }

  const proxyMatch = PROXY_PATH_PATTERN.exec(url.pathname);
  const protectedRoute = url.pathname === "/sub" || proxyMatch !== null;
  if (!protectedRoute) return plainResponse("Not Found", 404, head);

  // 受保护路由先鉴权：缺失/异常 token 即使方法错误也只会进入 shadowban。
  const auth = await authenticate(url);
  if (!auth.authenticated) return auth.response;

  if (request.method !== "GET" && !head) {
    return methodNotAllowedResponse(head);
  }

  if (url.pathname === "/sub") {
    const limited = await enforceRateLimit(
      env.SUB_RATE_LIMITER,
      auth.key + ":sub",
      head,
    );
    if (limited) return limited;

    const tags = parseTags(url.searchParams);
    if (shouldRenderHtml(request, url)) {
      return browserUiResponse(head);
    }
    return subscriptionResponse(
      url,
      auth.token,
      auth.controllerSecret,
      tags,
      head,
    );
  }

  const providerName = proxyMatch?.[1];
  if (!providerName) return plainResponse("Not Found", 404, head);
  const provider = getProvider(providerName);
  if (!provider || provider.delivery === "direct") {
    return plainResponse("Not Found", 404, head);
  }

  const limited = await enforceRateLimit(
    env.PROXY_RATE_LIMITER,
    auth.key + ":proxy:" + providerName,
    head,
  );
  if (limited) return limited;

  return proxyProvider(request, ctx, providerName, provider, head);
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      return await routeRequest(request, env, ctx);
    } catch (error) {
      const path = new URL(request.url).pathname;
      const requestId = request.headers.get("CF-Ray") ?? "local";

      if (error instanceof HttpError) {
        return plainResponse(
          error.message,
          error.status,
          request.method === "HEAD",
        );
      }
      if (error instanceof UpstreamError) {
        console.error(
          JSON.stringify({
            event: "upstream_error",
            error: error.message,
            path,
            requestId,
          }),
        );
        return plainResponse(
          error.message,
          error.status,
          request.method === "HEAD",
        );
      }

      console.error(
        JSON.stringify({
          event: "request_error",
          error: error instanceof Error ? error.message : "Unknown error",
          kind: error instanceof Error ? error.name : "UnknownError",
          path,
          requestId,
        }),
      );
      return plainResponse(
        error instanceof ConfigurationError
          ? "Service configuration error"
          : "Internal Server Error",
        error instanceof ConfigurationError ? 503 : 500,
        request.method === "HEAD",
      );
    }
  },
} satisfies ExportedHandler<Env>;
