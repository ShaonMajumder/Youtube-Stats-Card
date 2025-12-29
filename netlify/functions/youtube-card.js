import serverless from "serverless-http";
import app from "../../server/app.js";

// IMPORTANT: allow binary responses (jpg/png/webp/etc)
export const handler = serverless(app, {
  binary: ["image/*", "application/octet-stream"],
});
