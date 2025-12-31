import express from "express";
import {
  attachVideoStats,
  fetchLatestVideos,
  getUploadsPlaylistId,
  parseBooleanParam,
  parseLimitParam,
  parseThemeParam,
  renderYoutubeCardSvg,
  resolveChannelId,
} from "./youtube.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Origin, X-Requested-With, Content-Type, Accept",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};

const THUMBNAIL_FILENAMES = [
  "maxresdefault.jpg",
  "sddefault.jpg",
  "hqdefault.jpg",
  "mqdefault.jpg",
  "default.jpg",
];

const THUMBNAIL_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Safari/537.36",
  Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
  Referer: "https://www.youtube.com/",
  Origin: "https://www.youtube.com",
};

const DEBUG_LOG = String(process.env.YOUTUBE_DEBUG_LOG || "").toLowerCase() === "true";
const RESEND_API_KEY = (process.env.RESEND_API_KEY || "").trim();
const ALERT_FROM = (process.env.ALERT_FROM || "").trim();
const ALERT_TO = (process.env.ALERT_TO || "").trim();
const ALERT_THROTTLE_MS = 60 * 60 * 1000;
const ERROR_WINDOW_MS = 60 * 60 * 1000;
const ERROR_FLOOD_THRESHOLD = 50;
const RECOVERY_MIN_FAILURE_MS = 10 * 60 * 1000;
let lastAlertAt = 0;
const lastAlertByReason = {};
let errorWindowStart = 0;
let errorCount = 0;
let inErrorState = false;
let failureStartAt = 0;
let hadAlertDuringFailure = false;
let bootCheckPending = true;
let lastContext = { handle: "", channelId: "", theme: "dark" };
const IS_NETLIFY = Boolean(
  process.env.NETLIFY ||
  process.env.NETLIFY_URL ||
  process.env.DEPLOY_PRIME_URL
);
const ENVIRONMENT = String(
  process.env.ENVIRONMENT ||
  process.env.environment ||
  process.env.enviroment || // keep legacy typo
  ""
).trim().toLowerCase();
const IS_LOCAL = ENVIRONMENT === "local" || !IS_NETLIFY;

const app = express();

app.use((_, res, next) => {
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });
  next();
});

app.options("*", (_, res) => {
  res.status(204).end();
});

app.get("/api/youtube-thumbnail", async (req, res) => {
  const urlParam = typeof req.query.url === "string" ? req.query.url.trim() : "";
  const videoIdParam =
    typeof req.query.video_id === "string"
      ? req.query.video_id.trim()
      : typeof req.query.videoId === "string"
        ? req.query.videoId.trim()
        : "";
  const resolvedUrl = videoIdParam ? buildThumbnailUrlFromVideoId(videoIdParam) : urlParam;
  const cacheBustParam =
    typeof req.query.cache_bust === "string"
      ? req.query.cache_bust.trim()
      : typeof req.query.cacheBust === "string"
        ? req.query.cacheBust.trim()
        : "";

  if (!resolvedUrl) {
    return res.status(400).json({ error: "Thumbnail url or videoId is required" });
  }

  let parsed;
  try {
    parsed = new URL(resolvedUrl);
  } catch (error) {
    return res.status(400).json({ error: "Invalid thumbnail url" });
  }

  if (!["i.ytimg.com", "ytimg.com", "img.youtube.com"].includes(parsed.hostname)) {
    return res.status(400).json({ error: "Unsupported thumbnail host" });
  }

  try {
    const debugEnabled =
      DEBUG_LOG || (typeof req.query.debug === "string" && req.query.debug.trim() === "true");
    const urlsToTry = buildThumbnailCandidates({ url: parsed, videoId: videoIdParam });
    let lastStatus = 502;
    const attempts = [];

    for (const url of urlsToTry) {
      const response = await fetch(url, { headers: THUMBNAIL_HEADERS });
      if (!response.ok) {
        lastStatus = response.status;
        if (debugEnabled) {
          attempts.push({ url, status: response.status });
        }
        if (DEBUG_LOG) {
          console.log("[youtube-thumbnail] miss", response.status, url);
        }
        continue;
      }

      if (DEBUG_LOG) {
        console.log("[youtube-thumbnail] hit", url);
      }
      const contentType = response.headers.get("content-type") || "image/jpeg";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", cacheBustParam ? "no-store" : "public, max-age=3600");
      const buffer = Buffer.from(await response.arrayBuffer());
      return res.status(200).send(buffer);
    }

    if (debugEnabled) {
      return res.status(lastStatus).json({
        error: "Thumbnail fetch failed",
        lastStatus,
        attempts,
      });
    }
    res.setHeader("Cache-Control", "no-store");
    return res.status(lastStatus).json({ error: "Thumbnail fetch failed" });
  } catch (error) {
    console.error("youtube-thumbnail error:", error);
    return res.status(500).json({ error: "Thumbnail proxy error" });
  }
});

const handleYoutubeCard = async (req, res) => {
  const apiKey = (process.env.YOUTUBE_API_KEY || "").trim();
  if (!apiKey) {
    return res.status(500).json({ error: "Missing YOUTUBE_API_KEY" });
  }

  let resolvedHandle = "";
  let resolvedChannelId = "";
  let showDate = parseBooleanParam(process.env.SHOW_DATE, true);
  let showViews = parseBooleanParam(process.env.SHOW_VIEWS, true);
  let requestedLimit = Number.parseInt(process.env.LIMIT || "5", 10);
  if (Number.isNaN(requestedLimit) || requestedLimit <= 0) {
    requestedLimit = 5;
  }

  const handle = typeof req.query.handle === "string" ? req.query.handle.trim() : "";
  const username = typeof req.query.username === "string" ? req.query.username.trim() : "";
  const channelIdParam =
    typeof req.query.channel_id === "string"
      ? req.query.channel_id.trim()
      : typeof req.query.channelId === "string"
        ? req.query.channelId.trim()
        : "";
  const theme = parseThemeParam(req.query.theme);
  const cacheBustParam =
    typeof req.query.cache_bust === "string"
      ? req.query.cache_bust.trim()
      : typeof req.query.cacheBust === "string"
        ? req.query.cacheBust.trim()
        : "";
  const requestInfo = getRequestInfo(req);
  const bootCheckForThisRequest = bootCheckPending;
  bootCheckPending = false;

  try {
    requestedLimit = parseLimitParam(req.query.limit || process.env.LIMIT);
    showDate = parseBooleanParam(req.query.show_date, parseBooleanParam(process.env.SHOW_DATE, true));
    showViews = parseBooleanParam(req.query.show_views, parseBooleanParam(process.env.SHOW_VIEWS, true));
    const embedThumbs = parseBooleanParam(req.query.embed_thumbs, true);

    const {
      channelId,
      handle: resolvedHandle,
      channelTitle: resolvedChannelTitle,
      channelThumbnailUrl: resolvedChannelThumbnailUrl,
    } = await resolveChannelId({
      apiKey,
      handleParam: handle || username,
      channelIdParam,
      envHandle: process.env.YOUTUBE_HANDLE,
      envChannelId: process.env.YOUTUBE_CHANNEL_ID,
    });
    resolvedChannelId = channelId;

    const playlistId = getUploadsPlaylistId(channelId);
    let videos = await fetchLatestVideos(apiKey, playlistId, requestedLimit);
    if (showViews) {
      videos = await attachVideoStats(apiKey, videos);
    }
    if (embedThumbs) {
      videos = await attachInlineThumbnails(videos);
    }
    const channelMeta = await resolveChannelMeta(videos, {
      channelTitle: resolvedChannelTitle,
      channelThumbnailUrl: resolvedChannelThumbnailUrl,
    });

    const svg = renderYoutubeCardSvg({
      videos,
      handle: resolvedHandle || process.env.YOUTUBE_HANDLE || "",
      channelId,
      channelTitle: channelMeta.channelTitle,
      channelAvatarDataUrl: channelMeta.channelAvatarDataUrl,
      theme,
      showDate,
      showViews,
      cacheBust: cacheBustParam,
    });

    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "public, max-age=3600");
    lastContext = {
      handle: resolvedHandle || process.env.YOUTUBE_HANDLE || "",
      channelId,
      theme,
    };
    await onRequestSuccess({ requestInfo, context: lastContext });
    return res.status(200).send(svg);
  } catch (error) {
    console.error("youtube-card error:", error);
    const status = typeof error.status === "number" ? error.status : 500;
    const message =
      status === 400 || status === 403 || status === 503
        ? error.message
        : "Internal server error";

    await handleAlertingOnError({
      error,
      status,
      message,
      handle: handle || username || process.env.YOUTUBE_HANDLE || "",
      channelId: resolvedChannelId || channelIdParam || "",
      theme,
      requestInfo,
      bootCheckForThisRequest,
    });

    if (status === 400) {
      const shouldFallback =
        typeof error?.message === "string" &&
        error.message.toLowerCase().includes("api key");

      if (!shouldFallback) {
        return res.status(status).json({ error: message });
      }
    }

    const fallbackVideos = buildFallbackVideos(requestedLimit);
    const svg = renderYoutubeCardSvg({
      videos: fallbackVideos,
      handle: resolvedHandle || handle || username || process.env.YOUTUBE_HANDLE || "",
      channelId: resolvedChannelId || channelIdParam || "",
      channelTitle: "Data unavailable",
      channelAvatarDataUrl: "",
      theme,
      showDate,
      showViews,
      headerLabel: "Latest YouTube Videos",
    });

    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Card-Status", "fallback");
    return res.status(200).send(svg);
  }
};

app.get("/api/youtube-card", handleYoutubeCard);

app.get("/", (_, res) => {
  res.json({
    ok: true,
    message: "YouTube stats card API is running",
    endpoint: "/api/youtube-card?handle=<handle>&limit=<optional number>",
  });
});

export default app;

function buildFallbackVideos(limit) {
  const count = Math.min(Math.max(limit || 5, 1), 5);
  const baseDate = new Date();

  return Array.from({ length: count }, (_, index) => {
    const date = new Date(baseDate);
    date.setDate(baseDate.getDate() - index * 2);
    return {
      videoId: `fallback-${index + 1}`,
      title: "Video data unavailable",
      publishedAt: date.toISOString(),
      views: null,
      url: "#",
      thumbnail: null,
      thumbnailDataUrl: null,
    };
  });
}

function buildThumbnailFallbacks(url) {
  const pathParts = url.pathname.split("/");
  const file = pathParts[pathParts.length - 1].toLowerCase();
  const startIndex = THUMBNAIL_FILENAMES.indexOf(file);
  if (startIndex === -1) return [url.toString()];

  const fallbacks = THUMBNAIL_FILENAMES.slice(startIndex);
  return fallbacks.map((filename) => {
    const copy = new URL(url.toString());
    pathParts[pathParts.length - 1] = filename;
    copy.pathname = pathParts.join("/");
    return copy.toString();
  });
}

function buildThumbnailUrlFromVideoId(videoId) {
  if (!videoId) return "";
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/default.jpg`;
}

function shouldAllowAlerts() {
  if (IS_LOCAL && !DEBUG_LOG) {
    return false;
  }
  if (!IS_NETLIFY && !IS_LOCAL && !DEBUG_LOG) {
    return false;
  }
  if (!RESEND_API_KEY || !ALERT_FROM || !ALERT_TO) {
    if (DEBUG_LOG) {
      console.log("[alert] missing resend config");
    }
    return false;
  }
  return true;
}

async function handleAlertingOnError({
  error,
  status,
  message,
  handle,
  channelId,
  theme,
  requestInfo,
  bootCheckForThisRequest,
}) {
  const now = Date.now();
  onRequestFailure(now);
  const normalized = typeof message === "string" ? message.toLowerCase() : "";

  if (bootCheckForThisRequest && isBootFailure(error, normalized)) {
    await sendAlert({
      reason: "BOOT_FAIL",
      subject: "BOOT FAIL: handle resolution failed",
      status,
      message,
      handle,
      channelId,
      theme,
      requestInfo,
    });
  }  

  if (errorCount >= ERROR_FLOOD_THRESHOLD ) {
    await sendAlert({
      reason: "ERROR_FLOOD",
      subject: `ERROR FLOOD: ${errorCount} errors in the last hour`,
      status,
      message: `Error volume reached ${ERROR_FLOOD_THRESHOLD}/hour threshold.`,
      handle,
      channelId,
      theme,
      requestInfo,
    });
    resetErrorWindow(now);
  }

  if (isApiKeyIssue(normalized)) {
    await sendAlert({
      reason: "API_KEY",
      subject: "YouTube Stats Card: API key error",
      status,
      message,
      handle,
      channelId,
      theme,
      requestInfo,
    });
  }
}

async function sendAlert({
  reason,
  subject,
  status,
  message,
  handle,
  channelId,
  theme,
  requestInfo
}) {
  if (!shouldAllowAlerts()) {
    return;
  }
  
  const payload = {
    from: ALERT_FROM,
    to: ALERT_TO,
    subject,
    html: `
      <h2>YouTube Stats Card alert</h2>
      <p>${escapeHtml(subject)}</p>
      <ul>
        <li>Status: ${status || "unknown"}</li>
        <li>Message: ${escapeHtml(message || "unknown")}</li>
        <li>Handle: ${escapeHtml(handle || "n/a")}</li>
        <li>Channel ID: ${escapeHtml(channelId || "n/a")}</li>
        <li>Theme: ${escapeHtml(theme || "n/a")}</li>
        <li>Client IP: ${escapeHtml(requestInfo?.ip || "n/a")}</li>
        <li>User Agent: ${escapeHtml(requestInfo?.userAgent || "n/a")}</li>
        <li>Referer: ${escapeHtml(requestInfo?.referer || "n/a")}</li>
        <li>Host: ${escapeHtml(requestInfo?.host || "n/a")}</li>
        <li>Path: ${escapeHtml(requestInfo?.path || "n/a")}</li>
        <li>Query: ${escapeHtml(requestInfo?.query || "n/a")}</li>
      </ul>
      <p>Update the API key in Netlify environment variables if applicable.</p>
    `,
  };

  try {
    if (DEBUG_LOG) {
      console.log("[alert] sending resend email", reason);
    }
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (DEBUG_LOG) {
      console.log("[alert] resend response:", response.status, await response.text());
    }

    if (!response.ok) {
      const body = await response.text();
      console.error("alert email failed:", response.status, body);
      return;
    }
    lastAlertAt = Date.now();
    lastAlertByReason[reason] = lastAlertAt;
    hadAlertDuringFailure = true;
  } catch (error) {
    console.error("alert email error:", error);
  }
}

async function sendRecoveryAlert({ context, requestInfo, failureDurationMs }) {
  await sendAlert({
    reason: "RECOVERY",
    subject: "RECOVERY: YouTube card errors cleared",
    status: 200,
    message: `Recovered after ${(failureDurationMs / 60000).toFixed(1)} minutes.`,
    handle: context?.handle || "",
    channelId: context?.channelId || "",
    theme: context?.theme || "dark",
    requestInfo,
  });
}

function isApiKeyIssue(message) {
  return (
    message.includes("api key expired") ||
    message.includes("api key invalid") ||
    message.includes("api key")
  );
}

function isHandleResolutionError(error, normalizedMessage) {
  const status = typeof error?.status === "number" ? error.status : 0;
  return (
    normalizedMessage.includes("handle") ||
    normalizedMessage.includes("channel not found") ||
    normalizedMessage.includes("search failed") ||
    (status === 400 && normalizedMessage.includes("channel"))
  );
}

function isBootFailure(error, normalizedMessage) {
  const status = typeof error?.status === "number" ? error.status : 0;
  if (isHandleResolutionError(error, normalizedMessage)) return true;
  if (isApiKeyIssue(normalizedMessage)) return true;
  return status >= 400;
}

async function onRequestSuccess({ requestInfo, context }) {
  const now = Date.now();
  if (inErrorState) {
    const failureDurationMs = failureStartAt ? now - failureStartAt : 0;
    if (hadAlertDuringFailure && failureDurationMs >= RECOVERY_MIN_FAILURE_MS) {
      console.log("[alert] recovery after", Math.round(failureDurationMs / 60000), "min");
      await sendRecoveryAlert({ context, requestInfo, failureDurationMs });
    }
    inErrorState = false;
    failureStartAt = 0;
    hadAlertDuringFailure = false;
  }
  bootCheckPending = true;
}

function onRequestFailure (now) {
  if (!inErrorState) {
    inErrorState = true;
    failureStartAt = now;
  }
  updateErrorWindow(now);
}

function updateErrorWindow(now) {
  if (!errorWindowStart || now - errorWindowStart > ERROR_WINDOW_MS) {
    resetErrorWindow(now);
  }
  errorCount += 1;
}

function resetErrorWindow(now) {
  errorWindowStart = now;
  errorCount = 0;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getRequestInfo(req) {
  if (!req) return {};
  const forwardedFor = req.headers?.["x-forwarded-for"];
  const ip = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : typeof forwardedFor === "string"
      ? forwardedFor.split(",")[0].trim()
      : req.ip || req.socket?.remoteAddress || "";

  return {
    ip,
    userAgent: req.headers?.["user-agent"] || "",
    referer: req.headers?.referer || req.headers?.referrer || "",
    host: req.headers?.host || "",
    path: req.originalUrl || req.url || "",
    query: req.originalUrl && req.originalUrl.includes("?") ? req.originalUrl.split("?")[1] : "",
  };
}

async function attachInlineThumbnails(videos) {
  const safeVideos = Array.isArray(videos) ? videos : [];
  const updates = await Promise.all(
    safeVideos.map(async (video) => {
      const thumbnailDataUrl = await fetchThumbnailDataUrl(video);
      return { ...video, thumbnailDataUrl };
    }),
  );
  return updates;
}

async function resolveChannelMeta(videos, resolvedMeta) {
  const safeVideos = Array.isArray(videos) ? videos : [];
  const preferredTitle = resolvedMeta?.channelTitle || "";
  const preferredThumb = resolvedMeta?.channelThumbnailUrl || "";
  const first = safeVideos.find((video) => video?.channelTitle || video?.channelThumbnailUrl);

  if (!first && !preferredTitle && !preferredThumb) {
    return { channelTitle: "", channelAvatarDataUrl: "" };
  }

  const channelTitle = preferredTitle || first?.channelTitle || "";
  const avatarSource = preferredThumb || first?.channelThumbnailUrl || "";
  const channelAvatarDataUrl = avatarSource ? await fetchInlineImage(avatarSource) : "";

  return { channelTitle, channelAvatarDataUrl };
}

async function fetchInlineImage(url) {
  if (!url) return "";
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    return "";
  }

  const candidates = buildThumbnailCandidates({ url: parsed, videoId: "" });
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, { headers: THUMBNAIL_HEADERS });
      if (!response.ok) {
        continue;
      }
      const contentType = response.headers.get("content-type") || "image/jpeg";
      const buffer = Buffer.from(await response.arrayBuffer());
      return `data:${contentType};base64,${buffer.toString("base64")}`;
    } catch (error) {
      continue;
    }
  }

  return "";
}

async function fetchThumbnailDataUrl(video) {
  if (!video) return null;
  const url = video.thumbnail?.url ? new URL(video.thumbnail.url) : null;
  const candidates = buildThumbnailCandidates({ url, videoId: video.videoId });
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, { headers: THUMBNAIL_HEADERS });
      if (!response.ok) {
        if (DEBUG_LOG) {
          console.log("[youtube-thumbnail] inline miss", response.status, candidate);
        }
        continue;
      }
      const contentType = response.headers.get("content-type") || "image/jpeg";
      const buffer = Buffer.from(await response.arrayBuffer());
      const base64 = buffer.toString("base64");
      if (DEBUG_LOG) {
        console.log("[youtube-thumbnail] inline hit", candidate);
      }
      return `data:${contentType};base64,${base64}`;
    } catch (error) {
      if (DEBUG_LOG) {
        console.log("[youtube-thumbnail] inline error", candidate, error?.message || error);
      }
    }
  }
  return null;
}

function buildThumbnailCandidates({ url, videoId }) {
  if (videoId) {
    return buildThumbnailCandidatesFromVideoId(videoId);
  }
  if (!url) return [];
  const candidates = [...buildThumbnailFallbacks(url)];
  const altHost = swapThumbnailHost(url);
  if (altHost) {
    candidates.push(...buildThumbnailFallbacks(altHost));
  }
  return Array.from(new Set(candidates));
}

function buildThumbnailCandidatesFromVideoId(videoId) {
  const safeId = encodeURIComponent(videoId);
  const hosts = ["i.ytimg.com", "img.youtube.com"];
  const filenames = THUMBNAIL_FILENAMES;
  const urls = [];
  hosts.forEach((host) => {
    filenames.forEach((filename) => {
      urls.push(`https://${host}/vi/${safeId}/${filename}`);
    });
  });
  return urls;
}

function swapThumbnailHost(url) {
  const altHost =
    url.hostname === "i.ytimg.com"
      ? "img.youtube.com"
      : url.hostname === "img.youtube.com"
        ? "i.ytimg.com"
        : null;
  if (!altHost) return null;
  const copy = new URL(url.toString());
  copy.hostname = altHost;
  return copy;
}
