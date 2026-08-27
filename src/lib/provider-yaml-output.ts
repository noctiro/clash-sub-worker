const SAFE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/u;
const SAFE_PLAIN_STRING_PATTERN = /^[A-Za-z_][A-Za-z0-9_.+/@:-]*$/u;
const AMBIGUOUS_PLAIN_STRINGS = new Set([
  "false",
  "inf",
  "n",
  "nan",
  "no",
  "null",
  "off",
  "on",
  "true",
  "y",
  "yes",
]);
const MAX_FAST_DEPTH = 20;
const INDENTATION = Array.from({ length: MAX_FAST_DEPTH + 2 }, (_, level) =>
  "  ".repeat(level),
);

function indentation(level: number): string {
  return INDENTATION[level] ?? "  ".repeat(level);
}

function encodeString(value: string): string {
  if (
    SAFE_PLAIN_STRING_PATTERN.test(value) &&
    !value.endsWith(":") &&
    !AMBIGUOUS_PLAIN_STRINGS.has(value.toLowerCase())
  ) {
    return value;
  }
  return JSON.stringify(value);
}

function encodeScalar(value: unknown): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string") return encodeString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value !== "number") return undefined;
  if (Number.isNaN(value)) return ".nan";
  if (value === Number.POSITIVE_INFINITY) return ".inf";
  if (value === Number.NEGATIVE_INFINITY) return "-.inf";
  if (Object.is(value, -0)) return "-0.0";
  return String(value);
}

function encodeKey(value: string): string {
  return SAFE_KEY_PATTERN.test(value) &&
    !AMBIGUOUS_PLAIN_STRINGS.has(value.toLowerCase())
    ? value
    : JSON.stringify(value);
}

function isContainer(
  value: unknown,
): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null;
}

function isSequence(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function emitAfterPrefix(
  lines: string[],
  prefix: string,
  value: unknown,
  childLevel: number,
  depth: number,
  ancestors: Set<object>,
): void {
  const scalar = encodeScalar(value);
  if (scalar !== undefined) {
    lines.push(prefix + " " + scalar);
    return;
  }
  if (!isContainer(value)) throw new TypeError("Unsupported YAML value");

  const empty = Array.isArray(value)
    ? value.length === 0
    : Object.keys(value).length === 0;
  if (empty) {
    lines.push(prefix + (Array.isArray(value) ? " []" : " {}"));
    return;
  }

  lines.push(prefix);
  emitCollection(lines, value, childLevel, depth + 1, ancestors);
}

function emitMapping(
  lines: string[],
  value: Record<string, unknown>,
  level: number,
  depth: number,
  ancestors: Set<object>,
): void {
  for (const [key, item] of Object.entries(value)) {
    emitAfterPrefix(
      lines,
      indentation(level) + encodeKey(key) + ":",
      item,
      level + 1,
      depth,
      ancestors,
    );
  }
}

function emitMappingSequenceItem(
  lines: string[],
  value: Record<string, unknown>,
  level: number,
  depth: number,
  ancestors: Set<object>,
): void {
  const entries = Object.entries(value);
  if (entries.length === 0) {
    lines.push(indentation(level) + "- {}");
    return;
  }
  if (ancestors.has(value)) throw new TypeError("Cyclic YAML value");
  if (depth > MAX_FAST_DEPTH) throw new TypeError("YAML value is too deep");

  ancestors.add(value);
  try {
    const [first, ...rest] = entries;
    if (first === undefined) throw new TypeError("Empty YAML mapping");
    emitAfterPrefix(
      lines,
      indentation(level) + "- " + encodeKey(first[0]) + ":",
      first[1],
      level + 2,
      depth,
      ancestors,
    );
    for (const [key, item] of rest) {
      emitAfterPrefix(
        lines,
        indentation(level + 1) + encodeKey(key) + ":",
        item,
        level + 2,
        depth,
        ancestors,
      );
    }
  } finally {
    ancestors.delete(value);
  }
}

function emitSequence(
  lines: string[],
  value: readonly unknown[],
  level: number,
  depth: number,
  ancestors: Set<object>,
): void {
  for (const item of value) {
    const scalar = encodeScalar(item);
    if (scalar !== undefined) {
      lines.push(indentation(level) + "- " + scalar);
      continue;
    }
    if (!isContainer(item)) throw new TypeError("Unsupported YAML value");
    if (!Array.isArray(item)) {
      emitMappingSequenceItem(lines, item, level, depth + 1, ancestors);
      continue;
    }
    if (item.length === 0) {
      lines.push(indentation(level) + "- []");
      continue;
    }
    lines.push(indentation(level) + "-");
    emitCollection(lines, item, level + 1, depth + 1, ancestors);
  }
}

function emitCollection(
  lines: string[],
  value: Record<string, unknown> | readonly unknown[],
  level: number,
  depth: number,
  ancestors: Set<object>,
): void {
  if (ancestors.has(value)) throw new TypeError("Cyclic YAML value");
  if (depth > MAX_FAST_DEPTH) throw new TypeError("YAML value is too deep");

  ancestors.add(value);
  try {
    if (isSequence(value)) {
      emitSequence(lines, value, level, depth, ancestors);
    } else {
      emitMapping(lines, value, level, depth, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

export function stringifyProviderProxies(
  proxies: readonly Record<string, unknown>[],
): string {
  if (proxies.length === 0) return "proxies: []\n";
  const lines = ["proxies:"];
  emitCollection(lines, proxies, 1, 0, new Set());
  return lines.join("\n") + "\n";
}
