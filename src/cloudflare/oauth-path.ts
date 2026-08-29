export function isAnyamOAuthPath(pathname: string): boolean {
  return pathname === "/mcp"
    || pathname.startsWith("/mcp/")
    || pathname === "/authorize"
    || pathname === "/oauth/token"
    || pathname === "/oauth/register"
    || pathname.startsWith("/.well-known/oauth-")
    || pathname === "/.well-known/openid-configuration";
}
