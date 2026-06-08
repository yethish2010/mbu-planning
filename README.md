<div align="center">
<img width="1200" height="475" alt="GHBanner" src="" />
</div>



## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Production Notes

This app is a full-stack Node.js app with an Express server and a SQLite database.
It is not a static-only deployment.

Environment variables:

- `VITE_GEMINI_API_KEY`
- `APP_URL`
- `JWT_SECRET`
- `DATABASE_PATH`

`DATABASE_PATH` lets you store the SQLite file on a persistent disk instead of the project root.
That makes the current setup much safer on free or low-cost hosting platforms that support mounted storage.

Example:

```env
DATABASE_PATH=/var/data/campus.db
```

Recommended hosting for the current architecture:

- Render with a persistent disk
- Railway with persistent volume support
- A small VPS

Static-only hosts such as GitHub Pages or Netlify are not suitable for this backend.

## GitHub Pages

This repository now includes a GitHub Pages workflow for publishing the frontend bundle only.
To make `https://yethish2010.github.io/mbu-planning/` work correctly, configure these repository settings:

1. In GitHub Pages settings, use `GitHub Actions` as the source.
2. Add a repository variable named `VITE_API_BASE_URL` that points to your deployed backend, for example `https://your-api-host.example.com`.
   If you use this repository's Vercel project as the backend, the frontend now defaults to `https://mbu-planning.vercel.app` when it is running on GitHub Pages.
3. Add a repository secret named `VITE_GEMINI_API_KEY` if the frontend should use Gemini features in production.
4. On the backend host, set `FRONTEND_ORIGIN=https://yethish2010.github.io` so cookie-based auth can work from the Pages domain.

GitHub Pages will only host the frontend. The Express and SQLite backend still needs a real server host.
