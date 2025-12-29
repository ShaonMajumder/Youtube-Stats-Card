# YouTube Stats Card

Generate a sharp, always-up-to-date SVG card that showcases the latest YouTube uploads for any handle. The project pairs a bold React/Tailwind UI with a lightweight Express API (deployable as a Netlify Function) that calls the YouTube Data API and renders the SVG server-side.

**Live demo:** https://youtube-stats-card.netlify.app/  
![Latest YouTube Videos](https://youtube-stats-card.netlify.app/api/youtube-card?handle=@shaonmajumder)

## Features

- **Latest uploads** - Pulls the most recent videos, including thumbnails.
- **Customizable output** - Control limit, theme, publish date, and view count.
- **Serverless-ready** - One Express app runs locally or inside Netlify Functions.
- **Embed options** - Markdown, HTML, and direct URL snippets in the UI.

## Project Structure

```
Youtube-Stats-Card/
|-- src/
|   |-- components/
|   `-- pages/Index.tsx
|-- server/
|   |-- app.js
|   |-- generate.js
|   `-- youtube.js
|-- netlify/
|   `-- functions/
|       `-- youtube-card.js
|-- netlify.toml
|-- package.json
|-- README.md
|-- latest.json
`-- latest.svg
```

## Getting Started

```bash
cd Youtube-Stats-Card
npm install
```

### Environment

Create a `.env` based on `.env.example`:

```
YOUTUBE_API_KEY=your_key_here
YOUTUBE_HANDLE=@shaonmajumder
VITE_API_BASE_URL=
LIMIT=5
THEME=dark
SHOW_DATE=true
SHOW_VIEWS=true
```

### Local Development

```bash
npm run dev
```

### Generate SVG/JSON locally

```bash
npm run generate
```

## API Usage

### `GET /api/youtube-card`

Returns an SVG card.

Query params:
| Param | Type | Required | Description |
|-------------|--------|----------|-------------|
| `handle` | string | Yes | YouTube channel handle (use `@` or omit it). |
| `channel_id` | string | No | Direct channel ID (`UC...`) if you prefer not to use a handle. |
| `limit` | number | No | Number of videos (default `5`, max `10`). |
| `theme` | string | No | `light` or `dark`. |
| `show_date` | bool | No | Toggle publish date (`true`/`false`). |
| `show_views` | bool | No | Toggle view counts (`true`/`false`). |

Responses:

- `200 OK` - SVG card.
- `400 Bad Request` - `{ error: "Handle or channelId is required" }`
- `500 Internal Server Error` - `{ error: "Missing YOUTUBE_API_KEY" }`

### `GET /api/youtube-json`

Returns the latest video data in JSON.

## Deployment Notes

Because `netlify.toml` redirects `/api/*` to `/.netlify/functions/youtube-card`, the front-end can call `/api/youtube-card` locally and on Netlify without extra configuration. If deploying elsewhere, set `VITE_API_BASE_URL` accordingly.

## Author & Credits

**Built and maintained by [Shaon Majumder](https://shaonresume.netlify.app)**  
Senior Software Engineer - AI & Scalability

**Connect**

- Portfolio: https://shaonresume.netlify.app
- GitHub: https://github.com/ShaonMajumder
- LinkedIn: https://www.linkedin.com/in/shaonmajumder
- Medium: https://medium.com/@shaonmajumder
- Resume: https://shaonresume.netlify.app/resume.html

---

Happy building. Drop an issue or PR if you add something awesome.
