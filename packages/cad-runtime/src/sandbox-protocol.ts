export const SANDBOX_AUTH_SCHEME = "Bearer";

export const SANDBOX_API_PATHS = {
  resolve: "/v1/sandboxes/resolve",
  runTool: "/v1/tools/run",
  export: "/v1/export",
} as const;

export type SandboxApiPath = (typeof SANDBOX_API_PATHS)[keyof typeof SANDBOX_API_PATHS];

export function normalizeSandboxSecret(secret: string | undefined): string | undefined {
  const normalized = secret?.trim();
  return normalized || undefined;
}

export function sandboxAuthorizationHeader(secret: string | undefined): string | undefined {
  const normalized = normalizeSandboxSecret(secret);
  return normalized ? `${SANDBOX_AUTH_SCHEME} ${normalized}` : undefined;
}
