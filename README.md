# Photo Exam Site (Netlify)

Student page: `/?exam=<id>`   Admin panel: `/admin.html`

## Deploy
1. Push this folder to a GitHub repo.
2. Netlify → Add new site → Import from Git → pick the repo (no build command needed; publish dir `public`).
3. Site settings → Environment variables → add `ADMIN_PASSWORD` (your own strong password). Redeploy.
4. Open `https://your-site.netlify.app/admin.html`, log in, create an exam, share the link.

Data (exams, photos, results) is stored in Netlify Blobs — no database setup required.
