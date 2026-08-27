import { parse } from "yaml";
import { PROVIDER_LIMITS } from "../config/provider-limits";
import { PROVIDER_POLICY } from "../generated/public-config";
import { UpstreamError } from "./errors";
import { stringifyProviderProxies } from "./provider-yaml-output";

const EXCLUDED_PROXY_TYPES: ReadonlySet<string> = new Set<string>(
  PROVIDER_POLICY.excludedTypes,
);
const PROXY_NAME_FILTER = new RegExp(PROVIDER_POLICY.nameFilter, "u");
const YAML_CONTENT_TYPES = new Set([
  "application/x-yaml",
  "application/yaml",
  "text/x-yaml",
  "text/yaml",
]);
const JSON_PROXIES_PATTERN = /"proxies"[ \t\r\n]*:/u;
const ASCII_LOWERCASE_P = 0x70;
const ASCII_LEFT_BRACE = 0x7b;
const PROXIES_ASCII = [0x70, 0x72, 0x6f, 0x78, 0x69, 0x65, 0x73] as const;
const UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: false,
});

interface SanitizedProviderYaml {
  body: string;
  kept: number;
  removed: number;
}

export const PROVIDER_YAML_CACHE_REVISION = PROVIDER_POLICY.cacheRevision;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDeclaredYaml(contentType: string | null): boolean {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType !== undefined && YAML_CONTENT_TYPES.has(mediaType);
}

interface ExtractedProxiesDocument {
  document?: string;
  found: boolean;
}

function containsAsciiProxies(bytes: Uint8Array): boolean {
  let offset = 0;
  while ((offset = bytes.indexOf(ASCII_LOWERCASE_P, offset)) !== -1) {
    let matched = true;
    for (let index = 1; index < PROXIES_ASCII.length; index += 1) {
      if (bytes[offset + index] !== PROXIES_ASCII[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
    offset += 1;
  }
  return false;
}

function startsWithJsonObject(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      continue;
    }
    return byte === ASCII_LEFT_BRACE;
  }
  return false;
}

function extractProxiesDocument(source: string): ExtractedProxiesDocument {
  if (!source.includes("proxies")) return { found: false };

  // RegExp 放在函数内，避免带 global 状态的对象跨请求共享 lastIndex。
  const keyPattern = /^(?:proxies|"proxies"|'proxies')[ \t]*:/gmu;
  const first = keyPattern.exec(source);
  if (!first) return { found: false };
  if (keyPattern.exec(source)) return { found: true };

  const start = first.index;
  const firstLineEnd = source.indexOf("\n", start);
  if (firstLineEnd === -1) {
    return { found: true, document: source.slice(start) };
  }

  let end = source.length;
  let lineStart = firstLineEnd + 1;
  while (lineStart < source.length) {
    const lineEnd = source.indexOf("\n", lineStart);
    const boundary = lineEnd === -1 ? source.length : lineEnd;
    const firstByte = source.charCodeAt(lineStart);
    const blank =
      boundary === lineStart ||
      (boundary === lineStart + 1 && firstByte === 0x0d);
    const indented = firstByte === 0x20 || firstByte === 0x09;
    const comment = firstByte === 0x23;
    if (!blank && !indented && !comment) {
      end = lineStart;
      break;
    }
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }

  return {
    found: true,
    document: source.slice(start, end),
  };
}

function parseYaml(source: string): unknown {
  return parse(source, {
    maxAliasCount: 32,
    merge: true,
    prettyErrors: false,
    schema: "core",
    strict: true,
    uniqueKeys: true,
  });
}

function validateProxyValues(proxies: readonly unknown[]): void {
  if (proxies.length > PROVIDER_LIMITS.proxies) {
    throw new UpstreamError(502, "Upstream YAML contains too many proxies");
  }

  const seen = new WeakSet<object>();
  const stack = proxies.map((value) => ({ value, depth: 0 }));
  let nodes = 0;
  let stringCodeUnits = 0;

  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) break;
    const { value, depth } = entry;
    nodes += 1;
    if (nodes > PROVIDER_LIMITS.nodes) {
      throw new UpstreamError(502, "Upstream YAML is too complex");
    }

    if (typeof value === "string") {
      if (value.length > PROVIDER_LIMITS.scalarCodeUnits) {
        throw new UpstreamError(502, "Upstream YAML contains an oversized value");
      }
      stringCodeUnits += value.length;
      if (stringCodeUnits > PROVIDER_LIMITS.totalStringCodeUnits) {
        throw new UpstreamError(502, "Upstream YAML contains too much text");
      }
      continue;
    }
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "number"
    ) {
      continue;
    }
    if (typeof value !== "object") {
      throw new UpstreamError(502, "Upstream YAML contains an unsupported value");
    }
    if (depth >= PROVIDER_LIMITS.depth) {
      throw new UpstreamError(502, "Upstream YAML is nested too deeply");
    }
    if (seen.has(value)) {
      throw new UpstreamError(502, "Upstream YAML aliases are too complex");
    }
    seen.add(value);

    if (Array.isArray(value)) {
      if (value.length > PROVIDER_LIMITS.nestedSequenceItems) {
        throw new UpstreamError(502, "Upstream YAML sequence is too large");
      }
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    if (!isRecord(value)) {
      throw new UpstreamError(502, "Upstream YAML contains an unsupported object");
    }

    const entries = Object.entries(value);
    if (entries.length > PROVIDER_LIMITS.mappingEntries) {
      throw new UpstreamError(502, "Upstream YAML mapping is too large");
    }
    for (const [key, item] of entries) {
      if (key.length > PROVIDER_LIMITS.keyCodeUnits) {
        throw new UpstreamError(502, "Upstream YAML contains an oversized key");
      }
      stringCodeUnits += key.length;
      if (stringCodeUnits > PROVIDER_LIMITS.totalStringCodeUnits) {
        throw new UpstreamError(502, "Upstream YAML contains too much text");
      }
      stack.push({ value: item, depth: depth + 1 });
    }
  }
}

function normalizeAllowedProxy(
  value: unknown,
  seenNames: Set<string>,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const name = value.name;
  const type = value.type;
  if (typeof name !== "string" || typeof type !== "string") return undefined;

  const normalizedName = name.trim();
  const normalizedType = type.trim().toLowerCase();
  if (!normalizedName || !normalizedType) return undefined;
  if (normalizedName.length > 512 || normalizedType.length > 32) {
    return undefined;
  }
  if (EXCLUDED_PROXY_TYPES.has(normalizedType)) return undefined;
  if (!PROXY_NAME_FILTER.test(normalizedName)) return undefined;
  if (seenNames.has(normalizedName)) return undefined;
  seenNames.add(normalizedName);
  if (name === normalizedName && type === normalizedType) return value;
  return { ...value, name: normalizedName, type: normalizedType };
}

export function sanitizeProviderYaml(
  bytes: Uint8Array,
  contentType: string | null,
): SanitizedProviderYaml | undefined {
  if (bytes.byteLength > PROVIDER_LIMITS.bodyBytes) {
    throw new UpstreamError(502, "Upstream subscription is too large");
  }
  const declaredYaml = isDeclaredYaml(contentType);
  if (
    !declaredYaml &&
    !containsAsciiProxies(bytes) &&
    !startsWithJsonObject(bytes)
  ) {
    return undefined;
  }

  let source: string;
  try {
    source = UTF8_DECODER.decode(bytes);
  } catch {
    if (declaredYaml) {
      throw new UpstreamError(502, "Upstream YAML is not valid UTF-8");
    }
    return undefined;
  }

  const extracted = extractProxiesDocument(source);
  const trimmed = source.trimStart();
  const looksLikeJsonConfig =
    trimmed.startsWith("{") && JSON_PROXIES_PATTERN.test(trimmed);
  if (!declaredYaml && !extracted.found && !looksLikeJsonConfig) {
    return undefined;
  }

  let parsed: unknown;
  let parseFailed = true;
  const candidates = extracted.document
    ? extracted.document === source
      ? [source]
      : [extracted.document, source]
    : [source];
  for (const candidate of candidates) {
    try {
      parsed = parseYaml(candidate);
      parseFailed = false;
      break;
    } catch {
      // 外部锚点会让精简片段解析失败，此时再回退到完整文档。
    }
  }
  if (parseFailed) throw new UpstreamError(502, "Upstream YAML is invalid");

  if (!isRecord(parsed)) {
    if (declaredYaml || extracted.found || looksLikeJsonConfig) {
      throw new UpstreamError(502, "Upstream YAML root must be a mapping");
    }
    return undefined;
  }
  if (!Object.hasOwn(parsed, "proxies")) {
    if (declaredYaml || extracted.found || looksLikeJsonConfig) {
      throw new UpstreamError(502, "Upstream YAML does not contain proxies");
    }
    return undefined;
  }
  if (!Array.isArray(parsed.proxies)) {
    throw new UpstreamError(502, "Upstream YAML proxies must be a sequence");
  }
  validateProxyValues(parsed.proxies);

  const seenNames = new Set<string>();
  const proxies: Record<string, unknown>[] = [];
  for (const proxy of parsed.proxies) {
    const normalized = normalizeAllowedProxy(proxy, seenNames);
    if (normalized) proxies.push(normalized);
  }

  try {
    return {
      body: stringifyProviderProxies(proxies),
      kept: proxies.length,
      removed: parsed.proxies.length - proxies.length,
    };
  } catch {
    throw new UpstreamError(502, "Upstream YAML contains unsupported values");
  }
}
