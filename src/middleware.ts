import { NextResponse, type NextRequest } from "next/server";

// This app has no login, so it answers only requests addressed to this machine. That turns away
// other devices on the network, and web pages trying to reach it through DNS rebinding or a
// cross-site POST. To open it to another device you trust, list its hostname in ALLOWED_HOSTS.
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function deny(reason: string) {
  return new NextResponse(reason, { status: 403 });
}

export function middleware(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  const hostname = host.replace(/:\d+$/, "");
  const extraHosts = (process.env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (![...LOCAL_HOSTS, ...extraHosts].includes(hostname)) {
    return deny(
      `Portchecker does not accept requests for "${hostname}". Add it to ALLOWED_HOSTS in .env if you trust this network.`,
    );
  }

  const origin = req.headers.get("origin");
  if (origin && req.method !== "GET" && req.method !== "HEAD") {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      // An opaque origin such as "null" can never match.
    }
    if (originHost !== host)
      return deny("Cross-site requests are not allowed.");
  }
  // A GET sends no Origin, so a page elsewhere could still make the API run with an image tag. The
  // browser says where a request came from; a tool that sends no such header is not a browser.
  const site = req.headers.get("sec-fetch-site");
  if (
    req.nextUrl.pathname.startsWith("/api/") &&
    site &&
    site !== "same-origin" &&
    site !== "none"
  )
    return deny("Cross-site requests are not allowed.");
  const res = NextResponse.next();
  // A click inside a frame carries this app's own origin and passes the check above, so no site may
  // frame it. Images stay local, so a link in model text cannot call out when it renders.
  res.headers.set(
    "Content-Security-Policy",
    "frame-ancestors 'none'; img-src 'self' data:",
  );
  return res;
}

export const config = {
  matcher: "/((?!_next/static|_next/image).*)",
};
