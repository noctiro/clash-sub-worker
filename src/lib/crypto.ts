const encoder = new TextEncoder();
const SHA256_BYTES = 32;

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export async function verifyToken(
  provided: string,
  candidateDigestBytes: Uint8Array,
): Promise<{ valid: boolean; key: string; controllerSecret: string }> {
  // 候选摘要由构建器预计算；请求期只哈希来访 token 一次。
  const providedDigest = await sha256(provided);
  let valid = false;
  for (
    let offset = 0;
    offset < candidateDigestBytes.byteLength;
    offset += SHA256_BYTES
  ) {
    const candidate = candidateDigestBytes.subarray(
      offset,
      offset + SHA256_BYTES,
    );
    const equal = crypto.subtle.timingSafeEqual(providedDigest, candidate);
    valid = equal || valid;
  }

  return {
    valid,
    key: toBase64Url(providedDigest.slice(0, 18)),
    controllerSecret: toBase64Url(providedDigest.slice(0, 24)),
  };
}

export function randomNonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}
