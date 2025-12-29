import express from "express";
import {
  attachVideoStats,
  buildLatestJson,
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

  try {
    const limit = parseLimitParam(req.query.limit || process.env.LIMIT);
    const showDate = parseBooleanParam(req.query.show_date, parseBooleanParam(process.env.SHOW_DATE, true));
    const showViews = parseBooleanParam(req.query.show_views, parseBooleanParam(process.env.SHOW_VIEWS, true));
    const embedThumbs = parseBooleanParam(req.query.embed_thumbs, true);

    const { channelId, handle: resolvedHandle } = await resolveChannelId({
      apiKey,
      handleParam: handle || username,
      channelIdParam,
      envHandle: process.env.YOUTUBE_HANDLE,
      envChannelId: process.env.YOUTUBE_CHANNEL_ID,
    });

    const playlistId = getUploadsPlaylistId(channelId);
    let videos = await fetchLatestVideos(apiKey, playlistId, limit);
    if (showViews) {
      videos = await attachVideoStats(apiKey, videos);
    }
    if (embedThumbs) {
      videos = await attachInlineThumbnails(videos);
    }

    const svg = renderYoutubeCardSvg({
      videos,
      handle: resolvedHandle || process.env.YOUTUBE_HANDLE || "",
      channelId,
      theme,
      showDate,
      showViews,
      cacheBust: cacheBustParam,
    });

    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.status(200).send(svg);
  } catch (error) {
    console.error("youtube-card error:", error);
    const status = typeof error.status === "number" ? error.status : 500;
    const message = status === 400 ? error.message : "Internal server error";
    return res.status(status).json({ error: message });
  }
};

app.get("/api/youtube-card", handleYoutubeCard);

app.get("/api/youtube-json", async (req, res) => {
  const apiKey = (process.env.YOUTUBE_API_KEY || "").trim();
  if (!apiKey) {
    return res.status(500).json({ error: "Missing YOUTUBE_API_KEY" });
  }

  const handle = typeof req.query.handle === "string" ? req.query.handle.trim() : "";
  const username = typeof req.query.username === "string" ? req.query.username.trim() : "";
  const channelIdParam =
    typeof req.query.channel_id === "string"
      ? req.query.channel_id.trim()
      : typeof req.query.channelId === "string"
        ? req.query.channelId.trim()
        : "";

  try {
    const limit = parseLimitParam(req.query.limit || process.env.LIMIT);

    const { channelId, handle: resolvedHandle } = await resolveChannelId({
      apiKey,
      handleParam: handle || username,
      channelIdParam,
      envHandle: process.env.YOUTUBE_HANDLE,
      envChannelId: process.env.YOUTUBE_CHANNEL_ID,
    });

    const playlistId = getUploadsPlaylistId(channelId);
    const videos = await fetchLatestVideos(apiKey, playlistId, limit);
    const json = buildLatestJson({
      channelId,
      handle: resolvedHandle || process.env.YOUTUBE_HANDLE || "",
      videos,
    });

    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.status(200).json(json);
  } catch (error) {
    console.error("youtube-json error:", error);
    const status = typeof error.status === "number" ? error.status : 500;
    const message = status === 400 ? error.message : "Internal server error";
    return res.status(status).json({ error: message });
  }
});

app.get("/", (_, res) => {
  res.json({
    ok: true,
    message: "YouTube stats card API is running",
    endpoint: "/api/youtube-card?handle=<handle>&limit=<optional number>",
  });
});

export default app;

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
