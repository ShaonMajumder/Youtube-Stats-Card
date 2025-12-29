import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

async function generate() {
  const apiKey = (process.env.YOUTUBE_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Missing YOUTUBE_API_KEY");
  }

  const limit = parseLimitParam(process.env.LIMIT);
  const showDate = parseBooleanParam(process.env.SHOW_DATE, true);
  const showViews = parseBooleanParam(process.env.SHOW_VIEWS, true);
  const theme = parseThemeParam(process.env.THEME);

  const { channelId, handle } = await resolveChannelId({
    apiKey,
    handleParam: process.env.YOUTUBE_HANDLE,
    channelIdParam: process.env.YOUTUBE_CHANNEL_ID,
    envHandle: process.env.YOUTUBE_HANDLE,
    envChannelId: process.env.YOUTUBE_CHANNEL_ID,
  });

  const playlistId = getUploadsPlaylistId(channelId);
  let videos = await fetchLatestVideos(apiKey, playlistId, limit);
  if (showViews) {
    videos = await attachVideoStats(apiKey, videos);
  }

  const latestJson = buildLatestJson({
    channelId,
    handle,
    videos,
  });

  const svg = renderYoutubeCardSvg({
    videos,
    handle,
    channelId,
    theme,
    showDate,
    showViews,
  });

  await fs.writeFile(path.join(rootDir, "latest.json"), `${JSON.stringify(latestJson, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(rootDir, "latest.svg"), `${svg.trim()}\n`, "utf8");
}

generate().catch((error) => {
  console.error("Failed to generate YouTube stats card:", error);
  process.exit(1);
});
