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

  const cardWidth = 600;
  const outerPadding = 18;
  const headerHeight = 150;
  const headerBarHeight = 48;
  const avatarSize = 56;
  const avatarRing = 4;
  const titleLineHeight = 18;
  const maxTitleChars = 52;
  const maxTitleLines = 2;
  const thumbWidth = 110;
  const thumbHeight = 62;
  const thumbRadius = 10;
  const rowGap = 14;
  const rowPadding = 14;
  const textOffsetX = thumbWidth + 24;

  const itemsWithLayout = safeVideos.map((video) => {
    const titleLines = wrapText(video.title || "Untitled video", maxTitleChars).slice(
      0,
      maxTitleLines,
    );
    const titleHeight = titleLines.length * titleLineHeight;
    const metaHeight = showDate || showViews ? 16 : 0;
    const contentHeight = Math.max(thumbHeight, titleHeight + metaHeight) + rowPadding;
    return { ...video, titleLines, titleHeight, contentHeight };
  });

  const totalHeight =
    headerHeight + itemsWithLayout.reduce((sum, item) => sum + item.contentHeight + rowGap, 0) + 40;

  let cursorY = headerHeight;
  const svgItems = itemsWithLayout
    .map((item) => {
      const y = cursorY;
      cursorY += item.contentHeight + rowGap;

      const safeLink = escapeXml(item.url || "#");
      const titleTspans = item.titleLines
        .map(
          (line, i) =>
            `<tspan x="${textOffsetX}" dy="${i === 0 ? 0 : titleLineHeight}">${escapeXml(
              line,
            )}</tspan>`,
        )
        .join("");

      const titleStartY = rowPadding + 8;
      const metaY = titleStartY + item.titleHeight + 6;
      const metaLine = renderMetaLine({
        date: showDate ? formatDate(item.publishedAt) : "",
        views: showViews ? item.views : null,
        themeTokens,
        y: metaY,
        x: textOffsetX,
      });

      const thumbY = (item.contentHeight - thumbHeight) / 2;
      const thumbUrl = item.thumbnailDataUrl
        ? escapeXml(item.thumbnailDataUrl)
        : item.thumbnail?.url
          ? escapeXml(getThumbnailProxyUrl({ url: item.thumbnail.url, cacheBust }))
          : item.videoId
            ? escapeXml(getThumbnailProxyUrl({ videoId: item.videoId, cacheBust }))
            : "";

      return `
        <g transform="translate(${outerPadding + 18}, ${y})">
          <rect x="0" y="0" width="${cardWidth - 2 * (outerPadding + 18)}" height="${item.contentHeight}" rx="14" fill="${themeTokens.cardAccent}" stroke="${themeTokens.border}" stroke-width="1" opacity="0.95" />
          <rect x="8" y="${item.contentHeight - 18}" width="6" height="6" rx="3" fill="${themeTokens.accent}" />
          ${
            thumbUrl
              ? `
          <image href="${thumbUrl}" xlink:href="${thumbUrl}" x="16" y="${thumbY}" width="${thumbWidth}" height="${thumbHeight}" preserveAspectRatio="xMidYMid slice" />
          `
              : `
          <rect x="16" y="${thumbY}" width="${thumbWidth}" height="${thumbHeight}" rx="${thumbRadius}" fill="${themeTokens.border}" opacity="0.4" />
          `
          }
          <a xlink:href="${safeLink}" target="_blank">
            <text x="0" y="${titleStartY}" font-family="'Space Grotesk', 'Segoe UI', sans-serif" font-size="15" font-weight="600" fill="${themeTokens.link}">
              ${titleTspans}
            </text>
          </a>
          ${metaLine}
        </g>
      `;
    })
    .join("");

  const avatarCx = outerPadding + 40;
  const avatarCy = headerBarHeight + 42;
  const headerAvatar = channelAvatarDataUrl
    ? `
      <circle cx="${avatarCx}" cy="${avatarCy}" r="${avatarSize / 2 + avatarRing}" fill="${themeTokens.accentSoft}" opacity="0.7" />
      <circle cx="${avatarCx}" cy="${avatarCy}" r="${avatarSize / 2 + 1}" fill="${themeTokens.card}" opacity="0.85" />
      <image href="${escapeXml(channelAvatarDataUrl)}" xlink:href="${escapeXml(
        channelAvatarDataUrl,
      )}" x="${avatarCx - avatarSize / 2}" y="${avatarCy - avatarSize / 2}" width="${avatarSize}" height="${avatarSize}" clip-path="url(#channel-avatar-clip)" />
    `
    : "";

  return `
    <svg width="${cardWidth}" height="${totalHeight}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <defs>
        <linearGradient id="card-bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#0b0b10;stop-opacity:1" />
          <stop offset="100%" style="stop-color:#1c1c24;stop-opacity:1" />
        </linearGradient>
        <radialGradient id="dust" cx="30%" cy="40%" r="70%">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="0.08" />
          <stop offset="100%" stop-color="#ffffff" stop-opacity="0" />
        </radialGradient>
        <filter id="grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncA type="table" tableValues="0 0.07" />
          </feComponentTransfer>
        </filter>
        <clipPath id="channel-avatar-clip">
          <circle cx="${avatarCx}" cy="${avatarCy}" r="${avatarSize / 2}" />
        </clipPath>
      </defs>

      <rect width="${cardWidth}" height="${totalHeight}" rx="26" fill="url(#card-bg)" />
      <rect x="6" y="6" width="${cardWidth - 12}" height="${totalHeight - 12}" rx="22" fill="none" stroke="#2a2a35" stroke-width="2" />
      <rect x="${outerPadding}" y="${outerPadding}" width="${cardWidth - 2 * outerPadding}" height="${totalHeight - 2 * outerPadding}" rx="20" fill="#121218" stroke="#2b2b33" stroke-width="1.5" />
      <rect x="${outerPadding}" y="${outerPadding}" width="${cardWidth - 2 * outerPadding}" height="${totalHeight - 2 * outerPadding}" rx="20" fill="url(#dust)" filter="url(#grain)" />

      <rect x="${outerPadding}" y="${outerPadding}" width="${cardWidth - 2 * outerPadding}" height="${headerBarHeight}" rx="14" fill="#1b1b24" stroke="#2f2f3a" stroke-width="1" />
      <g transform="translate(${cardWidth - outerPadding - 140}, ${outerPadding + 8})">
        <rect x="0" y="0" rx="12" ry="12" width="40" height="32" fill="#e22c2c" />
        <polygon points="15,9 15,23 27,16" fill="#ffffff" />
        <text x="50" y="23" font-family="'Space Grotesk', 'Segoe UI', sans-serif" font-size="18" font-weight="700" fill="#ffffff">YouTube</text>
      </g>

      ${headerAvatar}
      <text x="${outerPadding + 90}" y="${headerBarHeight + 38}" font-family="'Space Grotesk', 'Segoe UI', sans-serif" font-size="20" font-weight="700" fill="#f2f2f4">
        ${escapeXml(headerText)}
      </text>
      <text x="${outerPadding + 90}" y="${headerBarHeight + 58}" font-family="'Inter', 'Segoe UI', sans-serif" font-size="13" font-weight="600" fill="#b7b7bf">
        ${escapeXml(subtitle)}
      </text>
      <line x1="${outerPadding + 90}" y1="${headerBarHeight + 70}" x2="${cardWidth - outerPadding - 30}" y2="${headerBarHeight + 70}" stroke="#2f2f3a" stroke-width="1" />

      ${svgItems}

      <g transform="translate(0, ${totalHeight - 22})">
        <line x1="${outerPadding + 40}" y1="0" x2="${cardWidth / 2 - 70}" y2="0" stroke="#2f2f3a" stroke-width="1" />
        <text x="${cardWidth / 2}" y="4" font-family="'Inter', 'Segoe UI', sans-serif" font-size="11" fill="#9d9daa" text-anchor="middle">
          YouTube Stats Card
        </text>
        <line x1="${cardWidth / 2 + 70}" y1="0" x2="${cardWidth - outerPadding - 40}" y2="0" stroke="#2f2f3a" stroke-width="1" />
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
