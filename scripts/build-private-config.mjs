import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { writeTextAtomically } from "./write-atomically.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(
  process.env.NOCTIRO_PRIVATE_CONFIG_SOURCE ??
    resolve(projectRoot, "private.config.yaml"),
);
const outputPath = resolve(
  process.env.NOCTIRO_PRIVATE_CONFIG_OUTPUT ??
    resolve(projectRoot, "src/generated/private-config.ts"),
);
const tokenDigestPrefix = "sha256:";
const digestPattern = /^[A-Za-z0-9_-]{43}$/u;
const providerNamePattern = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
const controlCharacterPattern = /[\u0000-\u001f\u007f]/u;
const asciiHeaderPattern = /^[\x20-\x7e]+$/u;
const defaultUserAgent = "Mihomo/1.0";
const maximumUnsigned64 = (1n << 64n) - 1n;
const placeholderTokenPattern =
  /(?:^|[-_ ])(?:bootstrap|change[-_ ]?me|dummy|example|placeholder|replace[-_ ]?with|sample|test[-_ ]?token|your[-_ ]?token)(?:[-_ ]|$)/iu;
const placeholderTokenDigests = new Set(
  [
    "replace-with-a-long-random-token",
    "change-me-change-me",
    "bootstrap-token-change-me",
    "your-long-random-token",
    "another-long-random-token",
  ].map((token) => createHash("sha256").update(token, "utf8").digest("hex")),
);
const reservedHostSuffixes = [
  ".example",
  ".home.arpa",
  ".internal",
  ".invalid",
  ".lan",
  ".local",
  ".localhost",
  ".onion",
  ".test",
];
const reservedDomainNames = ["example.com", "example.net", "example.org"];
const nonPublicAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
]) {
  nonPublicAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]) {
  nonPublicAddresses.addSubnet(network, prefix, "ipv6");
}

function fail(message) {
  throw new Error(sourcePath + ": " + message);
}

function asRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(label + " must be a mapping");
  }
  return value;
}

function requireKeys(record, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail(label + " contains unknown field: " + unknown[0]);
  }
  const missing = required.filter((key) => !Object.hasOwn(record, key));
  if (missing.length > 0) {
    fail(label + " is missing field: " + missing[0]);
  }
}

function isReservedHostname(hostname) {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
  if (
    reservedDomainNames.some(
      (domain) => normalized === domain || normalized.endsWith("." + domain),
    ) ||
    reservedHostSuffixes.some(
      (suffix) =>
        normalized === suffix.slice(1) || normalized.endsWith(suffix),
    )
  ) {
    return true;
  }

  const family = isIP(normalized);
  if (family === 4) return nonPublicAddresses.check(normalized, "ipv4");
  if (family === 6) return nonPublicAddresses.check(normalized, "ipv6");
  return !normalized.includes(".");
}

async function requirePrivateSourceMode(path) {
  if (process.platform === "win32") return;
  const metadata = await stat(path);
  if ((metadata.mode & 0o077) !== 0) {
    fail(
      "must not be readable or writable by group/others; run chmod 600 " + path,
    );
  }
}

function requireString(value, label, minimum, maximum) {
  if (typeof value !== "string") fail(label + " must be a string");
  if (value !== value.trim()) fail(label + " must not have outer whitespace");
  if (value.length < minimum || value.length > maximum) {
    fail(
      label +
        " must contain " +
        String(minimum) +
        " to " +
        String(maximum) +
        " characters",
    );
  }
  if (controlCharacterPattern.test(value)) {
    fail(label + " must not contain control characters");
  }
  return value;
}

function requireInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(
      label +
        " must be an integer between " +
        String(minimum) +
        " and " +
        String(maximum),
    );
  }
  return value;
}

function normalizeHttpsUrl(value, label, { allowFragment = true } = {}) {
  const rawUrl = requireString(value, label, 1, 4096);
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    fail(label + " is invalid");
  }
  if (url.protocol !== "https:" || !url.hostname) {
    fail(label + " must be an absolute HTTPS URL");
  }
  if (url.username || url.password) {
    fail(label + " must not contain URL credentials");
  }
  if (!allowFragment && url.hash) {
    fail(label + " must not contain a fragment");
  }
  if (isReservedHostname(url.hostname)) {
    fail(label + " must use a public, non-placeholder host");
  }
  return url.href;
}

function compileProfileTitle(name) {
  if (name.startsWith("base64:")) {
    fail("subscription.name must be readable text, not a base64: value");
  }
  return asciiHeaderPattern.test(name)
    ? undefined
    : "base64:" + Buffer.from(name, "utf8").toString("base64");
}

function compileSubscriptionUserinfo(value) {
  const label = "subscription.userinfo";
  const raw = requireString(value, label, 1, 512);
  const allowed = new Set(["upload", "download", "total", "expire"]);
  const values = new Map();

  for (const rawField of raw.split(";")) {
    const field = rawField.trim();
    if (!field) continue;
    const match = /^([a-z][a-z0-9_-]{0,31})\s*=\s*(\d+)$/u.exec(field);
    if (!match) fail(label + " contains an invalid key/value pair");
    const [, key, decimal] = match;
    if (!key || !decimal || !allowed.has(key)) {
      fail(label + " contains an unsupported field");
    }
    if (values.has(key)) fail(label + " contains duplicate field: " + key);
    const numeric = BigInt(decimal);
    if (numeric > maximumUnsigned64) {
      fail(label + "." + key + " exceeds an unsigned 64-bit integer");
    }
    values.set(key, numeric.toString());
  }

  for (const required of ["upload", "download"]) {
    if (!values.has(required)) fail(label + " is missing field: " + required);
  }
  return ["upload", "download", "total", "expire"]
    .filter((key) => values.has(key))
    .map((key) => key + "=" + values.get(key))
    .join("; ");
}

function compileSettings(runtimeValue, subscriptionValue) {
  const runtime = asRecord(runtimeValue, "runtime");
  requireKeys(
    runtime,
    [
      "decoy-url",
      "upstream-timeout-ms",
      "provider-cache-ttl-seconds",
    ],
    [],
    "runtime",
  );

  const subscription = asRecord(subscriptionValue, "subscription");
  requireKeys(
    subscription,
    ["name"],
    ["update-interval-hours", "userinfo", "support-url"],
    "subscription",
  );
  const name = requireString(subscription.name, "subscription.name", 1, 128);
  const profileTitle = compileProfileTitle(name);

  return {
    runtime: {
      decoyUrl: normalizeHttpsUrl(runtime["decoy-url"], "runtime.decoy-url"),
      upstreamTimeoutMs: requireInteger(
        runtime["upstream-timeout-ms"],
        "runtime.upstream-timeout-ms",
        1000,
        30000,
      ),
      providerCacheTtlSeconds: requireInteger(
        runtime["provider-cache-ttl-seconds"],
        "runtime.provider-cache-ttl-seconds",
        0,
        21600,
      ),
    },
    subscription: {
      name,
      ...(profileTitle === undefined ? {} : { profileTitle }),
      updateIntervalHours: Object.hasOwn(
        subscription,
        "update-interval-hours",
      )
        ? requireInteger(
            subscription["update-interval-hours"],
            "subscription.update-interval-hours",
            1,
            168,
          )
        : null,
      userinfo: Object.hasOwn(subscription, "userinfo")
        ? compileSubscriptionUserinfo(subscription.userinfo)
        : null,
      supportUrl: Object.hasOwn(subscription, "support-url")
        ? normalizeHttpsUrl(
            subscription["support-url"],
            "subscription.support-url",
          )
        : null,
    },
  };
}

function decodeStoredDigest(token, index) {
  if (!token.startsWith(tokenDigestPrefix)) return undefined;
  const encoded = token.slice(tokenDigestPrefix.length);
  if (!digestPattern.test(encoded)) {
    fail("tokens[" + String(index) + "] contains an invalid SHA-256 digest");
  }
  const digest = Buffer.from(encoded, "base64url");
  if (digest.byteLength !== 32 || digest.toString("base64url") !== encoded) {
    fail("tokens[" + String(index) + "] contains a non-canonical digest");
  }
  return digest;
}

function compileTokens(value) {
  if (!Array.isArray(value)) fail("tokens must be a sequence");
  if (value.length === 0 || value.length > 100) {
    fail("tokens must contain 1 to 100 entries");
  }

  const seen = new Set();
  return value.map((entry, index) => {
    const token = requireString(
      entry,
      "tokens[" + String(index) + "]",
      24,
      256,
    );
    const storedDigest = decodeStoredDigest(token, index);
    if (storedDigest === undefined && placeholderTokenPattern.test(token)) {
      fail("tokens[" + String(index) + "] looks like a placeholder credential");
    }
    if (storedDigest === undefined && new Set(token).size < 8) {
      fail("tokens[" + String(index) + "] does not contain enough variation");
    }
    const digest =
      storedDigest ?? createHash("sha256").update(token, "utf8").digest();
    const key = digest.toString("hex");
    if (placeholderTokenDigests.has(key)) {
      fail("tokens[" + String(index) + "] is a known placeholder credential");
    }
    if (seen.has(key)) fail("tokens contains duplicate credentials");
    seen.add(key);
    return digest;
  });
}

function compileProvider(name, value) {
  if (!providerNamePattern.test(name)) {
    fail("invalid provider name: " + name);
  }
  const provider = asRecord(value, "providers." + name);
  requireKeys(
    provider,
    ["url", "prefix", "direct"],
    ["user-agent"],
    "providers." + name,
  );

  const normalizedUrl = normalizeHttpsUrl(
    provider.url,
    "providers." + name + ".url",
    { allowFragment: false },
  );

  const prefix = requireString(
    provider.prefix,
    "providers." + name + ".prefix",
    0,
    64,
  );
  if (typeof provider.direct !== "boolean") {
    fail("providers." + name + ".direct must be true or false");
  }
  if (provider.direct) {
    if (Object.hasOwn(provider, "user-agent")) {
      fail(
        "providers." +
          name +
          ".user-agent is only valid when direct is false",
      );
    }
    return {
      url: normalizedUrl,
      prefix,
      delivery: "direct",
    };
  }

  const userAgent = Object.hasOwn(provider, "user-agent")
    ? requireString(
        provider["user-agent"],
        "providers." + name + ".user-agent",
        1,
        256,
      )
    : defaultUserAgent;

  return {
    url: normalizedUrl,
    prefix,
    delivery: "proxy",
    ...(userAgent === defaultUserAgent ? {} : { userAgent }),
    cacheKey: createHash("sha256")
      .update(normalizedUrl)
      .update("\0")
      .update(userAgent)
      .digest("base64url")
      .slice(0, 24),
  };
}

function compileProviders(value) {
  const input = asRecord(value, "providers");
  const names = Object.keys(input).sort();
  if (names.length === 0 || names.length > 64) {
    fail("providers must contain 1 to 64 entries");
  }

  const output = {};
  for (const name of names) output[name] = compileProvider(name, input[name]);
  return output;
}

let source;
try {
  source = await readFile(sourcePath, "utf8");
  await requirePrivateSourceMode(sourcePath);
} catch (error) {
  if (error && typeof error === "object" && error.code === "ENOENT") {
    throw new Error(
      "Missing private.config.yaml; copy private.config.example.yaml first",
    );
  }
  throw error;
}

const document = parseDocument(source, {
  prettyErrors: true,
  uniqueKeys: true,
});
if (document.errors.length > 0) {
  throw new Error(document.errors.map((error) => error.message).join("\n"));
}
if (document.warnings.length > 0) {
  throw new Error(
    document.warnings.map((warning) => warning.message).join("\n"),
  );
}

const config = asRecord(document.toJS({ maxAliasCount: 0 }), "root");
requireKeys(
  config,
  ["runtime", "subscription", "tokens", "providers"],
  [],
  "root",
);
const settings = compileSettings(config.runtime, config.subscription);
const tokenDigests = compileTokens(config.tokens);
const providers = compileProviders(config.providers);
const signature = JSON.stringify({
  settings,
  tokenDigests: tokenDigests.map((digest) => digest.toString("base64url")),
  providers,
});
const revision = createHash("sha256")
  .update(signature)
  .digest("hex")
  .slice(0, 8);

const generated = [
  "// Generated by scripts/build-private-config.mjs. Do not edit or commit.",
  "// Raw tokens are replaced by SHA-256 digests before bundling.",
  "",
  "export const TOKEN_DIGEST_BYTES = new Uint8Array([" +
    [...Buffer.concat(tokenDigests)].join(",") +
    "]);",
  "",
  "export const PRIVATE_SETTINGS = " +
    JSON.stringify(settings, null, 2) +
    " as const;",
  "",
  "export const PRIVATE_PROVIDERS = " +
    JSON.stringify(providers, null, 2) +
    " as const;",
  "",
  "export const PRIVATE_CONFIG_REVISION = " + JSON.stringify(revision) + ";",
  "",
].join("\n");

await writeTextAtomically(outputPath, generated, { mode: 0o600 });
console.log(
  "Compiled private config: " +
    String(tokenDigests.length) +
    " token digests, " +
    String(Object.keys(providers).length) +
    " providers, revision " +
    revision,
);
