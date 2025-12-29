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
  if (!urlParam) {
    return res.status(400).json({ error: "Thumbnail url is required" });
  }

  let parsed;
  try {
    parsed = new URL(urlParam);
  } catch (error) {
    return res.status(400).json({ error: "Invalid thumbnail url" });
  }

  if (!["i.ytimg.com", "ytimg.com", "img.youtube.com"].includes(parsed.hostname)) {
    return res.status(400).json({ error: "Unsupported thumbnail host" });
  }

  try {
    const response = await fetch(parsed.toString());
    if (!response.ok) {
      return res.status(response.status).json({ error: "Thumbnail fetch failed" });
    }

    const contentType = response.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    const buffer = Buffer.from(await response.arrayBuffer());
    return res.status(200).send(buffer);
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

  try {
    const limit = parseLimitParam(req.query.limit || process.env.LIMIT);
    const showDate = parseBooleanParam(req.query.show_date, parseBooleanParam(process.env.SHOW_DATE, true));
    const showViews = parseBooleanParam(req.query.show_views, parseBooleanParam(process.env.SHOW_VIEWS, true));

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

    const forwardedHost = req.get("x-forwarded-host");
    const forwardedProto = req.get("x-forwarded-proto");
    const host = forwardedHost || req.get("host");
    const proto = forwardedProto || req.protocol;
    const baseUrl = host ? `${proto}://${host}` : "";

    const svg = renderYoutubeCardSvg({
      videos,
      handle: resolvedHandle || process.env.YOUTUBE_HANDLE || "",
      channelId,
      theme,
      showDate,
      showViews,
      baseUrl,
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
