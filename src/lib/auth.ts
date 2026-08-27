import {
  PRIVATE_SETTINGS,
  TOKEN_DIGEST_BYTES,
} from "../generated/private-config";
import { verifyToken } from "./crypto";
import { redirectResponse } from "./http";

type AuthResult =
  | Readonly<{
      authenticated: true;
      token: string;
      key: string;
      controllerSecret: string;
    }>
  | Readonly<{ authenticated: false; response: Response }>;

function tokenLooksWellFormed(values: string[]): values is [string] {
  if (values.length !== 1) return false;
  const token = values[0];
  return (
    token !== undefined &&
    token.length > 0 &&
    token.length <= 256 &&
    token === token.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(token)
  );
}

function shadowban(): AuthResult {
  return {
    authenticated: false,
    response: redirectResponse(PRIVATE_SETTINGS.runtime.decoyUrl),
  };
}

export async function authenticate(url: URL): Promise<AuthResult> {
  const tokenValues = url.searchParams.getAll("token");
  if (!tokenLooksWellFormed(tokenValues)) {
    return shadowban();
  }

  const token = tokenValues[0];
  const verification = await verifyToken(token, TOKEN_DIGEST_BYTES);
  if (!verification.valid) {
    return shadowban();
  }

  return {
    authenticated: true,
    token,
    key: verification.key,
    controllerSecret: verification.controllerSecret,
  };
}
