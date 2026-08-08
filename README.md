# IELTS Mock Platform

React/Vite frontend with an Express API and SQLite or PostgreSQL storage.

## Requirements

- Node.js 22.5 or newer
- A persistent PostgreSQL database for production, or a persistent disk when using SQLite

## Local setup

```bash
npm run install:all
npm run build
npm start
```

The application starts on `http://localhost:5000` unless `PORT` is set.

## Environment variables

- `PORT`: HTTP port. Defaults to `5000`.
- `DATABASE_URL`: PostgreSQL connection string. Recommended for production and required for multi-instance deployments.
- `DATABASE_PATH`: SQLite file path when `DATABASE_URL` is not set. Ensure its directory is on a persistent disk in production.
- `DISABLE_TEST_FILE_CACHE`: Set to `true` on read-only or ephemeral filesystems. Uploaded HTML tests remain available from the database.

## Reliability checks

- `GET /api/health` verifies that both the API and database are available.
- Uploaded tests are stored in the database and optionally cached on disk.
- A repeated submission returns the existing successful result instead of creating a duplicate.
- The browser keeps an exam open until the server confirms that the submission was saved.
- `npm run check` runs lint, server syntax checks, and a production client build. The same checks run in GitHub Actions.
- `npm run smoke` runs a live-browser smoke test against every uploaded standalone test template (`server/public/tests/*.html`) with the harvest-bridge injected. It checks the failure modes that have actually broken real students' exams: identical content shown after switching Part/passage tabs, answer inputs not registering a click or keystroke, and a frozen countdown timer. Requires the local server running (`npm start` in another terminal) and, once, `npx playwright install chromium`. Run it after every test upload or reprocess, before releasing the test to students.

For production, run one application instance with SQLite or use PostgreSQL when scaling to multiple instances.
