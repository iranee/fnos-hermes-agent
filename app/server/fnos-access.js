import { createHmac, timingSafeEqual } from "node:crypto";

export function panelDenied(code, error) {
  return Response.json({ ok: false, code, error }, { status: 403, headers: { "cache-control": "no-store" } });
}

export function panelToken(origin, token) {
  if (!token || !browserOrigin({ headers: new Headers({ origin }) })) return null;
  return "origin." + createHmac("sha256", token).update(origin).digest("base64url");
}

export function authorizedOrigin(req, token) {
  const origin = browserOrigin(req);
  if (!origin) return null;
  const expected = panelToken(origin, token), actual = req.headers.get("x-monitor-token");
  if (!expected || typeof actual !== "string" || !/^origin\.[A-Za-z0-9_-]{43}$/.test(actual)) return null;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected)) ? origin : null;
}

export function isFnosAdmin(req) {
  return req.headers.get("x-trim-isadmin") === "true" && !!req.headers.get("x-trim-userid")?.trim();
}

// 用户浏览器看到的 origin（fnOS 网关转发时可能改写 Host）。
export function browserOrigin(req) {
  const origin = req.headers.get("origin");
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) return null;
    return url.origin;
  } catch { return null; }
}

export function requestOrigin(req) {
  const origin = browserOrigin(req);
  if (!origin) return null;
  const host = new URL(origin).host;
  const candidates = [req.headers.get("host"), req.headers.get("x-forwarded-host")]
    .filter(value => value && !/[\s,/@\\]/.test(value)).map(value => value.toLowerCase());
  return candidates.includes(host) ? origin : null;
}

export function authorizePanel(req, token) {
  if (!isFnosAdmin(req)) return panelDenied("PANEL_ADMIN", "需要 fnOS 管理员身份，请重新登录");
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    if (!token || (req.headers.get("x-monitor-token") !== token && !authorizedOrigin(req, token))) {
      return panelDenied("PANEL_TOKEN", "管理令牌已失效，请刷新状态后重试");
    }
  }
  return null;
}
