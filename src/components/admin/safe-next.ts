function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) return true;
  }
  return false;
}

/**
 * The middleware sends signed-out visitors to /admin/login?next=<path>. The value is attacker-controllable, so only an
 * internal /admin path is ever followed; anything else (other sites, protocol-relative, backslashes, control chars,
 * the login page itself) falls back to /admin.
 */
export function safeNextPath(raw: string | null | undefined): string {
  const fallback = "/admin";
  if (!raw || raw.length > 200) return fallback;
  if (raw.startsWith("//") || raw.includes("\\") || raw.includes("://") || hasControlChar(raw)) return fallback;
  const isAdmin = raw === "/admin" || raw.startsWith("/admin/") || raw.startsWith("/admin?");
  if (!isAdmin) return fallback; // also rejects /administrator
  if (raw === "/admin/login" || raw.startsWith("/admin/login/") || raw.startsWith("/admin/login?")) return fallback;
  return raw;
}
