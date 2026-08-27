// 这些上限在解析前后同时使用，避免上游 YAML 消耗完整 isolate 内存。
export const PROVIDER_LIMITS = {
  bodyBytes: 512 * 1024,
  proxies: 4096,
  depth: 16,
  nodes: 50_000,
  mappingEntries: 128,
  nestedSequenceItems: 512,
  keyCodeUnits: 256,
  scalarCodeUnits: 16_384,
  totalStringCodeUnits: 512 * 1024,
} as const;

export const DEFAULT_PROVIDER_USER_AGENT = "Mihomo/1.0";
