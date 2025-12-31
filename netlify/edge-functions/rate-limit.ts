type RateLimitMode = "block" | "degrade" | "pass";

type RateLimitConfig = {
  enabled: boolean;
  windowMs: number;
  maxRequests: number;
  mode: RateLimitMode;
  addHeaders: boolean;
  allowlist: Set<string>;
  logHits: boolean;
};

type CounterState = {
  timestamps: number[];
};

const counters = new Map<string, CounterState>();
const FALLBACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="140" viewBox="0 0 480 140">
  <rect width="100%" height="100%" fill="#f5f5f5"/>
  <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="Arial, sans-serif" font-size="16" fill="#666">
    Rate limited
  </text>
</svg>`;

const DEFAULTS = {
  windowMs: 10_000,
  maxRequests: 25,
  mode: "block" as RateLimitMode,
};

function readBool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
}

function readNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readMode(value: string | undefined): RateLimitMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "block" || normalized === "degrade" || normalized === "pass") {
    return normalized;
  }
  return DEFAULTS.mode;
}

function parseAllowlist(value: string | undefined): Set<string> {
  if (!value) return new Set<string>();
  return new Set(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function getClientIp(request: Request): string {
  const direct = request.headers.get("x-nf-client-connection-ip");
  if (direct) return direct;
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return (
    request.headers.get("x-real-ip") ||
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("fastly-client-ip") ||
    "unknown"
  );
}

function readConfig(): RateLimitConfig {
  let enabled = false;
  let windowMs = DEFAULTS.windowMs;
  let maxRequests = DEFAULTS.maxRequests;
  let mode: RateLimitMode = DEFAULTS.mode;
  let addHeaders = false;
  let allowlist = new Set<string>();
  let logHits = false;

  try {
    enabled = readBool(Deno.env.get("EDGE_RATE_LIMIT_ENABLED"), false);
    windowMs = readNumber(Deno.env.get("EDGE_RATE_LIMIT_WINDOW_MS"), DEFAULTS.windowMs);
    maxRequests = readNumber(
      Deno.env.get("EDGE_RATE_LIMIT_MAX_REQUESTS"),
      DEFAULTS.maxRequests,
    );
    mode = readMode(Deno.env.get("EDGE_RATE_LIMIT_MODE"));
    addHeaders = readBool(Deno.env.get("EDGE_RATE_LIMIT_HEADER"), false);
    allowlist = parseAllowlist(Deno.env.get("EDGE_RATE_LIMIT_ALLOWLIST"));
    logHits = readBool(Deno.env.get("EDGE_RATE_LIMIT_LOG"), false);
  } catch {
    return {
      enabled: false,
      windowMs: DEFAULTS.windowMs,
      maxRequests: DEFAULTS.maxRequests,
      mode: DEFAULTS.mode,
      addHeaders: false,
      allowlist: new Set<string>(),
      logHits: false,
    };
  }

  return { enabled, windowMs, maxRequests, mode, addHeaders, allowlist, logHits };
}

function pruneWindow(state: CounterState, cutoff: number): CounterState {
  const timestamps = state.timestamps.filter((timestamp) => timestamp > cutoff);
  return { timestamps };
}

function buildHeaders(
  config: RateLimitConfig,
  rateLimited: boolean,
  remaining: number,
  resetAt: number,
  limit: number,
  reason: string,
): Headers {
  const headers = new Headers();
  if (config.addHeaders) {
    headers.set("X-RateLimit-Limit", String(limit));
    headers.set("X-RateLimit-Remaining", String(Math.max(0, remaining)));
    headers.set("X-RateLimit-Reset", String(Math.max(0, resetAt)));
    headers.set("X-RateLimit-Edge", rateLimited ? reason : "ok");
  } else if (rateLimited && config.mode === "pass") {
    headers.set("X-RateLimit-Edge", reason);
  }
  return headers;
}

function withHeaders(response: Response, headers: Headers): Response {
  if (headers.size === 0) return response;
  const merged = new Headers(response.headers);
  headers.forEach((value, key) => merged.set(key, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

async function getDegradedResponse(
  request: Request,
  headers: Headers,
): Promise<Response> {
  if (request.method === "GET" || request.method === "HEAD") {
    try {
      const cached = await caches.default.match(request);
      if (cached) return withHeaders(cached, headers);
    } catch {
      // Ignore cache lookup failures and fall back.
    }
  }

  const fallbackHeaders = new Headers(headers);
  fallbackHeaders.set("Content-Type", "image/svg+xml; charset=utf-8");
  return new Response(FALLBACK_SVG, { status: 200, headers: fallbackHeaders });
}

export default async function rateLimit(
  request: Request,
  context: { next: () => Promise<Response> },
): Promise<Response> {
  try {
    const config = readConfig();
    if (!config.enabled) {
      return await context.next();
    }

    const clientIp = getClientIp(request);
    if (config.allowlist.has(clientIp)) {
      return await context.next();
    }

    const now = Date.now();
    const cutoff = now - config.windowMs;
    const existing = counters.get(clientIp) ?? { timestamps: [] };
    const state = pruneWindow(existing, cutoff);
    state.timestamps.push(now);
    counters.set(clientIp, state);

    const count = state.timestamps.length;
    const remaining = Math.max(0, config.maxRequests - count);
    const resetAt = (state.timestamps[0] ?? now) + config.windowMs;
    const rateLimited = count > config.maxRequests;

    if (!rateLimited) {
      const response = await context.next();
      const headers = buildHeaders(config, false, remaining, resetAt, config.maxRequests, "ok");
      return withHeaders(response, headers);
    }

    if (config.logHits) {
      console.log(
        `[edge-rate-limit] ${clientIp} hit limit (${count}/${config.maxRequests})`,
      );
    }

    const headers = buildHeaders(
      config,
      true,
      remaining,
      resetAt,
      config.maxRequests,
      "hit",
    );

    if (config.mode === "block") {
      return new Response("Rate limit exceeded", { status: 429, headers });
    }

    if (config.mode === "degrade") {
      return await getDegradedResponse(request, headers);
    }

    const response = await context.next();
    return withHeaders(response, headers);
  } catch {
    return await context.next();
  }
}
