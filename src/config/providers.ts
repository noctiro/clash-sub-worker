import { PRIVATE_PROVIDERS } from "../generated/private-config";

type ProviderBase = Readonly<{
  url: string;
  prefix: string;
}>;

type DirectProviderDefinition = ProviderBase &
  Readonly<{ delivery: "direct" }>;

export type ProxiedProviderDefinition = ProviderBase &
  Readonly<{
    delivery: "proxy";
    userAgent?: string;
    cacheKey: string;
  }>;

type ProviderDefinition =
  | DirectProviderDefinition
  | ProxiedProviderDefinition;

// 名称、URL、前缀与交付方式已经在构建期完成严格校验和规范化。
export const PROVIDERS: Readonly<Record<string, ProviderDefinition>> =
  PRIVATE_PROVIDERS;

type ProviderName = keyof typeof PRIVATE_PROVIDERS;

export function getProvider(name: string): ProviderDefinition | undefined {
  return Object.hasOwn(PRIVATE_PROVIDERS, name)
    ? PRIVATE_PROVIDERS[name as ProviderName]
    : undefined;
}
