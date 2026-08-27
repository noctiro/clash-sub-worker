import { PROVIDERS } from "../config/providers";
import {
  COMPILED_CLASH_TEMPLATE,
  EXCLUSIVE_TAG_GROUPS,
  MINIFIED_UI,
  TAGS,
  TEMPLATE_REVISION,
} from "../generated/public-config";
import {
  PRIVATE_CONFIG_REVISION,
  PRIVATE_SETTINGS,
} from "../generated/private-config";
import { randomNonce } from "./crypto";
import { ConfigurationError, HttpError } from "./errors";
import {
  PRIVATE_NO_STORE,
  applyBaseSecurityHeaders,
  contentDisposition,
  escapeHtml,
} from "./http";
import { renderCompiledTemplate } from "./template";

const TAG_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const ALLOWED_TAGS: ReadonlySet<string> = new Set<string>(TAGS);
const TAG_ORDER = new Map<string, number>(
  TAGS.map((value, index): [string, number] => [value, index]),
);
const EXCLUSIVE_GROUPS: readonly (readonly string[])[] = EXCLUSIVE_TAG_GROUPS;
const SUBSCRIPTION_CLIENT_PATTERN =
  /clash|mihomo|stash|sing-box|surge|shadowrocket|quantumult|loon|v2ray|nekobox/iu;
const CONFIG_REVISION = TEMPLATE_REVISION + PRIVATE_CONFIG_REVISION;

function replaceRequired(
  text: string,
  placeholder: string,
  replacement: string,
): string {
  const count = text.split(placeholder).length - 1;
  if (count !== 1) {
    throw new ConfigurationError(
      "Compiled template expected one " +
        placeholder +
        ", found " +
        String(count),
    );
  }
  return text.replace(placeholder, replacement);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function parseTags(searchParams: URLSearchParams): string[] {
  const rawTags = searchParams
    .getAll("tag")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);

  if (rawTags.length > TAGS.length) {
    throw new HttpError(400, "Too many tags");
  }

  const selected = [...new Set(rawTags)];
  for (const tag of selected) {
    if (!TAG_PATTERN.test(tag) || !ALLOWED_TAGS.has(tag)) {
      throw new HttpError(400, "Unknown tag: " + tag);
    }
  }

  for (const group of EXCLUSIVE_GROUPS) {
    if (selected.filter((tag) => group.includes(tag)).length > 1) {
      throw new HttpError(400, "Mutually exclusive tags may not be combined");
    }
  }

  return selected.sort(
    (left, right) =>
      (TAG_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (TAG_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER),
  );
}

export function shouldRenderHtml(request: Request, url: URL): boolean {
  const formats = url.searchParams.getAll("format");
  if (formats.length > 1) {
    throw new HttpError(400, "Only one format parameter is allowed");
  }

  const format = formats[0];
  if (format !== undefined && format !== "html" && format !== "yaml") {
    throw new HttpError(400, "format must be html or yaml");
  }
  if (format === "html") return true;
  if (format === "yaml") return false;

  const userAgent = request.headers.get("User-Agent") ?? "";
  if (SUBSCRIPTION_CLIENT_PATTERN.test(userAgent)) return false;
  if (request.headers.get("Sec-Fetch-Dest") === "document") return true;
  return (request.headers.get("Accept") ?? "").includes("text/html");
}

export function browserUiResponse(head: boolean): Response {
  const nonce = randomNonce();
  const headers = applyBaseSecurityHeaders(new Headers());
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'nonce-" +
      nonce +
      "'; style-src 'nonce-" +
      nonce +
      "'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
  headers.set("Vary", "Accept, Sec-Fetch-Dest, User-Agent");
  if (head) return new Response(null, { status: 200, headers });

  const profileName = escapeHtml(PRIVATE_SETTINGS.subscription.name);
  const html = MINIFIED_UI.replaceAll("__CSP_NONCE__", nonce).replaceAll(
    "__PROFILE_NAME__",
    profileName,
  );
  return new Response(html, { status: 200, headers });
}

function buildProviderBlock(origin: string, token: string): string {
  const entries = Object.entries(PROVIDERS).map(([name, provider]) => {
    const providerUrl =
      provider.delivery === "direct"
        ? provider.url
        : origin + "/proxy/" + name + "?token=" + encodeURIComponent(token);

    return [
      "  " + name + ":",
      "    <<: *p",
      "    url: " + yamlString(providerUrl),
      "    override:",
      "      additional-prefix: " + yamlString(provider.prefix),
    ].join("\n");
  });

  if (entries.length === 0) {
    throw new ConfigurationError("At least one provider must be configured");
  }
  return entries.join("\n");
}

function buildYaml(
  origin: string,
  token: string,
  controllerSecret: string,
  tags: readonly string[],
): string {
  const selectedTags = new Set(tags);
  const providerBlock = buildProviderBlock(origin, token);
  let yaml = renderCompiledTemplate(COMPILED_CLASH_TEMPLATE, selectedTags);
  yaml = replaceRequired(yaml, "__PROVIDER_BLOCK__", providerBlock);

  const controllerPlaceholderCount =
    yaml.split("__CONTROLLER_SECRET__").length - 1;
  if (controllerPlaceholderCount > 1) {
    throw new ConfigurationError(
      "Compiled template contains duplicate controller placeholders",
    );
  }
  if (controllerPlaceholderCount === 1) {
    yaml = yaml.replace(
      "__CONTROLLER_SECRET__",
      yamlString(controllerSecret),
    );
  }

  return yaml;
}

function profilePageUrl(
  origin: string,
  token: string,
  tags: readonly string[],
): string {
  const url = new URL("/sub", origin);
  url.searchParams.set("token", token);
  url.searchParams.set("format", "html");
  for (const tag of tags) url.searchParams.append("tag", tag);
  return url.href;
}

export function subscriptionResponse(
  requestUrl: URL,
  token: string,
  controllerSecret: string,
  tags: readonly string[],
  head: boolean,
): Response {
  const subscription = PRIVATE_SETTINGS.subscription;

  const headers = new Headers({
    "Cache-Control": PRIVATE_NO_STORE,
    "Content-Disposition": contentDisposition(subscription.name),
    "Content-Type": "text/yaml; charset=utf-8",
    "X-Config-Revision": CONFIG_REVISION,
    "X-Content-Type-Options": "nosniff",
  });
  headers.set(
    "Profile-Title",
    "profileTitle" in subscription &&
      typeof subscription.profileTitle === "string"
      ? subscription.profileTitle
      : subscription.name,
  );
  if (subscription.updateIntervalHours !== null) {
    headers.set(
      "Profile-Update-Interval",
      String(subscription.updateIntervalHours),
    );
  }
  if (subscription.userinfo !== null) {
    headers.set("Subscription-Userinfo", subscription.userinfo);
  }
  if (subscription.supportUrl !== null) {
    headers.set("Support-Url", subscription.supportUrl);
  }
  headers.set(
    "Profile-Web-Page-Url",
    profilePageUrl(requestUrl.origin, token, tags),
  );
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Vary", "Accept, Sec-Fetch-Dest, User-Agent");

  if (head) return new Response(null, { status: 200, headers });
  const yaml = buildYaml(requestUrl.origin, token, controllerSecret, tags);
  return new Response(yaml, { status: 200, headers });
}
