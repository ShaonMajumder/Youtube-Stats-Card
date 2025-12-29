const API_BASE_URL = "https://www.googleapis.com/youtube/v3";
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const DEBUG_LOG = String(process.env.YOUTUBE_DEBUG_LOG || "").toLowerCase() === "true";

export function parseLimitParam(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw createError(400, "Limit must be a positive integer");
  }
  return Math.min(parsed, MAX_LIMIT);
}

export function parseBooleanParam(value, defaultValue) {
  if (typeof value !== "string") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return defaultValue;
}

export function parseThemeParam(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return raw === "light" ? "light" : "dark";
}

export function normalizeHandle(value) {
  const handle = typeof value === "string" ? value.trim() : "";
  if (!handle) return "";
  return handle.startsWith("@") ? handle : `@${handle}`;
}

export async function resolveChannelId({ apiKey, handleParam, channelIdParam, envHandle, envChannelId }) {
  const channelId = typeof channelIdParam === "string" ? channelIdParam.trim() : "";
  if (channelId) {
    return { channelId, handle: normalizeHandle(handleParam || envHandle || "") };
  }

  const handle = normalizeHandle(handleParam || envHandle || "");
  if (!handle) {
    throw createError(400, "Handle or channelId is required");
  }

  const channelData = await getChannelIdFromHandle(apiKey, handle);
  return {
    channelId: channelData.channelId,
    handle,
    channelTitle: channelData.channelTitle,
    channelThumbnailUrl: channelData.channelThumbnailUrl,
  };
}

export function getUploadsPlaylistId(channelId) {
  if (!channelId || !channelId.startsWith("UC")) {
    throw createError(400, "Invalid channelId");
  }
  return `UU${channelId.slice(2)}`;
}

export async function getChannelIdFromHandle(apiKey, handle) {
  const url = new URL(`${API_BASE_URL}/search`);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "channel");
  url.searchParams.set("q", handle);
  url.searchParams.set("maxResults", "1");
  url.searchParams.set("key", apiKey);

  const data = await fetchJson(url, "Search failed");
  const item = data?.items?.[0];
  const channelId = item?.id?.channelId;

  if (!channelId) {
    throw createError(404, "Channel not found");
  }

  const channelTitle = cleanText(item?.snippet?.channelTitle) || "";
  const channelThumbnailUrl =
    typeof item?.snippet?.thumbnails?.default?.url === "string"
      ? item.snippet.thumbnails.default.url
      : "";

  return { channelId, channelTitle, channelThumbnailUrl };
}

export async function fetchLatestVideos(apiKey, playlistId, limit) {
  const url = new URL(`${API_BASE_URL}/playlistItems`);
  url.searchParams.set("part", "snippet,contentDetails");
  url.searchParams.set("playlistId", playlistId);
  url.searchParams.set("maxResults", String(limit));
  url.searchParams.set("key", apiKey);

  const data = await fetchJson(url, "Playlist fetch failed");
  const items = Array.isArray(data.items) ? data.items : [];
  if (DEBUG_LOG) {
    console.log("[youtube] playlistItems count:", items.length);
  }

  return items
    .map((item) => {
      const videoId = item?.contentDetails?.videoId;
      if (!videoId) return null;
      const title = cleanText(item?.snippet?.title) || "Untitled video";
      const publishedAt = item?.snippet?.publishedAt || "";
      const thumbnail = pickThumbnail(item?.snippet?.thumbnails);
      const channelTitle = cleanText(item?.snippet?.channelTitle) || "";
      const channelThumbnailUrl =
        typeof item?.snippet?.thumbnails?.default?.url === "string"
          ? item.snippet.thumbnails.default.url
          : "";
      if (DEBUG_LOG) {
        console.log("[youtube] video", videoId, {
          title,
          thumbnail: thumbnail ? thumbnail.url : null,
          available: item?.snippet?.thumbnails ? Object.keys(item.snippet.thumbnails) : [],
        });
      }
      return {
        videoId,
        title,
        publishedAt,
        thumbnail,
        channelTitle,
        channelThumbnailUrl,
        url: `https://www.youtube.com/watch?v=${videoId}`,
      };
    })
    .filter(Boolean);
}

export async function attachVideoStats(apiKey, videos) {
  const safeVideos = Array.isArray(videos) ? videos : [];
  const ids = safeVideos.map((video) => video.videoId).filter(Boolean);
  if (ids.length === 0) return safeVideos;

  const url = new URL(`${API_BASE_URL}/videos`);
  url.searchParams.set("part", "statistics");
  url.searchParams.set("id", ids.join(","));
  url.searchParams.set("key", apiKey);

  const data = await fetchJson(url, "Video stats fetch failed");
  const statsById = new Map();
  (Array.isArray(data.items) ? data.items : []).forEach((item) => {
    const id = item?.id;
    const count = item?.statistics?.viewCount;
    if (id && count) {
      statsById.set(id, Number.parseInt(count, 10));
    }
  });

  return safeVideos.map((video) => ({
    ...video,
    views: statsById.get(video.videoId) ?? null,
  }));
}

export function buildLatestJson({ channelId, handle, videos }) {
  return {
    channelId,
    handle,
    channelTitle: videos?.[0]?.channelTitle || "",
    channelThumbnailUrl: videos?.[0]?.channelThumbnailUrl || "",
    videos: (Array.isArray(videos) ? videos : []).map((video) => ({
      videoId: video.videoId,
      title: video.title,
      url: video.url,
      publishedAt: video.publishedAt,
      date: formatDate(video.publishedAt),
      views: typeof video.views === "number" ? video.views : null,
      thumbnail: video.thumbnail
        ? {
            url: video.thumbnail.url,
            width: video.thumbnail.width,
            height: video.thumbnail.height,
          }
        : null,
    })),
  };
}

export function renderYoutubeCardSvg({
  videos,
  handle,
  channelId,
  channelTitle,
  channelAvatarDataUrl,
  theme,
  showDate,
  showViews,
  headerLabel,
  cacheBust,
}) {
  const themeTokens = getThemeTokens(theme);
  const safeVideos = Array.isArray(videos) ? videos : [];
  const headerText = headerLabel || "Latest YouTube Videos";
  const subtitle = channelTitle || handle || channelId || "Uploads feed";

  const headerHeight = 136;
  const titleLineHeight = 16;
  const maxTitleChars = 46;
  const thumbWidth = 90;
  const thumbHeight = 50;
  const thumbRadius = 8;
  const textOffsetX = thumbWidth + 14;

  const itemsWithLayout = safeVideos.map((video) => {
    const titleLines = wrapText(video.title || "Untitled video", maxTitleChars);
    const titleHeight = titleLines.length * titleLineHeight;
    const metaHeight = showDate || showViews ? 16 : 0;
    const textHeight = titleHeight + metaHeight + 12;
    const thumbBlockHeight = thumbHeight + 8;
    const contentHeight = Math.max(textHeight, thumbBlockHeight);
    return { ...video, titleLines, titleHeight, contentHeight, textHeight };
  });

  const totalHeight =
    headerHeight + itemsWithLayout.reduce((sum, item) => sum + item.contentHeight + 12, 0) + 24;

  let cursorY = headerHeight;
  const svgItems = itemsWithLayout
    .map((item) => {
      const y = cursorY;
      cursorY += item.contentHeight + 12;

      const safeLink = escapeXml(item.url || "#");
      const titleTspans = item.titleLines
        .map(
          (line, i) =>
            `<tspan x="${textOffsetX}" dy="${i === 0 ? 0 : titleLineHeight}">${escapeXml(line)}</tspan>`,
        )
        .join("");

      const metaY = item.titleHeight + 8;
      const metaLine = renderMetaLine({
        date: showDate ? formatDate(item.publishedAt) : "",
        views: showViews ? item.views : null,
        themeTokens,
        y: metaY,
        x: textOffsetX,
      });

      const cardHeight = item.contentHeight + 4;
      const thumbY = Math.max(0, (item.contentHeight - thumbHeight) / 2) - 12;
      const thumbUrl = item.thumbnailDataUrl
        ? escapeXml(item.thumbnailDataUrl)
        : item.thumbnail?.url
          ? escapeXml(getThumbnailProxyUrl({ url: item.thumbnail.url, cacheBust }))
          : item.videoId
            ? escapeXml(getThumbnailProxyUrl({ videoId: item.videoId, cacheBust }))
            : "";

      return `
        <g transform="translate(70, ${y})">
          <rect x="-12" y="-18" width="510" height="${cardHeight}" rx="12" fill="${themeTokens.cardAccent}" opacity="0.45" />
          ${
            thumbUrl
              ? `
          <image href="${thumbUrl}" xlink:href="${thumbUrl}" x="0" y="${thumbY}" width="${thumbWidth}" height="${thumbHeight}" preserveAspectRatio="xMidYMid slice" />
          `
              : `
          <rect x="0" y="${thumbY}" width="${thumbWidth}" height="${thumbHeight}" rx="${thumbRadius}" fill="${themeTokens.border}" opacity="0.4" />
          `
          }
          <a xlink:href="${safeLink}" target="_blank">
            <text x="0" y="0" font-family="'Space Grotesk', 'Segoe UI', sans-serif" font-size="14.5" font-weight="600" fill="${themeTokens.link}">
              ${titleTspans}
            </text>
          </a>
          ${metaLine}
        </g>
      `;
    })
    .join("");

  const footer = subtitle
    ? `
      <text x="520" y="${totalHeight - 18}" font-family="'Segoe UI', sans-serif" font-size="10" fill="${themeTokens.accent}" text-anchor="end" opacity="0.7">
        ${escapeXml(subtitle)}
      </text>
    `
    : "";

  return `
    <svg width="550" height="${totalHeight}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <defs>
        <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" style="stop-color:${themeTokens.accent};stop-opacity:1" />
          <stop offset="100%" style="stop-color:${themeTokens.accentSoft};stop-opacity:1" />
        </linearGradient>
        <pattern id="grain" x="0" y="0" width="4" height="4" patternUnits="userSpaceOnUse">
          <rect width="4" height="4" fill="${themeTokens.base}" />
          <circle cx="1" cy="1" r="0.4" fill="${themeTokens.grain}" />
          <circle cx="3" cy="2" r="0.35" fill="${themeTokens.grain}" />
        </pattern>
        <clipPath id="channel-avatar-clip">
          <circle cx="14" cy="14" r="14" />
        </clipPath>
      </defs>

      <rect width="550" height="${totalHeight}" rx="16" fill="url(#grain)" />
      <rect x="18" y="16" width="514" height="${totalHeight - 32}" rx="18" fill="${themeTokens.card}" stroke="${themeTokens.border}" stroke-width="1.5"/>
      <rect x="34" y="34" width="8" height="${totalHeight - 68}" rx="6" fill="${themeTokens.rail}" opacity="0.7" />

      <g transform="translate(70, 50)">
        ${
          channelAvatarDataUrl
            ? `
        <image href="${escapeXml(channelAvatarDataUrl)}" xlink:href="${escapeXml(
              channelAvatarDataUrl,
            )}" x="0" y="-2" width="28" height="28" clip-path="url(#channel-avatar-clip)" />
        `
            : ""
        }
        <text x="${channelAvatarDataUrl ? 40 : 0}" y="0" font-family="'Space Grotesk', 'Segoe UI', sans-serif" font-size="24" font-weight="700" fill="${themeTokens.text}">
          ${escapeXml(headerText)}
        </text>
        <text x="${channelAvatarDataUrl ? 40 : 0}" y="22" font-family="'Inter', 'Segoe UI', sans-serif" font-size="12" fill="${themeTokens.muted}">
          ${escapeXml(subtitle)}
        </text>
      </g>

      ${svgItems}

      <g transform="translate(0, ${totalHeight - 12})">
        <text x="70" y="0" font-family="'Inter', 'Segoe UI', sans-serif" font-size="10" fill="${themeTokens.muted}" opacity="0.7">
          YouTube Stats Card
        </text>
        ${footer}
      </g>
    </svg>
  `;
}

function renderMetaLine({ date, views, themeTokens, y, x }) {
  const parts = [];
  if (date) parts.push(escapeXml(date));
  if (typeof views === "number") parts.push(`${formatViews(views)} views`);
  if (parts.length === 0) return "";

  return `
    <text x="${x}" y="${y}" font-family="'Inter', 'Segoe UI', sans-serif" font-size="11" fill="${themeTokens.muted}">
      ${parts.join(" | ")}
    </text>
  `;
}

function formatViews(value) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function getThemeTokens(theme) {
  if (theme === "light") {
    return {
      base: "#f6f6f6",
      grain: "#d9d9de",
      card: "#ffffff",
      cardAccent: "#f2f2f6",
      border: "#e0e0e6",
      rail: "#ff3d3d",
      accent: "#ff3d3d",
      accentSoft: "#ff8b8b",
      text: "#141414",
      muted: "#5f606a",
      link: "#141414",
    };
  }

  return {
    base: "#0b0b10",
    grain: "#1c1c22",
    card: "#0f0f14",
    cardAccent: "#171720",
    border: "#2b2b35",
    rail: "#ff3d3d",
    accent: "#ff3d3d",
    accentSoft: "#ff8b8b",
    text: "#ffffff",
    muted: "#b4b4c2",
    link: "#ffffff",
  };
}

async function fetchJson(url, defaultMessage) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    throw createError(response.status, data?.error?.message || defaultMessage);
  }
  return data;
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function pickThumbnail(thumbnails) {
  if (!thumbnails || typeof thumbnails !== "object") return null;
  const order = ["default", "medium", "high", "standard", "maxres"];
  for (const key of order) {
    const entry = thumbnails[key];
    if (entry?.url) {
      return {
        url: entry.url,
        width: entry.width,
        height: entry.height,
      };
    }
  }
  return null;
}

function formatDate(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    timeZone: "UTC",
  });
}

function wrapText(text, maxChars) {
  const rawWords = String(text).split(/\s+/).filter(Boolean);
  const words = rawWords.flatMap((word) => {
    if (word.length <= maxChars) return [word];
    const chunks = [];
    for (let i = 0; i < word.length; i += maxChars) {
      chunks.push(word.slice(i, i + maxChars));
    }
    return chunks;
  });
  if (words.length === 0) return [""];

  const lines = [];
  let current = "";

  words.forEach((word) => {
    if (!current) {
      current = word;
      return;
    }

    if ((current + " " + word).length <= maxChars) {
      current = `${current} ${word}`;
      return;
    }

    lines.push(current);
    current = word;
  });

  if (current) lines.push(current);

  return lines;
}

function getThumbnailProxyUrl({ url, videoId, cacheBust }) {
  if (!url && !videoId) return "";
  const basePath = url
    ? `/api/youtube-thumbnail?url=${encodeURIComponent(url)}`
    : `/api/youtube-thumbnail?videoId=${encodeURIComponent(videoId)}`;
  return cacheBust ? `${basePath}&cache_bust=${encodeURIComponent(cacheBust)}` : basePath;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function createError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
