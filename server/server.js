import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { initDb } from './database.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { sanitizeTestHtml } from './contentSanitizer.js';
import { hashPassword, verifyPassword, generateSessionToken } from './auth.js';
import { FEEDBACK_SYSTEM_PROMPT, buildFeedbackRequest } from './writingFeedback.js';
import {
  extractReadingContent, passageForQuestion, scanAuthoredEvidence,
  EXPLANATION_SYSTEM_PROMPT, buildExplanationRequest, evidenceVerifiedInPassage
} from './readingExplanations.js';
import { renderFeedbackSheets, renderMarkdown } from './feedbackPrint.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const configuredPort = Number.parseInt(process.env.PORT, 10);
const port = Number.isInteger(configuredPort) && configuredPort >= 0 ? configuredPort : 5000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const SESSION_COOKIE = 'ielts_session';

// Loads req.authUser from the session cookie if present -- does not itself
// require one. Placed before every route so requireAuth/requireRole below
// can just read req.authUser instead of re-querying per route.
//
// This query now runs on every authenticated request, where none existed
// before -- and the database (Neon, scale-to-zero) suspends when idle and
// takes a moment to wake on the next query. Before today, that wake delay
// just made the first request after a quiet spell slow. Now it sits directly
// in the login check: if this specific query is the one that hits the
// wake-up window and fails, a real, valid session was at risk of silently
// looking like "not logged in" -- a legitimate teacher or admin bounced to
// the login screen by the client's own 401 handler, for a database hiccup
// that had nothing to do with whether they were signed in. One quick retry
// covers most wake-ups; if the database is still unreachable after that,
// this says so explicitly (503) instead of guessing "not logged in" (401),
// so a real outage reads as "try again in a second," not a spurious logout.
app.use(async (req, res, next) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return next();
  const lookup = () => db.get(
    `SELECT u.id, u.name, u.role, u.owner_teacher_id
     FROM sessions s JOIN users u ON s.user_id = u.id
     WHERE s.token = ?`,
    [token]
  );
  try {
    const row = await lookup();
    if (row) req.authUser = row;
    return next();
  } catch (e) {}
  try {
    await new Promise((r) => setTimeout(r, 400));
    const row = await lookup();
    if (row) req.authUser = row;
    return next();
  } catch (e) {
    return res.status(503).json({ error: 'The platform is temporarily unavailable. Please try again in a moment.', retrying: true });
  }
});

// Rejects with 401 unless a valid session is attached. Use before any route
// that must know who is actually calling, not merely what the request claims.
function requireAuth(req, res, next) {
  if (!req.authUser) return res.status(401).json({ error: 'Not logged in' });
  next();
}

// requireAuth plus a role check. Admin is never implicitly included -- pass
// it explicitly where the admin should also be allowed through.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.authUser) return res.status(401).json({ error: 'Not logged in' });
    if (!roles.includes(req.authUser.role)) return res.status(403).json({ error: 'Not permitted for this account' });
    next();
  };
}

// True once req.authUser is confirmed allowed to act on the given student id:
// the student themself, that student's own teacher, or an admin. Centralizes
// the ownership check every /api/teacher/* and /api/student/* route that
// touches one student's data needs to make.
async function canAccessStudent(authUser, studentId) {
  if (!authUser) return false;
  if (authUser.role === 'admin') return true;
  if (authUser.role === 'student') return authUser.id === studentId;
  if (authUser.role === 'teacher') {
    const student = await db.get('SELECT owner_teacher_id FROM users WHERE id = ?', [studentId]);
    return !!student && student.owner_teacher_id === authUser.id;
  }
  return false;
}

// Same check, starting from a submission id instead of a student id --
// covers every /api/teacher/* route that grades, reveals, deletes or drafts
// feedback for one specific submission.
async function canAccessSubmission(authUser, submissionId) {
  if (!authUser) return false;
  if (authUser.role === 'admin') return true;
  const row = await db.get('SELECT student_id FROM submissions WHERE id = ?', [submissionId]);
  if (!row) return false;
  return canAccessStudent(authUser, row.student_id);
}

// Same, for the separate speaking_submissions table.
async function canAccessSpeakingSubmission(authUser, submissionId) {
  if (!authUser) return false;
  if (authUser.role === 'admin') return true;
  const row = await db.get('SELECT student_id FROM speaking_submissions WHERE id = ?', [submissionId]);
  if (!row) return false;
  return canAccessStudent(authUser, row.student_id);
}

// Initialize Database connection.
//
// This used to be a top-level `await initDb()`, which meant the module body
// never reached app.listen() unless the database answered. When the provider
// started refusing queries ("exceeded the data transfer quota"), the port never
// opened, the host had nothing to route to, and every request hung with no
// response at all -- a silently dead site rather than a legible error. The
// database being down must degrade the platform, not prevent it from starting.
//
// So: connect in the background, let the server listen immediately, and answer
// API calls with a clear 503 until the database is actually usable. The retry
// loop also means the platform recovers on its own once the database returns,
// with no redeploy needed.
let realDb = null;
let dbError = null;
let dbAttempts = 0;

// A stable handle so every `db.get/all/run/exec/prepare(...)` call site keeps
// working unchanged; calls simply reject with a clear error until connected.
const db = new Proxy({}, {
  get(_target, prop) {
    if (prop === 'then') return undefined; // must not look like a promise
    return (...args) => {
      if (!realDb) {
        return Promise.reject(new Error(
          `Database unavailable: ${dbError ? dbError.message : 'not connected yet'}`
        ));
      }
      const value = realDb[prop];
      return typeof value === 'function' ? value.apply(realDb, args) : value;
    };
  }
});

const isDbReady = () => realDb !== null;

async function connectDatabaseWithRetry() {
  // Capped exponential backoff: quick enough to recover promptly from a blip,
  // slow enough not to hammer a database that is refusing connections.
  const delays = [2_000, 5_000, 10_000, 30_000, 60_000];
  for (;;) {
    dbAttempts += 1;
    try {
      realDb = await initDb();
      dbError = null;
      console.log(`Database initialized successfully (attempt ${dbAttempts}).`);
      return;
    } catch (error) {
      realDb = null;
      dbError = error;
      const wait = delays[Math.min(dbAttempts - 1, delays.length - 1)];
      console.error(
        `Failed to initialize database (attempt ${dbAttempts}): ${error.message}. Retrying in ${wait / 1000}s.`
      );
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
}

connectDatabaseWithRetry();

// Reports whether the platform is actually usable, so an outage is visible
// immediately instead of being inferred from hanging requests.
app.get('/api/health', (req, res) => {
  res.status(isDbReady() ? 200 : 503).json({
    ok: isDbReady(),
    database: isDbReady() ? 'connected' : 'unavailable',
    attempts: dbAttempts,
    // error.message only -- never the connection string.
    detail: isDbReady() ? undefined : (dbError ? dbError.message : 'connecting'),
    retrying: !isDbReady()
  });
});

// Anything touching data fails fast and legibly while the database is down,
// rather than surfacing as an opaque 500 (or, before this, no response at all).
app.use('/api', (req, res, next) => {
  if (isDbReady() || req.path === '/health') return next();
  res.status(503).json({
    error: 'The platform is temporarily unavailable because its database cannot be reached. '
      + 'It will reconnect automatically. Please do not start a test until this clears.',
    database: 'unavailable',
    retrying: true
  });
});

const submissionLocks = new Set();

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// IELTS bands only exist in whole/half-band increments (4.0, 4.5, 5.0, ...).
// AI-graded scores (writing, speaking) are asked to round to the nearest 0.5,
// but LLMs don't reliably follow that instruction on their own (e.g. 6.3
// instead of 6.5), so every AI-derived score must be forced through this.
function roundIelts(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 4.0;
  const clamped = Math.max(0, Math.min(9, number));
  const decimal = clamped - Math.floor(clamped);
  if (decimal < 0.25) return Math.floor(clamped);
  if (decimal < 0.75) return Math.floor(clamped) + 0.5;
  return Math.ceil(clamped);
}

app.get('/api/health', async (req, res) => {
  try {
    await db.get('SELECT 1 as ok');
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    res.status(503).json({ status: 'error', database: 'unavailable' });
  }
});

// Uploaded tests are stored in the database so they survive ephemeral deploy filesystems.
app.get('/tests/:fileName', async (req, res, next) => {
  const match = /^mock(\d+)\.html$/.exec(req.params.fileName);
  if (!match) return next();

  try {
    const test = await db.get('SELECT html_content FROM tests WHERE id = ?', [match[1]]);
    if (!test?.html_content) return next();

    // Was Cache-Control: no-store, so every student -- and every reload --
    // re-read the whole ~200 KB page out of the database. Combined with the
    // audio route that was the shape of the traffic which exhausted the
    // provider's transfer quota. A test's content only changes when it is
    // re-uploaded, so serve it revalidated instead: the ETag lets browsers
    // answer with 304 and no body, while a re-upload changes the tag and is
    // still picked up immediately (no stale paper for anyone mid-exam).
    res.set('Cache-Control', 'no-cache');
    res.type('html');
    res.send(test.html_content);
  } catch (error) {
    next(error);
  }
});

// Same three sources the route above resolves, in the same order, for code
// that needs a test's actual HTML rather than serving it: the database is
// authoritative for anything uploaded through the platform, but the original
// day-one seed tests (mock1-~20ish) were never migrated into it and only
// exist as files shipped with the app -- server/public/tests on disk, or
// failing that the client's own public/tests (always present from git,
// unlike the server-side copy which is not tracked and can go missing on a
// fresh deploy). Returns null, not an empty string, when nothing has it --
// callers must not silently treat "not found" as "empty test".
async function resolveTestHtml(testId, dbHtmlContent) {
  const onDiskServer = path.join(__dirname, 'public', 'tests', `mock${testId}.html`);
  try { return await fs.promises.readFile(onDiskServer, 'utf8'); } catch (e) {}

  if (dbHtmlContent) return dbHtmlContent;

  for (const clientDir of [path.join(__dirname, '../client/dist/tests'), path.join(__dirname, '../client/public/tests')]) {
    try { return await fs.promises.readFile(path.join(clientDir, `mock${testId}.html`), 'utf8'); } catch (e) {}
  }
  return null;
}

// Serves listening audio that was extracted out of an uploaded test's HTML
// (see the harvest-bridge upload path below). The database stays the source of
// truth, because the deploy filesystem is ephemeral -- but it is read ONCE per
// deploy per track, not once per request.
//
// This previously did "SELECT data_base64" on every request and decoded the
// whole track just to slice out the requested bytes. <audio> issues many Range
// requests while streaming and seeking, so a single student could pull a 15 MB
// track out of Postgres dozens of times over. Across a class that is gigabytes
// of database egress for one listening sitting, which is exactly what exhausted
// the provider's data-transfer quota and took the platform down.
//
// Now the track is materialised to a local cache file on first use and served
// from disk thereafter: Range handling, ETag and streaming come from sendFile,
// and the database sees one read per deploy instead of thousands.
// Deliberately outside public/: the route below is the only way in, so the
// cache files and their sidecars are never exposed as a directory listing.
const audioCacheDir = path.join(__dirname, 'audio-cache');
const audioMaterialising = new Map();

function materialiseAudio(id) {
  // Concurrent misses (a whole class starting at once) must trigger ONE
  // database read, not one per request -- otherwise the very stampede this
  // exists to prevent happens on every cold deploy.
  if (audioMaterialising.has(id)) return audioMaterialising.get(id);

  const job = (async () => {
    const asset = await db.get('SELECT mime_type, data_base64 FROM test_audio_assets WHERE id = ?', [id]);
    if (!asset) return null;

    await fs.promises.mkdir(audioCacheDir, { recursive: true });
    const filePath = path.join(audioCacheDir, `${id}.bin`);
    const tempPath = `${filePath}.${process.pid}.tmp`;
    // Write to a temp file and rename: a half-written cache file must never be
    // servable, or a student gets a truncated, silently broken track.
    await fs.promises.writeFile(tempPath, Buffer.from(asset.data_base64, 'base64'));
    await fs.promises.rename(tempPath, filePath);
    await fs.promises.writeFile(`${filePath}.type`, asset.mime_type || 'audio/mpeg');
    return { filePath, mimeType: asset.mime_type || 'audio/mpeg' };
  })().finally(() => {
    audioMaterialising.delete(id);
  });

  audioMaterialising.set(id, job);
  return job;
}

app.get('/tests-audio/:id', async (req, res, next) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return next();

  try {
    const filePath = path.join(audioCacheDir, `${id}.bin`);
    let mimeType;
    try {
      await fs.promises.access(filePath);
      mimeType = await fs.promises.readFile(`${filePath}.type`, 'utf8').catch(() => 'audio/mpeg');
    } catch {
      const made = await materialiseAudio(id);
      if (!made) return next();
      mimeType = made.mimeType;
    }

    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(mimeType);
    // sendFile streams from disk and handles Range/206 and conditional
    // requests itself, so seeking still works without loading the track into
    // memory -- let alone re-reading it from the database.
    res.sendFile(filePath, (error) => {
      if (error && !res.headersSent) next(error);
    });
  } catch (error) {
    next(error);
  }
});

// ----------------------------------------
// AUTHENTICATION
// ----------------------------------------
// Who a stored session actually belongs to now.
//
// The browser keeps the user it was handed at login, so anything that changes
// afterwards -- a rename, a role change -- stays invisible until someone logs
// out and back in, which nobody thinks to do. The app re-reads this on load so
// the details on screen are the ones in the database.
//
// Returns identity only, never the passcode hash, and no password is required:
// it discloses nothing a logged-in user cannot already see about themselves.
app.get('/api/auth/whoami/:id', requireAuth, async (req, res) => {
  const cleanId = String(req.params.id || '').trim().toLowerCase();
  if (req.authUser.role !== 'admin' && req.authUser.id.toLowerCase() !== cleanId) {
    return res.status(403).json({ error: 'Not permitted for this account' });
  }
  try {
    const user = await db.get('SELECT id, name, role, photo_data FROM users WHERE LOWER(TRIM(id)) = ?', [cleanId]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user.id, name: user.name, role: user.role, photo: user.photo_data || null });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const cleanId = String(req.body.id || '').trim().toLowerCase();
  const cleanPasscode = String(req.body.passcode || '').trim();

  if (!cleanId || !cleanPasscode) {
    return res.status(400).json({ error: 'Please enter User ID and Passcode' });
  }

  try {
    const user = await db.get('SELECT * FROM users WHERE LOWER(TRIM(id)) = ?', [cleanId]);
    if (!user) {
      return res.status(401).json({ error: `User ID "${req.body.id}" not found` });
    }

    if (!(await verifyPassword(cleanPasscode, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid passcode. Please check your credentials.' });
    }

    const token = generateSessionToken();
    await db.run('INSERT INTO sessions (token, user_id) VALUES (?, ?)', [token, user.id]);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });

    return res.json({ id: user.id, name: user.name, role: user.role, photo: user.photo_data || null });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Logs out the CURRENT session only (this device/browser), not every device
// the account is signed into elsewhere -- deleting by token, not by user_id.
app.post('/api/auth/logout', async (req, res) => {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await db.run('DELETE FROM sessions WHERE token = ?', [token]);
    res.clearCookie(SESSION_COOKIE);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Change Password API
app.post('/api/user/change-password', requireAuth, async (req, res) => {
  const { userId, currentPassword, newPassword } = req.body;
  if (req.authUser.role !== 'admin' && req.authUser.id !== userId) {
    return res.status(403).json({ error: 'Not permitted for this account' });
  }
  try {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (!(await verifyPassword(currentPassword, user.password_hash))) {
      return res.status(400).json({ error: 'Incorrect current password' });
    }
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(newPassword), userId]);
    res.json({ success: true, message: 'Password updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Profile photos: teacher and admin only, self-service only -- nobody, not
// even admin, sets someone else's photo, which keeps this a single-owner
// column with no separate authorization model to get wrong. Always the
// caller's own account (req.authUser.id from the verified session), never a
// body-supplied id.
app.post('/api/user/photo', requireRole('teacher', 'admin'), async (req, res) => {
  const { photoData } = req.body;
  if (typeof photoData !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(photoData)) {
    return res.status(400).json({ error: 'photoData must be a base64 JPEG, PNG, or WebP data URL' });
  }
  // The client resizes and compresses before sending, but a hard cap here
  // too so a stale client or a bug can't quietly bloat every row -- base64
  // runs about 4/3 the size of the raw bytes.
  const approxBytes = photoData.length * 0.75;
  if (approxBytes > 800 * 1024) {
    return res.status(400).json({ error: 'Photo is too large after encoding (max ~800KB) -- try a smaller image' });
  }
  try {
    await db.run('UPDATE users SET photo_data = ? WHERE id = ?', [photoData, req.authUser.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/user/photo', requireRole('teacher', 'admin'), async (req, res) => {
  try {
    await db.run('UPDATE users SET photo_data = NULL WHERE id = ?', [req.authUser.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------
// STUDENT APIS
// ----------------------------------------

// Get Student Dashboard Info
app.get('/api/student/dashboard/:studentId', requireAuth, async (req, res) => {
  const { studentId } = req.params;
  if (!(await canAccessStudent(req.authUser, studentId))) return res.status(403).json({ error: 'Not permitted for this student' });

  try {
    // Get assigned tests that are either 'assigned' or 'started'
    const assignments = await db.all(`
      SELECT a.id as assignment_id, a.status, a.assigned_at, t.id as test_id, t.title 
      FROM assignments a
      JOIN tests t ON a.test_id = t.id
      WHERE a.student_id = ? AND a.status != 'completed'
    `, [studentId]);

    // Get completed and revealed submissions (grades + feedback)
    const submissionRows = await db.all(`
      SELECT s.*, t.title
      FROM submissions s
      JOIN tests t ON s.test_id = t.id
      WHERE s.student_id = ? AND s.is_revealed = 1
      ORDER BY s.submitted_at DESC
    `, [studentId]);

    // These are stored as JSON strings -- parse them here so the client gets real
    // objects (indexing a raw JSON string by question number silently returns a
    // single character, not the intended answer).
    const submissions = submissionRows.map((sub) => {
      // The AI-drafted essay feedback only ever reaches a student once the
      // teacher has explicitly approved it (see /api/teacher/submissions/:id/
      // feedback) -- an unapproved draft must never appear here, so this
      // checks .approved itself rather than trusting the caller. Rendered to
      // HTML server-side with the same renderMarkdown the printed sheets use,
      // so the two stay identical and the client never parses markdown itself.
      let essayFeedback = null;
      const draft = parseJson(sub.writing_feedback_draft, null);
      if (draft?.approved && draft.feedback) {
        essayFeedback = { taskType: draft.taskType, html: renderMarkdown(draft.feedback) };
      }
      return {
        ...sub,
        listening_answers: parseJson(sub.listening_answers, {}),
        reading_answers: parseJson(sub.reading_answers, {}),
        writing_answers: parseJson(sub.writing_answers, {}),
        listening_detail: parseJson(sub.listening_detail, null),
        reading_detail: parseJson(sub.reading_detail, null),
        writing_scores: parseJson(sub.writing_scores, null),
        writing_feedback_draft: undefined,
        essay_feedback: essayFeedback
      };
    });

    res.json({ assignments, submissions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get detailed test data (questions only, omit answer keys if needed, but for simplicity we send full content)
app.get('/api/student/test/:testId', requireAuth, async (req, res) => {
  const { testId } = req.params;
  try {
    const test = await db.get('SELECT * FROM tests WHERE id = ?', [testId]);
    if (!test) {
      return res.status(404).json({ error: 'Test not found' });
    }
    res.json({
      id: test.id,
      title: test.title,
      listening_data: JSON.parse(test.listening_data),
      reading_data: JSON.parse(test.reading_data),
      writing_data: JSON.parse(test.writing_data),
      sequentialLock: !!Number(test.sequential_lock),
      explanations: test.explanations ? JSON.parse(test.explanations) : null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Submit Test Answers
app.post('/api/student/submit/:testId', requireAuth, async (req, res) => {
  const { testId } = req.params;
  const studentId = typeof req.body.studentId === 'string' ? req.body.studentId.trim() : '';
  if (!(await canAccessStudent(req.authUser, studentId))) return res.status(403).json({ error: 'Not permitted for this student' });
  const listeningAnswers = req.body.listeningAnswers && typeof req.body.listeningAnswers === 'object' ? req.body.listeningAnswers : {};
  const readingAnswers = req.body.readingAnswers && typeof req.body.readingAnswers === 'object' ? req.body.readingAnswers : {};
  const writingAnswers = req.body.writingAnswers && typeof req.body.writingAnswers === 'object' ? req.body.writingAnswers : {};
  // Per-question correct answer / correctness / explanation, harvested from
  // standalone iframe modules that support it. Native tests have no need for this
  // (their question bank already lives server-side), so these are simply absent.
  const listeningDetail = req.body.listeningDetail && typeof req.body.listeningDetail === 'object' ? req.body.listeningDetail : null;
  const readingDetail = req.body.readingDetail && typeof req.body.readingDetail === 'object' ? req.body.readingDetail : null;
  const violationsCount = Math.max(0, Math.min(999, Number.parseInt(req.body.violationsCount, 10) || 0));

  if (!studentId || !/^\d+$/.test(testId)) {
    return res.status(400).json({ error: 'A valid student and test are required' });
  }

  const lockKey = `${studentId}:${testId}`;
  if (submissionLocks.has(lockKey)) {
    return res.status(409).json({ error: 'This submission is already being processed' });
  }
  submissionLocks.add(lockKey);

  try {
    const student = await db.get("SELECT id, owner_teacher_id FROM users WHERE id = ? AND role = 'student'", [studentId]);
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const test = await db.get('SELECT * FROM tests WHERE id = ?', [testId]);
    if (!test) return res.status(404).json({ error: 'Test not found' });

    const assignment = await db.get(`
      SELECT id, status FROM assignments
      WHERE student_id = ? AND test_id = ?
      ORDER BY id DESC LIMIT 1
    `, [studentId, testId]);

    if (!assignment || assignment.status === 'completed') {
      const existing = await db.get(`
        SELECT listening_score, reading_score FROM submissions
        WHERE student_id = ? AND test_id = ?
        ORDER BY id DESC LIMIT 1
      `, [studentId, testId]);
      if (existing) {
        return res.json({
          success: true,
          duplicate: true,
          message: 'This test was already submitted successfully.',
          listeningScore: existing.listening_score,
          readingScore: existing.reading_score
        });
      }
      return res.status(403).json({ error: 'This test is not currently assigned to the student' });
    }

    const listeningData = parseJson(test.listening_data, {});
    const readingData = parseJson(test.reading_data, {});
    // Each module can independently be a standalone iframe (score reported by the
    // client, computed against an answer key embedded in that file) or native JSON
    // (scored here from server-side question data) -- a hybrid test can freely mix
    // the two, so this must never be a single flag derived from listening alone.
    const isListeningIframe = listeningData?.isIframe === true;
    const isReadingIframe = readingData?.isIframe === true;

    // Real incident: a student submitted the whole exam without ever completing
    // the Listening section (iframe never posted a band back), so req.body.listeningScore
    // was undefined here -- and node:sqlite's DatabaseSync.run() throws
    // "Provided value cannot be bound to SQLite parameter" for undefined (unlike
    // null, which it accepts fine), crashing the ENTIRE submission with a 500 and
    // losing every module the student did complete, not just the missing one.
    // null is the correct "no score for this module" value everywhere else in
    // this endpoint (getIeltsBand already returns null for the same case) --
    // this must match, not silently diverge to undefined.
    const validBand = (value) => {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0 || number > 9) return null;
      return Math.round(number * 2) / 2;
    };

    const getIeltsBand = (correct, total) => {
      if (total === 0) return null;
      const ratio = correct / total;
      // Scaled to a 40-question equivalent so short papers use the same
      // official table. The old ratio buckets had no 6.5 or 8.5 at all,
      // making two of the most common IELTS bands unreachable.
      const scaled = Math.round((correct / total) * 40);
      const t = [[39,9],[37,8.5],[35,8],[32,7.5],[30,7],[26,6.5],[23,6],[18,5.5],[16,5],[13,4.5],[10,4],[6,3.5],[4,3],[0,2.5]];
      for (let i = 0; i < t.length; i++) { if (scaled >= t[i][0]) return t[i][1]; }
      return 2.5;
    };

    const scoreQuestions = (groups, answers) => {
      let correct = 0;
      let total = 0;
      for (const group of Array.isArray(groups) ? groups : []) {
        for (const question of Array.isArray(group?.questions) ? group.questions : []) {
          if (question?.answer === undefined || question?.id === undefined) continue;
          total += 1;
          const studentAnswer = String(answers[question.id] ?? '').trim().toLowerCase();
          const acceptedAnswers = (Array.isArray(question.answer) ? question.answer : [question.answer])
            .map(answer => String(answer).trim().toLowerCase());
          if (acceptedAnswers.includes(studentAnswer)) correct += 1;
        }
      }
      return getIeltsBand(correct, total);
    };

    // Standalone HTML tests calculate against answer keys embedded in their document.
    // Native tests are always scored from the server-side question data.
    //
    // Third case, which used to fall through the gap: a self-contained paper that
    // covers several modules from ONE file. Only the module named at upload is
    // declared an iframe, so the others were scored against native question data
    // that does not exist -- total 0, band null -- even though the page had posted
    // a perfectly good band for them. Full mock 16 stored a listening band and a
    // null reading band for exactly this reason, with all 40 reading answers saved.
    //
    // The fix belongs here rather than in the test's module declarations: adding a
    // declaration makes the runner render another iframe of the same paper, which
    // breaks the exam itself. Scoring is the only thing that needs to change.
    //
    // Native scoring still wins wherever real question data exists, so nothing a
    // server can verify is ever replaced by a number the client supplied.
    const scoreModule = (declaredIframe, groups, answers, reportedBand) => {
      if (declaredIframe) return validBand(reportedBand);
      const native = scoreQuestions(groups, answers);
      if (native !== null) return native;
      // No question data to score against. Trust the paper's own band if it sent
      // one; otherwise stay null, which is what "this module never existed for
      // this test" means everywhere else in this endpoint.
      return validBand(reportedBand);
    };

    const listeningScore = scoreModule(isListeningIframe, listeningData.sections, listeningAnswers, req.body.listeningScore);
    const readingScore = scoreModule(isReadingIframe, readingData.passages, readingAnswers, req.body.readingScore);

    // Standalone Listening/Reading practice -- no Writing task -- reveals to the
    // student the moment it's scored. Nothing here needs a human judgment call,
    // and the graduating cohort's own feedback named the old always-wait gate as
    // the platform's single most common frustration. A Writing task (full mocks,
    // dedicated Writing papers) still waits for the teacher via
    // /api/teacher/reveal, since that score genuinely needs a person to look at
    // it first.
    //
    // Going instant reopens the exact risk the gate existed to close: a wrong
    // answer key reaching the whole class. So this still runs the same "the
    // class agrees on the same wrong answer" check used by bulk release before
    // auto-revealing (see computeAnswerKeyFlags below). It can't protect the
    // first few students on a brand-new key -- there isn't enough data yet to
    // see a pattern -- but once a question crosses that threshold, this test
    // stops auto-revealing and falls back to the manual queue instead of
    // reaching the rest of the class with the same wrong score.
    const writingData = parseJson(test.writing_data, {});
    const hasWritingTask = submissionHasWritingTask(
      { listening_answers: listeningAnswers, reading_answers: readingAnswers, writing_answers: writingAnswers },
      writingData
    );
    let defaultIsRevealed = 0;
    if (!hasWritingTask) {
      const existingFlags = await computeAnswerKeyFlags(Number(testId), student.owner_teacher_id);
      defaultIsRevealed = existingFlags.length === 0 ? 1 : 0;
    }

    await db.run(`
      INSERT INTO submissions (
        student_id, test_id, started_at, submitted_at,
        listening_answers, reading_answers, writing_answers,
        listening_detail, reading_detail,
        listening_score, reading_score, is_revealed, violations_count
      ) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      studentId,
      testId,
      JSON.stringify(listeningAnswers),
      JSON.stringify(readingAnswers),
      JSON.stringify(writingAnswers),
      listeningDetail ? JSON.stringify(listeningDetail) : null,
      readingDetail ? JSON.stringify(readingDetail) : null,
      listeningScore,
      readingScore,
      defaultIsRevealed,
      violationsCount
    );

    await db.run("UPDATE assignments SET status = 'completed' WHERE id = ?", [assignment.id]);

    res.json({
      success: true,
      message: 'Test submitted successfully! Your essays are now pending review.',
      listeningScore,
      readingScore
    });
  } catch (error) {
    console.error('Test submission failed:', error);
    res.status(500).json({ error: error.message });
  } finally {
    submissionLocks.delete(lockKey);
  }
});

app.get('/api/student/submission-status/:studentId/:testId', requireAuth, async (req, res) => {
  const { studentId, testId } = req.params;
  if (!(await canAccessStudent(req.authUser, studentId))) return res.status(403).json({ error: 'Not permitted for this student' });
  try {
    const assignment = await db.get(`
      SELECT status FROM assignments
      WHERE student_id = ? AND test_id = ?
      ORDER BY id DESC LIMIT 1
    `, [studentId, testId]);
    const submission = await db.get(`
      SELECT id, submitted_at FROM submissions
      WHERE student_id = ? AND test_id = ?
      ORDER BY id DESC LIMIT 1
    `, [studentId, testId]);
    res.json({
      submitted: Boolean(submission) && assignment?.status === 'completed',
      assignmentStatus: assignment?.status || null,
      submittedAt: submission?.submitted_at || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Assignment status (e.g. starting a test)
app.post('/api/student/assignment/start', requireAuth, async (req, res) => {
  const { studentId, testId } = req.body;
  if (!(await canAccessStudent(req.authUser, studentId))) return res.status(403).json({ error: 'Not permitted for this student' });
  try {
    const assignment = await db.get(`
      SELECT id, status FROM assignments
      WHERE student_id = ? AND test_id = ?
      ORDER BY id DESC LIMIT 1
    `, [studentId, testId]);
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
    if (assignment.status === 'completed') {
      return res.status(409).json({ error: 'This assignment has already been completed' });
    }
    if (assignment.status === 'assigned') {
      await db.run("UPDATE assignments SET status = 'started' WHERE id = ?", [assignment.id]);
    }
    res.json({ success: true, resumed: assignment.status === 'started' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------
// TEACHER APIS
// ----------------------------------------

// Fetch submissions (both pending and completed)
// One submission in full, including the per-question detail the list above
// leaves out. Fetched only when a teacher opens a paper, so the weight is paid
// once for one student rather than for every student on every dashboard load.
app.get('/api/teacher/submission/:id', requireRole('teacher', 'admin'), async (req, res) => {
  if (!(await canAccessSubmission(req.authUser, req.params.id))) return res.status(403).json({ error: 'Not permitted for this submission' });
  try {
    const sub = await db.get(`
      SELECT s.*, u.name as student_name, u.group_name as student_group, t.title as test_title, t.writing_data
      FROM submissions s
      JOIN users u ON s.student_id = u.id
      JOIN tests t ON s.test_id = t.id
      WHERE s.id = ?
    `, [req.params.id]);
    if (!sub) return res.status(404).json({ error: 'Submission not found' });

    res.json({
      ...sub,
      listening_answers: JSON.parse(sub.listening_answers || '{}'),
      reading_answers: JSON.parse(sub.reading_answers || '{}'),
      writing_answers: JSON.parse(sub.writing_answers || '{}'),
      writing_scores: JSON.parse(sub.writing_scores || 'null'),
      listening_detail: parseJson(sub.listening_detail, null),
      reading_detail: parseJson(sub.reading_detail, null),
      writing_data: undefined,
      test_writing_data: JSON.parse(sub.writing_data || '{}')
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/teacher/submissions', requireRole('teacher', 'admin'), async (req, res) => {
  try {
    const scoped = req.authUser.role === 'admin' ? '' : 'WHERE u.owner_teacher_id = ?';
    const params = req.authUser.role === 'admin' ? [] : [req.authUser.id];
    const submissions = await db.all(`
      SELECT s.*, u.name as student_name, u.group_name as student_group, t.title as test_title, t.listening_data, t.reading_data, t.writing_data
      FROM submissions s
      JOIN users u ON s.student_id = u.id
      JOIN tests t ON s.test_id = t.id
      ${scoped}
      ORDER BY s.submitted_at DESC
    `, params);
    // Deliberately omits the per-question detail. It is the bulk of this
    // response -- 0.62 MB of 0.96 MB across 65 submissions, thousands of
    // explanationHtml blocks -- and it grows with every paper sat, while the
    // dashboard list only shows names, tests and bands. It was being shipped on
    // every dashboard load and after most actions, on a free instance and a
    // metered database. The detail is fetched per submission when a teacher
    // actually opens one, via the route below.
    res.json(submissions.map(sub => ({
      ...sub,
      listening_answers: JSON.parse(sub.listening_answers || '{}'),
      reading_answers: JSON.parse(sub.reading_answers || '{}'),
      writing_answers: JSON.parse(sub.writing_answers || '{}'),
      writing_scores: JSON.parse(sub.writing_scores || 'null'),
      listening_detail: undefined,
      reading_detail: undefined,
      // The joined module data is only needed to know whether a Writing task
      // exists; the listening/reading blobs behind it are never read here.
      listening_data: undefined,
      reading_data: undefined,
      writing_data: undefined,
      test_writing_data: JSON.parse(sub.writing_data || '{}')
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Grade writing submission
// Correct a stored Listening or Reading band on one submission.
//
// Those bands are only ever written by the test itself at submit time, so a
// paper whose answer key turns out to be wrong has no route back: the marks are
// right, the key was not, and there was no way to put the score straight
// without editing the database by hand. Writing has had a grading endpoint all
// along; this is the equivalent for the auto-marked modules.
//
// Deliberately narrow -- it sets a band that a human has already worked out,
// and does not recompute anything. Values must be a real IELTS band, so a typo
// cannot store a number the rest of the platform will not understand.
app.post('/api/admin/submissions/:id/module-score', requireRole('admin'), async (req, res) => {
  const submissionId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(submissionId)) return res.status(400).json({ error: 'Invalid submission id' });

  const { moduleType, band, reason } = req.body;
  if (moduleType !== 'listening' && moduleType !== 'reading') {
    return res.status(400).json({ error: "moduleType must be 'listening' or 'reading'" });
  }
  const value = Number(band);
  // 0 is excluded on purpose: this file treats a stored 0 as "this module never
  // existed" (see the phantom-module repair endpoint), so it is not a band a
  // correction may set.
  if (!Number.isFinite(value) || value < 1 || value > 9 || Math.round(value * 2) !== value * 2) {
    return res.status(400).json({ error: 'band must be a whole or half band between 1 and 9' });
  }

  try {
    const column = moduleType === 'reading' ? 'reading_score' : 'listening_score';
    const before = await db.get(`SELECT id, ${column} AS current FROM submissions WHERE id = ?`, [submissionId]);
    if (!before) return res.status(404).json({ error: `Submission ${submissionId} not found` });

    await db.run(`UPDATE submissions SET ${column} = ? WHERE id = ?`, [value, submissionId]);
    console.log(
      `Module score corrected: submission ${submissionId} ${moduleType} ${before.current} -> ${value}` +
      (reason ? ` (${reason})` : '')
    );
    res.json({ success: true, submissionId, moduleType, previous: before.current, band: value });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Anonymous course feedback ────────────────────────────────────────────────
//
// Deliberately unauthenticated. Requiring a login to leave anonymous feedback is
// a contradiction students can see through, and one they are right not to trust:
// the moment a session is attached, the response can be traced. So this endpoint
// takes no identity, checks none, and stores none.
//
// What is NOT recorded, on purpose: student id, name, IP address, user agent,
// and the time of day. Only the answers and the calendar date. A precise
// timestamp on a class of sixty is an identifier by itself.
app.post('/api/feedback', async (req, res) => {
  const answers = req.body?.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return res.status(400).json({ error: 'answers object is required' });
  }

  // Bound what a single response can carry, so the form cannot be used to write
  // arbitrary amounts into the database.
  const cleaned = {};
  let fields = 0;
  for (const [k, v] of Object.entries(answers)) {
    if (fields >= 20) break;
    const key = String(k).slice(0, 40);
    const val = typeof v === 'number' ? v : String(v ?? '').slice(0, 4000);
    if (String(val).trim() === '') continue;
    cleaned[key] = val;
    fields++;
  }
  if (!fields) return res.status(400).json({ error: 'Nothing was filled in' });

  try {
    await db.run('INSERT INTO course_feedback (answers) VALUES (?)', [JSON.stringify(cleaned)]);
    // No id is returned: a receipt number is one more thing that could tie a
    // person to a row.
    res.json({ success: true, message: 'Thank you — your feedback was submitted anonymously.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Teacher's view of the responses.
//
// Shuffled before sending. Insertion order is a weak identifier -- the first
// response is usually whoever was handed the link first -- and shuffling costs
// nothing. The date is coarse enough to be safe and useful.
app.get('/api/teacher/feedback', requireRole('teacher', 'admin'), async (req, res) => {
  try {
    const rows = await db.all('SELECT id, answers, submitted_on FROM course_feedback');
    const parsed = rows.map(r => {
      let answers = {};
      try { answers = JSON.parse(r.answers || '{}'); } catch (e) { answers = {}; }
      return { answers, submittedOn: r.submitted_on };
    });
    for (let i = parsed.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [parsed[i], parsed[j]] = [parsed[j], parsed[i]];
    }
    res.json({ success: true, count: parsed.length, responses: parsed });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Re-mark every submission on a test against that test's CURRENT answer key.
//
// Marking is computed once, when a paper is submitted, and stored. So correcting
// a key afterwards fixes the paper for whoever sits it next and does nothing for
// everyone who already sat it -- their bands and their per-question review still
// reflect the old key. On Listening prediction 3, seventeen of eighteen students
// wrote the same answer to Q10 against a key that said something else.
//
// Dry run unless { confirm: true }. Reports every band that would move and why.
app.post('/api/admin/tests/:id/remark', requireRole('admin'), async (req, res) => {
  const testId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(testId)) return res.status(400).json({ error: 'Invalid test id' });
  const moduleType = req.body.moduleType === 'reading' ? 'reading' : 'listening';
  const confirm = req.body.confirm === true;

  const norm = v => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const BAND = [[39,9],[37,8.5],[35,8],[32,7.5],[30,7],[26,6.5],[23,6],[18,5.5],[16,5],[13,4.5],[10,4],[6,3.5],[4,3],[0,2.5]];
  const bandOf = c => { for (const [min, b] of BAND) if (c >= min) return b; return 2.5; };

  try {
    const test = await db.get('SELECT id, title, html_content FROM tests WHERE id = ?', [testId]);
    if (!test) return res.status(404).json({ error: `Test ${testId} not found` });
    if (!test.html_content) return res.status(400).json({ error: 'This test has no stored page to read a key from' });

    // Pull the key out of the page by walking braces; a lazy regex stops inside
    // the first array-valued entry.
    const at = test.html_content.search(/correctAnswers\s*=\s*\{/);
    if (at === -1) return res.status(400).json({ error: 'No correctAnswers key found in this test' });
    const open = test.html_content.indexOf('{', at);
    let depth = 0, end = -1, quote = null;
    for (let i = open; i < test.html_content.length; i++) {
      const c = test.html_content[i];
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (!depth) { end = i; break; } }
    }
    let key;
    try { key = new Function('return ' + test.html_content.slice(open, end + 1))(); }
    catch (e) { return res.status(400).json({ error: 'Could not parse the answer key: ' + e.message }); }

    const answersCol = `${moduleType}_answers`;
    const detailCol = `${moduleType}_detail`;
    const scoreCol = `${moduleType}_score`;
    const rows = await db.all(
      `SELECT s.id, s.student_id, s.${answersCol} AS answers, s.${detailCol} AS detail, s.${scoreCol} AS band,
              u.name AS student_name
       FROM submissions s JOIN users u ON s.student_id = u.id
       WHERE s.test_id = ? ORDER BY u.name`, [testId]
    );

    const changes = [];
    for (const row of rows) {
      let answers = {};
      try { answers = JSON.parse(row.answers || '{}'); } catch (e) { answers = {}; }
      // A paper with nothing in this module is not part of this exercise.
      const answered = Object.values(answers).filter(v => String(v ?? '').trim()).length;
      if (!answered) continue;

      let detail = {};
      try { detail = JSON.parse(row.detail || '{}'); } catch (e) { detail = {}; }

      let correct = 0;
      const flipped = [];
      const nextDetail = {};
      for (let n = 1; n <= 40; n++) {
        const accepted = (Array.isArray(key[n]) ? key[n] : [key[n]]).filter(a => a !== undefined);
        const given = answers[n];
        const isCorrect = accepted.some(a => norm(a) === norm(given)) && String(given ?? '').trim() !== '';
        if (isCorrect) correct++;
        const before = detail[n] ? detail[n].isCorrect : undefined;
        if (before !== undefined && before !== isCorrect) flipped.push({ q: n, from: before, to: isCorrect, answer: given });
        nextDetail[n] = {
          ...(detail[n] || {}),
          userAnswer: given ?? '',
          correctAnswer: accepted.join(' / '),
          isCorrect
        };
      }

      const band = bandOf(correct);
      if (band !== row.band || flipped.length) {
        changes.push({
          submissionId: row.id, student: row.student_name,
          correct, bandFrom: row.band, bandTo: band, flipped
        });
        if (confirm) {
          await db.run(
            `UPDATE submissions SET ${detailCol} = ?, ${scoreCol} = ? WHERE id = ?`,
            [JSON.stringify(nextDetail), band, row.id]
          );
        }
      }
    }

    if (confirm) console.log(`[remark] test ${testId} "${test.title}" ${moduleType}: updated ${changes.length} submission(s)`);

    res.json({
      success: true, dryRun: !confirm, testId, test: test.title, moduleType,
      submissionsConsidered: rows.length,
      changed: changes.length,
      changes: changes.map(c => ({
        ...c,
        flipped: c.flipped.map(f => `Q${f.q} ${f.from ? 'correct' : 'wrong'} -> ${f.to ? 'correct' : 'wrong'} ("${f.answer}")`)
      })),
      note: confirm ? 'written' : 'dry run — re-send with { "confirm": true }'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Pull one student's work for a paper into a single submission.
//
// Faults this week left several students' Full mock 16 spread across two rows:
// one attempt captured Listening and Reading and lost the essays, a later one
// carried the essays and nothing else. Neither row is the paper, and a teacher
// cannot grade half of one.
//
// Copies whole modules, chosen per module rather than per attempt -- one student
// had his best Listening in one row and his best Reading in the other, so taking
// "the better attempt" wholesale would have cost him a band.
//
// Deliberately conservative:
//   - dry run unless { confirm: true }, and it reports exactly what would change
//   - every source must be the same student and the same test as the target
//   - a module is only copied when the source actually has answers for it, so a
//     merge can never blank something the target already holds
//   - nothing is deleted; the source rows stay until a teacher removes them
app.post('/api/admin/submissions/merge', requireRole('admin'), async (req, res) => {
  const targetId = Number.parseInt(req.body.targetId, 10);
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'targetId is required' });
  const confirm = req.body.confirm === true;

  const wanted = {
    listening: Number.parseInt(req.body.listeningFrom, 10),
    reading: Number.parseInt(req.body.readingFrom, 10),
    writing: Number.parseInt(req.body.writingFrom, 10)
  };

  const answered = (json) => {
    try {
      const o = JSON.parse(json || '{}');
      return Object.values(o || {}).filter(v => String(v ?? '').trim()).length;
    } catch (e) { return 0; }
  };
  const essayLength = (json) => {
    try {
      const o = JSON.parse(json || '{}');
      return String(o.task1 || '').trim().length + String(o.task2 || '').trim().length;
    } catch (e) { return 0; }
  };

  try {
    const target = await db.get('SELECT * FROM submissions WHERE id = ?', [targetId]);
    if (!target) return res.status(404).json({ error: `Submission ${targetId} not found` });

    const sets = [], params = [], applied = [], skipped = [];

    for (const [moduleName, sourceId] of Object.entries(wanted)) {
      if (!Number.isInteger(sourceId)) continue;
      if (sourceId === targetId) { skipped.push(`${moduleName}: source is the target`); continue; }

      const src = await db.get('SELECT * FROM submissions WHERE id = ?', [sourceId]);
      if (!src) return res.status(404).json({ error: `Source submission ${sourceId} not found` });
      if (String(src.student_id) !== String(target.student_id)) {
        return res.status(409).json({
          error: `Submission ${sourceId} belongs to ${src.student_id}, not ${target.student_id}. Refusing to move one student's work onto another's paper.`
        });
      }
      if (Number(src.test_id) !== Number(target.test_id)) {
        return res.status(409).json({ error: `Submission ${sourceId} is for test ${src.test_id}, not ${target.test_id}` });
      }

      if (moduleName === 'writing') {
        if (essayLength(src.writing_answers) === 0) { skipped.push('writing: source has no essays'); continue; }
        sets.push('writing_answers = ?'); params.push(src.writing_answers);
        applied.push(`writing from ${sourceId} (${essayLength(src.writing_answers)} chars)`);
      } else {
        const col = `${moduleName}_answers`;
        if (answered(src[col]) === 0) { skipped.push(`${moduleName}: source has no answers`); continue; }
        sets.push(`${col} = ?`); params.push(src[col]);
        sets.push(`${moduleName}_detail = ?`); params.push(src[`${moduleName}_detail`]);
        sets.push(`${moduleName}_score = ?`); params.push(src[`${moduleName}_score`]);
        applied.push(`${moduleName} from ${sourceId} (${answered(src[col])}/40, band ${src[`${moduleName}_score`] ?? '-'})`);
      }
    }

    const summarise = (row) => ({
      listening: `${answered(row.listening_answers)}/40 band ${row.listening_score ?? '-'}`,
      reading: `${answered(row.reading_answers)}/40 band ${row.reading_score ?? '-'}`,
      writing: `${essayLength(row.writing_answers)} chars`
    });

    if (!sets.length) {
      return res.json({ success: true, dryRun: !confirm, targetId, applied: [], skipped, before: summarise(target), note: 'nothing to copy' });
    }

    if (!confirm) {
      return res.json({
        success: true, dryRun: true, targetId,
        student: target.student_id, testId: target.test_id,
        before: summarise(target), wouldApply: applied, skipped,
        note: 'dry run — re-send with { "confirm": true } to write this'
      });
    }

    params.push(targetId);
    await db.run(`UPDATE submissions SET ${sets.join(', ')} WHERE id = ?`, params);
    const after = await db.get('SELECT * FROM submissions WHERE id = ?', [targetId]);
    console.log(`[merge] submission ${targetId} (${target.student_id}) <- ${applied.join('; ')}`);

    res.json({
      success: true, dryRun: false, targetId,
      student: target.student_id, testId: target.test_id,
      before: summarise(target), after: summarise(after), applied, skipped
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a submission that is still waiting to be marked.
//
// Papers arrive spoiled sometimes -- a student starts the wrong test, submits
// blank, or sits it twice -- and until now the only way to clear one was the
// assignment reset, which is filed under assignments rather than the marking
// queue where the teacher actually notices the problem.
//
// Narrow on purpose, because this destroys a student's work:
//   - refuses anything already released, so a result a student has seen cannot
//     be deleted out from under them
//   - refuses anything already marked, so a graded paper is not lost to a
//     mis-click; ungrade it first if that is really the intent
// Both refusals say which rule applied, so the teacher knows what to do next.
// Draft written feedback for one essay.
//
// A draft only: it is stored against the submission and is not shown to the
// student until the teacher approves it. Marking is the teacher's judgement --
// this saves the typing, not the deciding.
app.post('/api/teacher/submissions/:id/draft-feedback', requireRole('teacher', 'admin'), async (req, res) => {
  const submissionId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(submissionId)) return res.status(400).json({ error: 'Invalid submission id' });
  if (!(await canAccessSubmission(req.authUser, submissionId))) return res.status(403).json({ error: 'Not permitted for this submission' });
  const taskType = req.body.taskType === 'task1' ? 'task1' : 'task2';

  try {
    const sub = await db.get(`
      SELECT s.id, s.student_id, s.writing_answers, u.name AS student_name, u.group_name,
             t.title AS test_title, t.writing_data
      FROM submissions s
      JOIN users u ON s.student_id = u.id
      JOIN tests t ON s.test_id = t.id
      WHERE s.id = ?
    `, [submissionId]);
    if (!sub) return res.status(404).json({ error: `Submission ${submissionId} not found` });

    const answers = JSON.parse(sub.writing_answers || '{}');
    const essay = String(answers[taskType] || '').trim();
    if (!essay) return res.status(400).json({ error: `This submission has no ${taskType} essay` });

    const writing = JSON.parse(sub.writing_data || '{}');
    const prompt = writing?.[taskType]?.prompt || '';

    const settings = await db.get('SELECT * FROM ai_settings LIMIT 1');
    if (!settings?.anthropic_api_key) {
      return res.status(400).json({ error: 'No Anthropic API key configured. Add one in Admin Settings.' });
    }

    const { content } = buildFeedbackRequest({
      studentName: sub.student_name, group: sub.group_name, prompt, essay, taskType
    });

    // Haiku by the teacher's choice: on their own graded essays it matched their
    // band as often as Opus, at about a tenth of the cost. Its feedback is
    // roughly a third the length, which is the trade they accepted. Opus and
    // Sonnet remain selectable per request for essays worth the extra depth.
    const ALLOWED_MODELS = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'];
    const model = ALLOWED_MODELS.includes(req.body.model) ? req.body.model : 'claude-haiku-4-5';

    const anthropic = new Anthropic({ apiKey: settings.anthropic_api_key });
    const response = await anthropic.messages.create({
      model,
      // Marking against band descriptors is judgement work, so thinking stays on
      // (the default). max_tokens covers thinking and the feedback together.
      max_tokens: 16000,
      system: FEEDBACK_SYSTEM_PROMPT,
      messages: [{ role: 'user', content }]
    });

    if (response.stop_reason === 'refusal') {
      return res.status(502).json({ error: 'The model declined to write this feedback.' });
    }
    const textBlock = response.content.find(block => block.type === 'text');
    const feedback = textBlock ? textBlock.text.trim() : '';
    if (!feedback) return res.status(502).json({ error: 'The model returned no feedback text.' });

    await db.run(
      'UPDATE submissions SET writing_feedback_draft = ? WHERE id = ?',
      [JSON.stringify({ taskType, feedback, model: response.model, draftedAt: new Date().toISOString() }), submissionId]
    );

    res.json({
      success: true,
      submissionId,
      student: sub.student_name,
      taskType,
      feedback,
      usage: response.usage
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save the teacher's edit of a draft, and optionally mark it approved.
//
// Approval is what separates a draft from feedback a student may see. The text
// stored here is the teacher's, not the model's -- once they have edited it, the
// edit is the record.
app.post('/api/teacher/submissions/:id/feedback', requireRole('teacher', 'admin'), async (req, res) => {
  const submissionId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(submissionId)) return res.status(400).json({ error: 'Invalid submission id' });
  if (!(await canAccessSubmission(req.authUser, submissionId))) return res.status(403).json({ error: 'Not permitted for this submission' });

  const feedback = typeof req.body.feedback === 'string' ? req.body.feedback.trim() : '';
  const approved = req.body.approved === true;
  if (!feedback) return res.status(400).json({ error: 'feedback text is required' });

  try {
    const existing = await db.get('SELECT writing_feedback_draft FROM submissions WHERE id = ?', [submissionId]);
    if (!existing) return res.status(404).json({ error: `Submission ${submissionId} not found` });

    let record = {};
    try { record = JSON.parse(existing.writing_feedback_draft || '{}'); } catch { record = {}; }
    record.feedback = feedback;
    record.editedAt = new Date().toISOString();
    record.approved = approved;
    if (approved) record.approvedAt = record.editedAt;

    await db.run('UPDATE submissions SET writing_feedback_draft = ? WHERE id = ?', [JSON.stringify(record), submissionId]);
    res.json({ success: true, submissionId, approved });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Draft feedback for every essay on a test that does not have one yet.
//
// Sequential rather than parallel: a class is 20-25 essays, and firing them all
// at once risks a rate limit that would leave half the class silently unmarked.
// Skips essays already drafted, so re-running after a failure costs nothing and
// never overwrites an edit the teacher has made.
app.post('/api/teacher/tests/:testId/draft-feedback-batch', requireRole('teacher', 'admin'), async (req, res) => {
  const testId = Number.parseInt(req.params.testId, 10);
  if (!Number.isInteger(testId)) return res.status(400).json({ error: 'Invalid test id' });
  const taskType = req.body.taskType === 'task1' ? 'task1' : 'task2';
  const ALLOWED_MODELS = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'];
  const model = ALLOWED_MODELS.includes(req.body.model) ? req.body.model : 'claude-haiku-4-5';

  try {
    const settings = await db.get('SELECT * FROM ai_settings LIMIT 1');
    if (!settings?.anthropic_api_key) {
      return res.status(400).json({ error: 'No Anthropic API key configured. Add one in Admin Settings.' });
    }

    const test = await db.get('SELECT title, writing_data FROM tests WHERE id = ?', [testId]);
    if (!test) return res.status(404).json({ error: `Test ${testId} not found` });
    const prompt = JSON.parse(test.writing_data || '{}')?.[taskType]?.prompt || '';

    const scoped = req.authUser.role === 'admin' ? '' : 'AND u.owner_teacher_id = ?';
    const params = req.authUser.role === 'admin' ? [testId] : [testId, req.authUser.id];
    const rows = await db.all(`
      SELECT s.id, s.writing_answers, s.writing_feedback_draft, u.name AS student_name, u.group_name
      FROM submissions s JOIN users u ON s.student_id = u.id
      WHERE s.test_id = ? ${scoped} ORDER BY u.name
    `, params);

    const anthropic = new Anthropic({ apiKey: settings.anthropic_api_key });
    const results = [];

    for (const row of rows) {
      const essay = String(JSON.parse(row.writing_answers || '{}')[taskType] || '').trim();
      if (!essay) { results.push({ id: row.id, student: row.student_name, status: 'no essay' }); continue; }
      if (row.writing_feedback_draft) { results.push({ id: row.id, student: row.student_name, status: 'already drafted' }); continue; }

      try {
        const { content } = buildFeedbackRequest({
          studentName: row.student_name, group: row.group_name, prompt, essay, taskType
        });
        const response = await anthropic.messages.create({
          model, max_tokens: 16000, system: FEEDBACK_SYSTEM_PROMPT,
          messages: [{ role: 'user', content }]
        });
        const block = response.content.find(b => b.type === 'text');
        if (response.stop_reason === 'refusal' || !block) {
          results.push({ id: row.id, student: row.student_name, status: 'model returned nothing' });
          continue;
        }
        await db.run('UPDATE submissions SET writing_feedback_draft = ? WHERE id = ?', [
          JSON.stringify({ taskType, feedback: block.text.trim(), model: response.model, draftedAt: new Date().toISOString() }),
          row.id
        ]);
        results.push({
          id: row.id, student: row.student_name, status: 'drafted',
          band: (block.text.match(/\*\*Band Score:\s*([^*]+)\*\*/) || [])[1]?.trim() || null
        });
      } catch (err) {
        // One failure must not abandon the rest of the class.
        results.push({ id: row.id, student: row.student_name, status: 'failed: ' + err.message.slice(0, 80) });
      }
    }

    res.json({
      success: true, test: test.title, model, taskType,
      drafted: results.filter(r => r.status === 'drafted').length,
      skipped: results.filter(r => r.status === 'already drafted').length,
      failed: results.filter(r => r.status.startsWith('failed') || r.status === 'model returned nothing').length,
      results
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Every essay on a test with its draft status, for the review screen.
//
// Returns the essay alongside the feedback: the teacher is judging whether the
// draft is fair, and that is not a judgement anyone can make without the paper
// in front of them.
app.get('/api/teacher/tests/:testId/feedback', requireRole('teacher', 'admin'), async (req, res) => {
  const testId = Number.parseInt(req.params.testId, 10);
  if (!Number.isInteger(testId)) return res.status(400).json({ error: 'Invalid test id' });
  const taskType = req.query.taskType === 'task1' ? 'task1' : 'task2';

  try {
    const test = await db.get('SELECT title, writing_data FROM tests WHERE id = ?', [testId]);
    if (!test) return res.status(404).json({ error: `Test ${testId} not found` });

    const scoped = req.authUser.role === 'admin' ? '' : 'AND u.owner_teacher_id = ?';
    const params = req.authUser.role === 'admin' ? [testId] : [testId, req.authUser.id];
    const rows = await db.all(`
      SELECT s.id, s.writing_answers, s.writing_feedback_draft, s.student_id,
             u.name AS student_name, u.group_name
      FROM submissions s JOIN users u ON s.student_id = u.id
      WHERE s.test_id = ? ${scoped} ORDER BY u.name
    `, params);

    const students = rows.map(row => {
      const essay = String(JSON.parse(row.writing_answers || '{}')[taskType] || '').trim();
      let record = null;
      try { record = JSON.parse(row.writing_feedback_draft || 'null'); } catch { record = null; }
      const feedback = record?.feedback || '';
      return {
        submissionId: row.id,
        student: row.student_name,
        studentId: row.student_id,
        group: row.group_name,
        words: essay ? essay.split(/\s+/).filter(Boolean).length : 0,
        hasEssay: Boolean(essay),
        essay,
        feedback,
        band: (feedback.match(/\*\*Band Score:\s*([^*]+)\*\*/) || [])[1]?.trim() || null,
        approved: record?.approved === true,
        edited: Boolean(record?.editedAt),
        model: record?.model || null
      };
    });

    res.json({
      success: true, testId, test: test.title, taskType,
      prompt: JSON.parse(test.writing_data || '{}')?.[taskType]?.prompt || '',
      students
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fills in real, passage-evidence explanations for a standalone Reading
// test's questions. Two sources, tried in order:
//
//   1. Evidence the test already carries. Most uploaded tests define their
//      own {question, text} evidence pairs that drive their own "Check
//      Answers" screen (it highlights this exact text in the passage). This
//      was written by whoever built the test, not guessed afterward, so it's
//      used directly -- free, instant, and needs no verification.
//   2. Only for questions still uncovered after that, and only on the older
//      template family that exposes clean passage + answer-key data, this
//      asks Claude for an evidence quote and mechanically verifies it's an
//      exact substring of the real passage before storing it. Skipped
//      entirely if no Anthropic key is configured -- source 1 alone already
//      covers most of what's actually assigned.
//
// Dry-run by default; pass confirm:true to store the result on
// tests.explanations. Already-generated questions are skipped unless
// regenerate:true, so re-running after a partial failure costs nothing extra.
app.post('/api/admin/tests/:id/generate-explanations', requireRole('admin'), async (req, res) => {
  const testId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(testId)) return res.status(400).json({ error: 'Invalid test id' });
  const confirm = req.body.confirm === true;
  const ALLOWED_MODELS = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'];
  const model = ALLOWED_MODELS.includes(req.body.model) ? req.body.model : 'claude-haiku-4-5';

  try {
    const test = await db.get('SELECT title, html_content, explanations FROM tests WHERE id = ?', [testId]);
    if (!test) return res.status(404).json({ error: `Test ${testId} not found` });
    const html = await resolveTestHtml(testId, test.html_content);
    if (!html) return res.status(400).json({ error: 'This test has no standalone HTML to read passages from' });

    let stored = {};
    try { stored = JSON.parse(test.explanations || '{}'); } catch { stored = {}; }

    const results = [];
    const authored = scanAuthoredEvidence(html);

    for (const [qStr, evidence] of Object.entries(authored)) {
      const qNum = Number(qStr);
      if (stored[qNum] && !req.body.regenerate) {
        results.push({ question: qNum, status: 'already generated' });
        continue;
      }
      stored[qNum] = { evidence, reasonIntro: '', tip: '', source: 'authored', generatedAt: new Date().toISOString() };
      results.push({ question: qNum, status: 'used authored evidence' });
    }

    // Fall back to generation only for what authored evidence didn't cover,
    // and only if the older passages+answerKey shape applies here at all.
    const content = extractReadingContent(html);
    const remaining = content
      ? Object.entries(content.questionPrompts).filter(([qStr]) => !(Number(qStr) in stored) || req.body.regenerate)
      : [];

    if (remaining.length) {
      const settings = await db.get('SELECT * FROM ai_settings LIMIT 1');
      if (!settings?.anthropic_api_key) {
        results.push({ question: null, status: `${remaining.length} question(s) have no authored evidence and no Anthropic API key is configured to generate them -- skipped` });
      } else {
        const anthropic = new Anthropic({ apiKey: settings.anthropic_api_key });

        const generateOne = async (qNum, prompt) => {
          const passage = passageForQuestion(content, qNum);
          if (!passage) return { status: 'no passage found for this question' };
          const rawAnswer = content.answerKey[qNum];
          const correctAnswer = Array.isArray(rawAnswer) ? rawAnswer.join(' / ') : rawAnswer;

          let lastText = '';
          for (let attempt = 1; attempt <= 2; attempt++) {
            const { content: userContent } = buildExplanationRequest({
              passageTitle: passage.title, passageText: passage.text,
              questionNumber: qNum, questionPrompt: prompt, correctAnswer
            });
            const message = attempt === 1
              ? userContent
              : `${userContent}\n\nYour previous "evidence" was not an exact quote from the passage above. Copy it character-for-character this time -- do not paraphrase.`;

            const response = await anthropic.messages.create({
              model, max_tokens: 1024, system: EXPLANATION_SYSTEM_PROMPT,
              messages: [{ role: 'user', content: message }]
            });
            const block = response.content.find(b => b.type === 'text');
            if (!block) continue;
            lastText = block.text;
            const jsonMatch = block.text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) continue;
            let parsed;
            try { parsed = JSON.parse(jsonMatch[0]); } catch { continue; }
            if (parsed.evidence && evidenceVerifiedInPassage(parsed.evidence, passage.text)) {
              return {
                status: 'generated',
                data: { evidence: parsed.evidence, reasonIntro: parsed.reasonIntro || '', tip: parsed.tip || '', source: 'generated', model: response.model, generatedAt: new Date().toISOString() }
              };
            }
          }
          return { status: 'could not verify an exact evidence quote, skipped', sample: lastText.slice(0, 160) };
        };

        for (const [qStr, prompt] of remaining) {
          const qNum = Number(qStr);
          try {
            const outcome = await generateOne(qNum, prompt);
            if (outcome.status === 'generated') stored[qNum] = outcome.data;
            results.push({ question: qNum, status: outcome.status, ...(outcome.sample ? { sample: outcome.sample } : {}) });
          } catch (err) {
            results.push({ question: qNum, status: 'failed: ' + err.message.slice(0, 100) });
          }
        }
      }
    }

    if (confirm) {
      await db.run('UPDATE tests SET explanations = ? WHERE id = ?', [JSON.stringify(stored), testId]);
    }

    res.json({
      success: true, dryRun: !confirm, testId, test: test.title, model,
      fromAuthoredEvidence: Object.keys(authored).length,
      generatedByModel: results.filter(r => r.status === 'generated').length,
      totalStored: Object.keys(stored).length,
      results
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Print-ready feedback for a whole test, one student per page.
// ?includeDrafts=true to proof unapproved drafts before releasing them.
app.get('/api/teacher/tests/:testId/feedback-print', requireRole('teacher', 'admin'), async (req, res) => {
  const testId = Number.parseInt(req.params.testId, 10);
  if (!Number.isInteger(testId)) return res.status(400).send('Invalid test id');
  const includeDrafts = req.query.includeDrafts === 'true';

  try {
    const test = await db.get('SELECT title FROM tests WHERE id = ?', [testId]);
    if (!test) return res.status(404).send('Test not found');

    const scoped = req.authUser.role === 'admin' ? '' : 'AND u.owner_teacher_id = ?';
    const params = req.authUser.role === 'admin' ? [testId] : [testId, req.authUser.id];
    const rows = await db.all(`
      SELECT s.id, s.writing_answers, s.writing_feedback_draft, s.student_id,
             u.name AS student_name, u.group_name
      FROM submissions s JOIN users u ON s.student_id = u.id
      WHERE s.test_id = ? AND s.writing_feedback_draft IS NOT NULL ${scoped}
      ORDER BY u.name
    `, params);

    let taskLabel = 'Writing Task 2';
    const students = [];
    for (const row of rows) {
      let record; try { record = JSON.parse(row.writing_feedback_draft); } catch { continue; }
      if (!record?.feedback) continue;
      if (!includeDrafts && !record.approved) continue;
      if (record.taskType === 'task1') taskLabel = 'Writing Task 1';
      const essay = String(JSON.parse(row.writing_answers || '{}')[record.taskType || 'task2'] || '');
      students.push({
        name: row.student_name, group: row.group_name, studentId: row.student_id,
        words: essay.trim().split(/\s+/).filter(Boolean).length,
        feedback: record.feedback
      });
    }

    if (!students.length) {
      return res.status(404).send(includeDrafts
        ? 'No feedback has been drafted for this test yet.'
        : 'No approved feedback for this test yet. Add ?includeDrafts=true to proof the drafts.');
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderFeedbackSheets({ testTitle: test.title, taskLabel, students }));
  } catch (error) {
    res.status(500).send('Could not build the feedback sheets: ' + error.message);
  }
});

app.post('/api/teacher/submissions/:id/delete', requireRole('teacher', 'admin'), async (req, res) => {
  const submissionId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(submissionId)) return res.status(400).json({ error: 'Invalid submission id' });
  if (!(await canAccessSubmission(req.authUser, submissionId))) return res.status(403).json({ error: 'Not permitted for this submission' });

  try {
    const sub = await db.get(
      'SELECT id, student_id, test_id, is_revealed, writing_score FROM submissions WHERE id = ?',
      [submissionId]
    );
    if (!sub) return res.status(404).json({ error: `Submission ${submissionId} not found` });

    if (sub.is_revealed === 1 || sub.is_revealed === true) {
      return res.status(409).json({
        error: 'This result has already been released to the student. Hide it first if it really should be deleted.'
      });
    }
    if (sub.writing_score !== null && sub.writing_score !== undefined) {
      return res.status(409).json({
        error: 'This paper has already been marked. Clear its grade first if it really should be deleted.'
      });
    }

    await db.run('DELETE FROM submissions WHERE id = ?', [submissionId]);

    // Put the test back on the student's list so a spoiled attempt can be re-sat
    // -- deleting the paper without this leaves them with nothing to do.
    await db.run(
      "UPDATE assignments SET status = 'assigned' WHERE student_id = ? AND test_id = ?",
      [sub.student_id, sub.test_id]
    );

    console.log(`Submission ${submissionId} deleted by teacher; test ${sub.test_id} re-assigned to ${sub.student_id}.`);
    res.json({ success: true, deletedId: submissionId, reassignedTo: sub.student_id, testId: sub.test_id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/teacher/grade/:submissionId', requireRole('teacher', 'admin'), async (req, res) => {
  const { submissionId } = req.params;
  if (!(await canAccessSubmission(req.authUser, submissionId))) return res.status(403).json({ error: 'Not permitted for this submission' });
  const { writingScores, teacherFeedback, gradedBy } = req.body;

  const calculateOverallWritingBand = (scores) => {
    if (!scores) return 6.0;
    // Support dual task scoring: { task1: { ta, cc, lr, gra }, task2: { tr, cc, lr, gra } }
    const bandOfTask = (task) => {
      const vals = Object.values(task).map(Number).filter(v => !isNaN(v));
      return roundIelts(vals.reduce((a, b) => a + b, 0) / (vals.length || 4));
    };
    if (scores.task1 && scores.task2) {
      const t1Band = bandOfTask(scores.task1);
      const t2Band = bandOfTask(scores.task2);
      // Official IELTS weighting: Task 1 is 1/3, Task 2 is 2/3
      const weightedAvg = (t1Band * 1 + t2Band * 2) / 3;
      return roundIelts(weightedAvg);
    }
    // A test may set only one of the two tasks (e.g. the Task-2-only "Day N"
    // files). That task is then the whole Writing band. Without this, the flat
    // fallback below looks for ta/cc/lr/gra, finds none, averages an empty list
    // and stores a Writing band of 0 for a genuinely graded essay.
    if (scores.task2) return bandOfTask(scores.task2);
    if (scores.task1) return bandOfTask(scores.task1);
    // Fallback for single rubric { ta, cc, lr, gra }
    const vals = [scores.ta, scores.cc, scores.lr, scores.gra].map(Number).filter(v => !isNaN(v));
    const avg = vals.reduce((a, b) => a + b, 0) / (vals.length || 4);
    return roundIelts(avg);
  };

  // No rubric means "not marked", which has to store NULL. Sending nothing used
  // to fall through to a flat 6.0, and sending {} averaged an empty list to 0 --
  // and a stored 0 is exactly the corrupt-data signature that drags a student's
  // skill average toward zero on their own dashboard. Both wrote a number where
  // the honest answer was "no mark yet", so an empty rubric now clears the grade
  // instead, which is also the only way to undo a mistaken one.
  const hasRubric = !!writingScores && typeof writingScores === 'object'
    && Object.keys(writingScores).length > 0;

  try {
    const writingScore = hasRubric ? calculateOverallWritingBand(writingScores) : null;

    // graded_by is a foreign key into users, and the browser sends whatever id
    // its stored login holds. After the database move, a teacher whose session
    // predates it sends an id that no longer exists, the constraint rejects the
    // whole row, and marking fails with nothing saved -- reported as "failed to
    // save" with no clue that a stale login is the cause.
    //
    // Who marked it is an audit note; the marks are the thing worth keeping. An
    // id that does not resolve is recorded as unknown rather than costing the
    // teacher the essay they just marked.
    let grader = null;
    if (gradedBy) {
      const known = await db.get('SELECT id FROM users WHERE id = ?', [gradedBy]);
      if (known) grader = known.id;
      else console.warn(`Grade on submission ${submissionId}: unknown grader "${gradedBy}" (stale login?); saving marks without it.`);
    }

    await db.run(`
      UPDATE submissions
      SET writing_scores = ?,
          writing_score = ?,
          teacher_feedback = ?,
          graded_by = ?
      WHERE id = ?
    `, [hasRubric ? JSON.stringify(writingScores) : null, writingScore, teacherFeedback, grader, submissionId]);

    res.json({ success: true, writingScore });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reveal score
app.post('/api/teacher/reveal/:submissionId', requireRole('teacher', 'admin'), async (req, res) => {
  const { submissionId } = req.params;
  if (!(await canAccessSubmission(req.authUser, submissionId))) return res.status(403).json({ error: 'Not permitted for this submission' });
  const { isRevealed } = req.body; // 1 or 0
  try {
    await db.run('UPDATE submissions SET is_revealed = ? WHERE id = ?', [isRevealed ? 1 : 0, submissionId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Flags a test's answer key as suspect before its scores go out in bulk. The
// signal is the one that actually caught a bad key this term: a question where
// most students who got it "wrong" wrote the exact SAME wrong answer. Genuine
// mistakes scatter across many different wrong answers; a broken key produces
// one specific answer that keeps recurring, because the class was right and the
// key was wrong. Only counts answered questions -- leaving one blank is not
// evidence about the key.
async function computeAnswerKeyFlags(testId, ownerTeacherId) {
  const scoped = ownerTeacherId ? 'AND u.owner_teacher_id = ?' : '';
  const params = ownerTeacherId ? [testId, ownerTeacherId] : [testId];
  const rows = await db.all(
    `SELECT s.listening_detail, s.reading_detail FROM submissions s
     JOIN users u ON s.student_id = u.id
     WHERE s.test_id = ? AND (s.listening_detail IS NOT NULL OR s.reading_detail IS NOT NULL) ${scoped}`,
    params
  );
  const norm = v => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const MIN_SAMPLE = 4;
  const WRONG_RATE_THRESHOLD = 0.5;
  const AGREEMENT_THRESHOLD = 0.6;
  const flags = [];

  for (const moduleName of ['listening', 'reading']) {
    const col = `${moduleName}_detail`;
    const stats = {}; // qNum -> { total, wrong, wrongCounts: {answer: count} }
    for (const row of rows) {
      let detail;
      try { detail = JSON.parse(row[col] || 'null'); } catch { detail = null; }
      if (!detail) continue;
      for (const [qNum, d] of Object.entries(detail)) {
        const given = norm(d?.userAnswer);
        if (!given) continue;
        const s = stats[qNum] || (stats[qNum] = { total: 0, wrong: 0, wrongCounts: {} });
        s.total++;
        if (!d.isCorrect) {
          s.wrong++;
          s.wrongCounts[given] = (s.wrongCounts[given] || 0) + 1;
        }
      }
    }
    for (const [qNum, s] of Object.entries(stats)) {
      if (s.total < MIN_SAMPLE || s.wrong / s.total < WRONG_RATE_THRESHOLD) continue;
      const [topAnswer, topCount] = Object.entries(s.wrongCounts).sort((a, b) => b[1] - a[1])[0];
      const topShare = topCount / s.wrong;
      if (topShare >= AGREEMENT_THRESHOLD) {
        flags.push({
          module: moduleName,
          question: Number(qNum),
          sampleSize: s.total,
          wrongCount: s.wrong,
          wrongRate: Math.round((s.wrong / s.total) * 100) / 100,
          topWrongAnswer: topAnswer,
          topWrongShare: Math.round(topShare * 100) / 100
        });
      }
    }
  }
  return flags.sort((a, b) => a.module === b.module ? a.question - b.question : a.module.localeCompare(b.module));
}

// Whether a submission carries a real Writing task that needs a human band --
// same rule the Teacher Dashboard uses to decide "ready to release", kept in
// sync here so bulk release can't disagree with what the UI shows.
function submissionHasWritingTask(sub, testWritingData) {
  if (testWritingData?.task1?.prompt || testWritingData?.task2?.prompt) return true;
  const essays = String(sub.writing_answers?.task1 || '').trim() || String(sub.writing_answers?.task2 || '').trim();
  if (!essays) return false;
  const answered = (obj) => Object.values(obj || {}).filter(v => String(v ?? '').trim()).length;
  return answered(sub.listening_answers) > 0 && answered(sub.reading_answers) > 0;
}

// Tells the teacher whether a test's scores are safe to release in one click:
// clean if no question shows the "everyone agrees on the same wrong answer"
// fingerprint of a broken key.
app.get('/api/teacher/release-check/:testId', requireRole('teacher', 'admin'), async (req, res) => {
  const testId = Number.parseInt(req.params.testId, 10);
  try {
    const test = await db.get('SELECT title FROM tests WHERE id = ?', [testId]);
    if (!test) return res.status(404).json({ error: 'Test not found' });
    const ownerScope = req.authUser.role === 'admin' ? undefined : req.authUser.id;
    const flags = await computeAnswerKeyFlags(testId, ownerScope);
    res.json({ success: true, testId, testTitle: test.title, flags, clean: flags.length === 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Releases every ready-to-release, not-yet-released submission on one test at
// once. Refuses outright if the key looks suspect -- bulk release must not be
// the fast way to hand a whole class a wrong score.
app.post('/api/teacher/reveal-batch', requireRole('teacher', 'admin'), async (req, res) => {
  const testId = Number.parseInt(req.body.testId, 10);
  if (!Number.isInteger(testId)) return res.status(400).json({ error: 'testId is required' });
  try {
    const ownerScope = req.authUser.role === 'admin' ? undefined : req.authUser.id;
    const flags = await computeAnswerKeyFlags(testId, ownerScope);
    if (flags.length) {
      return res.status(409).json({ error: 'This test has flagged questions and was not released. Check the answer key before releasing manually.', flags });
    }

    const scoped = req.authUser.role === 'admin' ? '' : 'AND u.owner_teacher_id = ?';
    const params = req.authUser.role === 'admin' ? [testId] : [testId, req.authUser.id];
    const rows = await db.all(
      `SELECT s.id, s.writing_score, s.listening_answers, s.reading_answers, s.writing_answers, t.writing_data
       FROM submissions s JOIN tests t ON s.test_id = t.id JOIN users u ON s.student_id = u.id
       WHERE s.test_id = ? AND s.is_revealed != 1 ${scoped}`,
      params
    );
    const ready = rows.filter(r => {
      const sub = {
        writing_answers: JSON.parse(r.writing_answers || '{}'),
        listening_answers: JSON.parse(r.listening_answers || '{}'),
        reading_answers: JSON.parse(r.reading_answers || '{}')
      };
      let writingData; try { writingData = JSON.parse(r.writing_data || '{}'); } catch { writingData = {}; }
      return r.writing_score !== null || !submissionHasWritingTask(sub, writingData);
    });

    if (!ready.length) return res.json({ success: true, released: 0 });
    const ids = ready.map(r => r.id);
    await db.run(`UPDATE submissions SET is_revealed = 1 WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    res.json({ success: true, released: ids.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------
// ADMIN APIS
// ----------------------------------------

// Admin Overview Metrics
app.get('/api/admin/overview', requireRole('admin'), async (req, res) => {
  try {
    const studentCount = await db.get("SELECT COUNT(*) as count FROM users WHERE role = 'student'");
    const testCount = await db.get("SELECT COUNT(*) as count FROM tests");
    const pendingGrades = await db.get("SELECT COUNT(*) as count FROM submissions WHERE writing_score IS NULL");
    const completedGrades = await db.get("SELECT COUNT(*) as count FROM submissions WHERE writing_score IS NOT NULL");

    res.json({
      students: studentCount.count,
      tests: testCount.count,
      pendingGrades: pendingGrades.count,
      completedGrades: completedGrades.count
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all users
// A teacher sees only their own students here -- not other teachers, not
// admin, not another school's roster.
app.get('/api/admin/users', requireRole('teacher', 'admin'), async (req, res) => {
  try {
    const scoped = req.authUser.role === 'admin' ? '' : "WHERE role = 'student' AND owner_teacher_id = ?";
    const params = req.authUser.role === 'admin' ? [] : [req.authUser.id];
    // Postgres folds unquoted identifiers to lowercase, including aliases --
    // group_name as groupName silently comes back as `groupname` there (SQLite
    // doesn't do this, which is why it wasn't caught locally). Quoted to keep
    // the exact casing the client reads.
    const users = await db.all(`SELECT id, name, role, group_name as "groupName", owner_teacher_id as "ownerTeacherId" FROM users ${scoped}`, params);
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reset user password
app.post('/api/admin/users/reset-password', requireRole('teacher', 'admin'), async (req, res) => {
  const { userId, newPassword } = req.body;
  if (req.authUser.role === 'teacher' && !(await canAccessStudent(req.authUser, userId))) {
    return res.status(403).json({ error: 'Teachers can only reset their own students’ passwords' });
  }
  try {
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(newPassword), userId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add user
// A teacher may create their own students -- that's the entire point of
// self-service onboarding -- but never a teacher or admin account (that
// stays admin-only, since it's how a new school gets created in the first
// place) and never a student owned by anyone but themselves, no matter what
// ownerTeacherId the request claims.
app.post('/api/admin/users', requireRole('teacher', 'admin'), async (req, res) => {
  const { id, name, role, password, groupName, ownerTeacherId } = req.body;
  if (req.authUser.role === 'teacher' && role !== 'student') {
    return res.status(403).json({ error: 'Teachers can only create student accounts' });
  }
  try {
    const hashedPassword = await hashPassword(password || 'student123');
    // A student left without an owner is invisible to every teacher's
    // dashboard, so unassigned students default to the account actually
    // running the class rather than silently falling through the cracks.
    // Teacher/admin rows stay unowned -- they're tenant roots, not tenants.
    const owner = role === 'student'
      ? (req.authUser.role === 'teacher' ? req.authUser.id : (ownerTeacherId || 'mrGreen'))
      : null;
    await db.run('INSERT INTO users (id, name, password_hash, role, group_name, owner_teacher_id) VALUES (?, ?, ?, ?, ?, ?)', [id, name, hashedPassword, role, groupName || null, owner]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'User ID already exists or invalid data' });
  }
});

// Delete user
// Rename a user. Names are shown to students on every result and report, and
// until now the only way to change one was to delete the account and recreate
// it -- which for a teacher or admin would take their grading history with it.
// Change the ID someone signs in with.
//
// The ID is the users table's primary key and six other columns point at it, so
// it cannot simply be updated in place. The row is copied under the new ID,
// every reference is repointed, then the old row is removed -- in that order, so
// nothing is ever orphaned. Done inside a transaction where the driver supports
// one, so a failure halfway leaves the account exactly as it was.
app.post('/api/admin/users/:id/change-id', requireRole('admin'), async (req, res) => {
  const oldId = String(req.params.id || '').trim();
  const newId = String(req.body.newId || '').trim();

  if (!newId) return res.status(400).json({ error: 'newId is required' });
  if (!/^[A-Za-z0-9._-]{2,40}$/.test(newId)) {
    return res.status(400).json({ error: 'newId may use letters, numbers, dot, underscore or hyphen (2-40 characters)' });
  }
  if (newId.toLowerCase() === oldId.toLowerCase()) {
    return res.status(400).json({ error: 'newId is the same as the current ID' });
  }

  // Sign-in matches case-insensitively, so two IDs differing only in case would
  // be indistinguishable at the login screen.
  const clash = await db.get('SELECT id FROM users WHERE LOWER(TRIM(id)) = ?', [newId.toLowerCase()]);
  if (clash) return res.status(409).json({ error: `"${clash.id}" already exists` });

  const user = await db.get('SELECT * FROM users WHERE id = ?', [oldId]);
  if (!user) return res.status(404).json({ error: `User ${oldId} not found` });

  const REFERENCES = [
    ['tests', 'created_by'],
    ['assignments', 'student_id'],
    ['submissions', 'student_id'],
    ['submissions', 'graded_by'],
    ['speaking_assignments', 'student_id'],
    ['speaking_submissions', 'student_id'],
    // Added for multi-school support: a student's owner_teacher_id must
    // follow if the owning teacher's own id changes, or their whole school
    // silently detaches from them. sessions.user_id must follow too, or the
    // DELETE below fails its foreign key exactly like deleting a user with
    // an active session does.
    ['users', 'owner_teacher_id'],
    ['sessions', 'user_id']
  ];

  let inTransaction = false;
  try {
    try { await db.exec('BEGIN'); inTransaction = true; } catch { /* driver without transactions */ }

    await db.run(
      'INSERT INTO users (id, name, password_hash, role, group_name) VALUES (?, ?, ?, ?, ?)',
      [newId, user.name, user.password_hash, user.role, user.group_name || null]
    );

    const moved = {};
    for (const [table, column] of REFERENCES) {
      try {
        const result = await db.run(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`, [newId, oldId]);
        if (result.changes) moved[`${table}.${column}`] = result.changes;
      } catch { /* table absent on this installation */ }
    }

    await db.run('DELETE FROM users WHERE id = ?', [oldId]);
    if (inTransaction) await db.exec('COMMIT');

    console.log(`User ID changed: ${oldId} -> ${newId}`, moved);
    res.json({ success: true, previousId: oldId, id: newId, name: user.name, role: user.role, movedReferences: moved });
  } catch (error) {
    if (inTransaction) { try { await db.exec('ROLLBACK'); } catch { /* nothing to undo */ } }
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/users/:id/name', requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (name.length > 120) return res.status(400).json({ error: 'name is too long' });
  try {
    const user = await db.get('SELECT id, name, role FROM users WHERE id = ?', [id]);
    if (!user) return res.status(404).json({ error: `User ${id} not found` });
    await db.run('UPDATE users SET name = ? WHERE id = ?', [name, id]);
    res.json({ success: true, id, previous: user.name, name, role: user.role });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/admin/users/:id', requireRole('teacher', 'admin'), async (req, res) => {
  const { id } = req.params;
  try {
    if (id === 'admin') {
      return res.status(400).json({ error: 'Cannot delete primary administrator account' });
    }
    if (req.authUser.role === 'teacher' && !(await canAccessStudent(req.authUser, id))) {
      return res.status(403).json({ error: 'Teachers can only remove their own students' });
    }
    // A logged-in user's session row references them, so deleting the user
    // while their session still exists fails the foreign key. Sessions are
    // disposable -- clear theirs first, same as a logout.
    await db.run('DELETE FROM sessions WHERE user_id = ?', [id]);
    await db.run('DELETE FROM users WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Moves every student owned by one teacher to another. Exists to correct the
// multi-school migration's first run, which defaulted every pre-existing
// student to a leftover seed account ('teacher') instead of the account
// actually running the class -- not a bulk classroom-transfer feature, so it
// is deliberately blunt (whole roster, no partial selection) rather than
// something built out for routine use.
app.post('/api/admin/users/reassign-owner', requireRole('admin'), async (req, res) => {
  const { fromTeacherId, toTeacherId } = req.body;
  if (!fromTeacherId || !toTeacherId) {
    return res.status(400).json({ error: 'fromTeacherId and toTeacherId are required' });
  }
  try {
    const toUser = await db.get(`SELECT id, role FROM users WHERE id = ?`, [toTeacherId]);
    if (!toUser || toUser.role !== 'teacher') {
      return res.status(400).json({ error: `${toTeacherId} is not a teacher account` });
    }
    const result = await db.run(
      `UPDATE users SET owner_teacher_id = ? WHERE role = 'student' AND owner_teacher_id = ?`,
      [toTeacherId, fromTeacherId]
    );
    res.json({ success: true, moved: result.changes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get tests list. Read-only and unscoped even for teachers -- the test
// library is the one thing every school shares, so there's nothing to wall
// off here; a teacher needs the full catalog to know what they can assign.
app.get('/api/admin/tests', requireRole('teacher', 'admin'), async (req, res) => {
  try {
    const tests = await db.all('SELECT id, title, created_by FROM tests');
    res.json(tests);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Force sync IELTS Hard Prediction Mock Test 10 -- but only writing_data when
// the test already exists. Real incident: this endpoint used to overwrite
// listening_data/reading_data too, straight from this static JSON snapshot.
// The test was later rebuilt to point Listening/Reading at proper iframe
// modules (via /link-modules), but this snapshot file was never updated to
// match -- so calling this on an already-rebuilt test silently reverted it
// back to old broken native-format data, reproducing the exact
// "Cannot read properties of undefined (reading 'map')" crash that rebuild
// was meant to fix. listening_data/reading_data are only ever used here for
// the one-time bootstrap insert, when there's nothing else to regress.
app.all('/api/admin/sync-mock10', requireRole('admin'), async (req, res) => {
  try {
    const jsonPath = path.join(__dirname, 'data', 'mocks', 'mock10.json');
    if (!fs.existsSync(jsonPath)) {
      return res.status(404).json({ error: 'mock10.json file not found' });
    }
    const mockData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

    const existing = await db.get("SELECT id FROM tests WHERE title LIKE '%Hard Prediction Mock Test 10%' LIMIT 1");
    if (existing) {
      await db.run(
        `UPDATE tests SET writing_data = ? WHERE id = ?`,
        [JSON.stringify(mockData.writing_data), existing.id]
      );
      return res.json({ success: true, message: `Updated writing_data for IELTS Hard Prediction Mock Test 10 (ID: ${existing.id}). Listening/Reading were left untouched.` });
    }

    const result = await db.run(
      `INSERT INTO tests (title, listening_data, reading_data, writing_data, created_by) VALUES (?, ?, ?, ?, ?)`,
      [mockData.title || 'IELTS Hard Prediction Mock Test 10', JSON.stringify(mockData.listening_data), JSON.stringify(mockData.reading_data), JSON.stringify(mockData.writing_data), 'admin']
    );

    res.json({ success: true, message: `Successfully inserted IELTS Hard Prediction Mock Test 10 (ID: ${result.lastID}).` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create Test
app.post('/api/admin/tests', requireRole('admin'), async (req, res) => {
  const { title, listeningData, readingData, writingData, createdBy } = req.body;
  try {
    await db.run(`
      INSERT INTO tests (title, listening_data, reading_data, writing_data, created_by)
      VALUES (?, ?, ?, ?, ?)
    `, [title, JSON.stringify(listeningData), JSON.stringify(readingData), JSON.stringify(writingData), createdBy || 'admin']);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Dynamic Admin HTML test uploader with Telegram sanitization and auto-login injection
app.post('/api/admin/upload-test', requireRole('admin'), async (req, res) => {
  const { title, htmlContent } = req.body;
  const moduleType = req.body.moduleType === 'reading' ? 'reading' : 'listening';
  // Optional: reprocess an already-uploaded test's HTML in place (e.g. after fixing
  // the sanitizer/injection logic) instead of always creating a new test row.
  const existingTestId = Number.parseInt(req.body.existingTestId, 10);
  if (!title || !htmlContent) {
    return res.status(400).json({ error: 'Title and htmlContent are required' });
  }
  try {
    let testId;
    if (Number.isInteger(existingTestId) && existingTestId > 0) {
      const existing = await db.get('SELECT id FROM tests WHERE id = ?', [existingTestId]);
      if (!existing) return res.status(404).json({ error: `Test ${existingTestId} not found` });
      testId = existingTestId;
    } else {
      // 1. Insert into tests table to get the next ID
      const result = await db.run(`
        INSERT INTO tests (title, listening_data, reading_data, writing_data, created_by)
        VALUES (?, ?, ?, ?, ?)
      `, [title, '{}', '{}', '{}', 'admin']);
      testId = result.lastID;
    }

    const fileName = `mock${testId}.html`;
    const testsDir = path.join(__dirname, 'public', 'tests');
    
    // Ensure public/tests directory exists
    if (!fs.existsSync(testsDir)) {
      fs.mkdirSync(testsDir, { recursive: true });
    }
    
    const filePath = path.join(testsDir, fileName);
    
    // 2. Process and clean the HTML content
    let content = htmlContent;

    // Re-uploading an already-processed file has to be safe: the served
    // /tests/mockN.html is sometimes the only surviving copy of a test, so
    // fixing a bug in the bridge below means feeding that served file back
    // through here. Without this, the old bridge stays and a second one is
    // stacked on top -- two submit handlers, two postMessages, and scoring
    // that silently depends on which one wins. Drop any bridge a previous
    // upload injected so this endpoint is idempotent and always yields the
    // CURRENT bridge. Done by scanning whole <script> blocks rather than with
    // a regex: a lazy pattern spanning from an earlier <script> to our marker
    // would swallow the template's own script along with it.
    const stripInjectedBridge = (html) => {
      const marker = /__recordLiveAnswer|__installHarvestBridge|__installDayFamilyBridge/;
      let out = '';
      let rest = html;
      for (;;) {
        const start = rest.indexOf('<script>');
        if (start === -1) { out += rest; break; }
        const end = rest.indexOf('</script>', start);
        if (end === -1) { out += rest; break; }
        const blockEnd = end + '</script>'.length;
        if (marker.test(rest.slice(start, blockEnd))) {
          out += rest.slice(0, start);
        } else {
          out += rest.slice(0, blockEnd);
        }
        rest = rest.slice(blockEnd);
      }
      return out;
    };
    content = stripInjectedBridge(content);

    // Listening tests commonly embed their whole audio track inline as a
    // base64 data: URI -- for a real track that alone can be 15+ MB, meaning
    // the entire page (audio included) has to finish downloading before
    // anything renders. Extract it to its own DB row and point <audio> at
    // the streaming route above instead, so the page itself loads
    // immediately and the audio streams in independently, the way a normal
    // <audio src="..."> does. Confirmed real impact: this was making
    // Listening take ~70 seconds to even appear for students.
    if (moduleType === 'listening') {
      const audioMatch = /src="data:(audio\/[a-zA-Z0-9.+-]+);base64,([^"]+)"/.exec(content);
      if (audioMatch) {
        const [fullMatch, mimeType, base64Data] = audioMatch;

        // Reprocessing an existing test replaces its page, so whatever asset the
        // old page pointed at is about to become unreachable. Noted before the
        // overwrite and dropped after the new one is safely stored.
        //
        // Without this, every reprocess left a full copy of the track behind:
        // fixing one listening file over ~18 iterations of debugging leaked
        // ~180 MB, on a database whose transfer quota has already been exhausted
        // once. The old asset is only freed if no other test still points at it.
        let supersededAssetId = null;
        if (Number.isInteger(existingTestId) && existingTestId > 0) {
          const prior = await db.get('SELECT html_content FROM tests WHERE id = ?', [testId]);
          supersededAssetId = (/\/tests-audio\/(\d+)/.exec(String(prior?.html_content || '')) || [])[1] || null;
        }

        const assetResult = await db.run(
          'INSERT INTO test_audio_assets (mime_type, data_base64) VALUES (?, ?)',
          [mimeType, base64Data]
        );
        content = content.replace(fullMatch, `src="/tests-audio/${assetResult.lastID}"`);

        if (supersededAssetId && String(supersededAssetId) !== String(assetResult.lastID)) {
          const others = await db.get(
            'SELECT COUNT(*) AS n FROM tests WHERE id <> ? AND html_content LIKE ?',
            [testId, `%/tests-audio/${supersededAssetId}"%`]
          );
          if (Number(others?.n || 0) === 0) {
            await db.run('DELETE FROM test_audio_assets WHERE id = ?', [supersededAssetId]);
            for (const suffix of ['.bin', '.bin.type']) {
              try { await fs.promises.unlink(path.join(audioCacheDir, `${supersededAssetId}${suffix}`)); } catch (e) {}
            }
            console.log(`[upload] freed superseded audio asset ${supersededAssetId}`);
          }
        }
      }
    }

    // Some papers end the whole section the moment their window loses focus:
    //
    //   startWritingStage(){ state.blurAutoSubmitEnabled = true; state.autoHandled = false; ... }
    //   window.addEventListener('blur', autoSubmitIfActive)          -> handleSubmitClick()
    //   document.addEventListener('visibilitychange', ...)           -> same
    //
    // Written for a paper opened in its own tab, where losing focus plausibly
    // means the candidate went looking for answers. On this platform the paper
    // runs inside an iframe, so blur fires for entirely innocent things: clicking
    // the platform's own UI outside the frame, a notification, alt-tab,
    // minimising, the screen locking. The first one ends the section.
    //
    // Students reported the window closing on its own mid-essay, and it explains
    // a paper scoring 6/40 on Listening beside 40/40 on Reading -- Reading is the
    // one stage this template already leaves the flag off for.
    //
    // Turned off everywhere, matching what the template itself does for Reading.
    // Exam integrity is the platform's job: it tracks focus violations already,
    // and it counts them rather than destroying the sitting over one.
    let blurSubmitsDisabled = 0;
    content = content.replace(
      /state\.blurAutoSubmitEnabled\s*=\s*true/g,
      () => { blurSubmitsDisabled++; return 'state.blurAutoSubmitEnabled=false'; }
    );
    if (blurSubmitsDisabled) {
      console.log(`[upload] disabled ${blurSubmitsDisabled} focus-loss auto-submit(s)`);
    }

    // Inject CSS override
    const cssOverride = `
    <style>
      .brand-badge, .brand, .gate-footer, .tg-circle, [title*="Telegram"], [title*="blog"], [alt*="Jasurbek"], a[href*="t.me"] {
        display: none !important;
        opacity: 0 !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }
    </style>
    </head>
    `;
    content = content.replace('</head>', cssOverride);
    
    // Replace Telegram links and personal tags
    content = content.replace(/@jasurbekisaev/gi, 'IELTS_Mock_Platform');
    content = content.replace(/Jasurbek's Blog/gi, 'IELTS Mock Test Center');
    content = content.replace(/Jasurbek's blog/gi, 'IELTS Mock Test Center');
    content = content.replace(/Jasurbek/gi, 'IELTS Mock Team');
    content = content.replace(/https:\/\/t\.me\/[a-zA-Z0-9_\+\-]+/gi, '#');
    content = content.replace(/t\.me\/[a-zA-Z0-9_\+\-]+/gi, '#');
    
    content = content.replace(/const\s+TELEGRAM_LINK\s*=\s*[^;]+;/g, 'const TELEGRAM_LINK = "";');
    content = content.replace(/const\s+TELEGRAM_NAME\s*=\s*[^;]+;/g, 'const TELEGRAM_NAME = "IELTS Mock Test Center";');
    content = content.replace(/"Full Mock Test\s*—\s*"\s*\+\s*TELEGRAM_NAME\s*\+\s*"\s*\(Telegram\):\s*"\s*\+\s*TELEGRAM_LINK/g, '"IELTS Academic Mock Test Report"');

    // Inject auto-login script
    const hasFinishWriting = content.includes('function finishWriting()') || content.includes('function finishWriting(');
    let usedHarvestBridge = false;

    if (content.includes('function finishTest')) {
      const autoLoginSnippet = `
      // Auto-login extension injected by IELTS Mock Platform
      function runAutoLogin() {
        const params = new URLSearchParams(window.location.search);
        const sId = params.get('studentId') || 'STUDENT';
        const tId = params.get('testId') || '${testId}';
        
        candidate = sId;
        const loginScreen = document.getElementById('login');
        if (loginScreen) loginScreen.classList.add('hidden');
        const introScreen = document.getElementById('intro');
        if (introScreen) introScreen.classList.remove('hidden');
        const welcomeName = document.getElementById('welcomeName');
        if (welcomeName) welcomeName.textContent = 'Candidate ID: ' + candidate;
      }
      if (document.readyState !== 'loading') {
        runAutoLogin();
      } else {
        document.addEventListener('DOMContentLoaded', runAutoLogin);
      }
      `;
      content = content.replace('</body>', `<script>${autoLoginSnippet}</script>\n</body>`);
      
      // Modify finishTest function to post data back to our Express API
      const finishTestTarget = /function finishTest\(\)\{\s*clearInterval\(timerInt\);[\s\S]*?setTimeout\(\(\)=>downloadPDF\(true\),\s*500\);\s*\}/;
      const finishTestReplacement = `function finishTest(){
        clearInterval(timerInt);
        document.getElementById('exam').classList.add('hidden');
        
        const resultCard = document.querySelector('#result .result-card');
        if (resultCard) {
          resultCard.innerHTML = \`
            <div style="text-align: center; padding: 2rem 0;">
              <h2 style="color: var(--ielts-red); margin-bottom: 1rem;">Test Submitted Successfully</h2>
              <p style="color: #555; font-size: 1.1rem; line-height: 1.6; margin-bottom: 2rem;">
                Your answers have been securely submitted to your teacher.<br>
                Please wait while we redirect you back to your dashboard...
              </p>
              <div style="display: inline-block; width: 40px; height: 40px; border: 4px solid #f3f3f3; border-top: 4px solid var(--ielts-red); border-radius: 50%; animation: spin 1s linear infinite;"></div>
              <style>
                @keyframes spin {
                  0% { transform: rotate(0deg); }
                  100% { transform: rotate(360deg); }
                }
              </style>
            </div>
          \`;
        }
        document.getElementById('result').classList.remove('hidden');

        // Extract answers
        const listeningAnswers = {};
        for (let i = 1; i <= 40; i++) {
          listeningAnswers[i] = getAnswer('l' + i).join(', ');
        }
        const readingAnswers = {};
        for (let i = 1; i <= 40; i++) {
          readingAnswers[i] = getAnswer('r' + i).join(', ');
        }
        const writingAnswers = {
          task1: document.getElementById('wText1').value,
          task2: document.getElementById('wText2').value
        };

        const lScore = scoreSection('l');
        const rScore = scoreSection('r');

        // Estimate IELTS bands
        const getIeltsBand = (correct) => {
          // Official IELTS raw-score conversion. Every band below 4.5 used to
          // collapse to a flat 4.0, so a blank paper and 12/40 scored the same.
          var t = [[39,9],[37,8.5],[35,8],[32,7.5],[30,7],[26,6.5],[23,6],[18,5.5],[16,5],[13,4.5],[10,4],[6,3.5],[4,3],[0,2.5]];
          for (var i = 0; i < t.length; i++) { if (correct >= t[i][0]) return t[i][1]; }
          return 2.5;
        };

        const params = new URLSearchParams(window.location.search);
        const sId = params.get('studentId') || candidate;
        const tId = params.get('testId') || '${testId}';

        fetch('/api/student/submit/' + tId, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            studentId: sId,
            listeningAnswers,
            readingAnswers,
            writingAnswers,
            listeningScore: getIeltsBand(lScore),
            readingScore: getIeltsBand(rScore)
          })
        })
        .then(async res => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Submission was not accepted');
          return data;
        })
        .then(data => {
          console.log('Submission synced to backend successfully:', data);
          if (window.parent) {
            window.parent.postMessage({ type: 'IELTS_TEST_SUBMITTED', testId: tId }, window.location.origin);
          }
        })
        .catch(err => {
          console.error('Failed to submit to database backend:', err);
          alert('Your submission could not be confirmed. Please check your connection and try again.');
        });
        return;
      }
      `;
      content = content.replace(finishTestTarget, finishTestReplacement);
      
    } else if (hasFinishWriting) {
      const autoLoginSnippetB = `
      // Auto-login extension injected by IELTS Mock Platform
      window.addEventListener('DOMContentLoaded', () => {
        const params = new URLSearchParams(window.location.search);
        const sId = params.get('studentId');
        const tId = params.get('testId') || '${testId}';
        
        if (sId) {
          state.takerId = sId;
          const pwdScreen = document.getElementById("screen-password");
          const idScreen = document.getElementById("screen-id");
          if (pwdScreen) pwdScreen.classList.add("hidden");
          if (idScreen) idScreen.classList.add("hidden");
          
          const takerDisplay = document.getElementById("taker-id-display");
          const takerDisplayT = document.getElementById("taker-id-display-t");
          const resultsTaker = document.getElementById("results-taker-id");
          if (takerDisplay) takerDisplay.textContent = sId;
          if (takerDisplayT) takerDisplayT.textContent = sId;
          if (resultsTaker) resultsTaker.textContent = sId;
          
          const testScreen = document.getElementById("screen-test");
          if (testScreen) testScreen.classList.remove("hidden");
          startListeningStage();
        }
      });
      `;
      content = content.replace(/\}\)\(\);\s*<\/script>/, `${autoLoginSnippetB}\n})();\n</script>`);
      // Accepts either quote style and an optional final semicolon. Generations of
      // this template differ on both, and the double-quote-only version of this
      // pattern silently matched nothing on a single-quoted file: the replacement
      // below never ran, so the uploaded test kept its own local results screen,
      // showed the student their full score, and posted nothing to the platform.
      // A whole sitting would have been lost with no error anywhere.
      const finishWritingTarget = /function finishWriting\(\)\s*\{\s*clearInterval\(state\.wTimerInterval\);\s*hide\(\$\(['"]screen-test['"]\)\);\s*hide\(\$\(['"]screen-transition['"]\)\);\s*buildFinalReport\(\);\s*show\(\$\(['"]screen-results['"]\)\);?\s*\}/;
      const finishWritingReplacement = `function finishWriting(){
        clearInterval(state.wTimerInterval);
        hide($("screen-test")); hide($("screen-transition"));
        
        const resultsScreen = $("screen-results");
        if (resultsScreen) {
          resultsScreen.innerHTML = \`
            <div style="max-width: 600px; margin: 4rem auto; background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 3rem; text-align: center; box-shadow: 0 4px 12px rgba(0,0,0,0.1); font-family: Arial, sans-serif;">
              <h2 style="color: #c8102e; margin-bottom: 1.5rem; font-size: 24px; font-weight: bold;">Test Submitted Successfully</h2>
              <p style="color: #555; font-size: 16px; line-height: 1.6; margin-bottom: 2rem;">
                Your answers have been securely submitted to your teacher.<br>
                Please wait while we redirect you back to your dashboard...
              </p>
              <div style="display: inline-block; width: 40px; height: 40px; border: 4px solid #f3f3f3; border-top: 4px solid #c8102e; border-radius: 50%; animation: spin 1s linear infinite;"></div>
              <style>
                @keyframes spin {
                  0% { transform: rotate(0deg); }
                  100% { transform: rotate(360deg); }
                }
              </style>
            </div>
          \`;
          show(resultsScreen);
        }

        const params = new URLSearchParams(window.location.search);
        const sId = params.get('studentId') || state.takerId || 'STUDENT';
        const tId = params.get('testId') || '${testId}';

        const listeningAnswers = {};
        for (let i = 1; i <= 40; i++) {
          listeningAnswers[i] = state.lAnswers[i] || "";
        }
        const readingAnswers = {};
        for (let i = 1; i <= 40; i++) {
          readingAnswers[i] = state.rAnswers[i] || "";
        }
        const writingAnswers = {
          task1: state.wAnswers[1] || "",
          task2: state.wAnswers[2] || ""
        };

        const lRes = buildReviewRows(state.lAnswers, listeningAnswerKey);
        const rRes = buildReviewRows(state.rAnswers, readingAnswerKey);

        // Estimate IELTS bands
        const getIeltsBand = (correct) => {
          // Official IELTS raw-score conversion. Every band below 4.5 used to
          // collapse to a flat 4.0, so a blank paper and 12/40 scored the same.
          var t = [[39,9],[37,8.5],[35,8],[32,7.5],[30,7],[26,6.5],[23,6],[18,5.5],[16,5],[13,4.5],[10,4],[6,3.5],[4,3],[0,2.5]];
          for (var i = 0; i < t.length; i++) { if (correct >= t[i][0]) return t[i][1]; }
          return 2.5;
        };

        // Per-question detail, which is what the teacher's and student's review
        // screens render. The submit endpoint has always accepted
        // listeningDetail/readingDetail; this template family simply never sent
        // them, so its papers reviewed as bare right/wrong with no correct answer
        // and no reasoning.
        //
        // Explanations are picked up from the file when it defines them, so a
        // paper without them still submits exactly as before.
        const __evidenceHtml = function (e) {
          if (!e) return null;
          var esc = typeof escapeHtml === 'function' ? escapeHtml : function (s) { return String(s); };
          var out = '<div class="__evidence">';
          if (e.where) out += '<p><strong>Where it is answered:</strong> ' + esc(e.where) + '</p>';
          if (e.quote) out += '<blockquote style="margin:6px 0;padding-left:10px;border-left:3px solid #bbb"><em>' + esc(e.quote) + '</em></blockquote>';
          if (e.why) out += '<p>' + esc(e.why) + '</p>';
          return out + '</div>';
        };
        const __buildDetail = function (answers, key, section, expl) {
          var d = {};
          for (var i = 1; i <= 40; i++) {
            var ok = false, corr = '';
            try { ok = !!isAnswerCorrect(answers, key, section, i); } catch (err) {}
            try { corr = displayCorrectAnswer(key, section, i); } catch (err) {}
            var given = '';
            try { given = answerDisplay(answers[i]) || ''; } catch (err) { given = answers[i] || ''; }
            d[i] = { userAnswer: given, correctAnswer: corr, isCorrect: ok };
            var html = expl ? __evidenceHtml(expl[i]) : null;
            if (html) d[i].explanationHtml = html;
          }
          return d;
        };
        const listeningDetail = __buildDetail(
          state.lAnswers, listeningAnswerKey, 'listening',
          typeof LISTENING_EXPLANATIONS !== 'undefined' ? LISTENING_EXPLANATIONS : null
        );
        const readingDetail = __buildDetail(
          state.rAnswers, readingAnswerKey, 'reading',
          typeof READING_EXPLANATIONS !== 'undefined' ? READING_EXPLANATIONS : null
        );

        fetch('/api/student/submit/' + tId, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            studentId: sId,
            listeningAnswers,
            readingAnswers,
            writingAnswers,
            listeningDetail,
            readingDetail,
            listeningScore: getIeltsBand(lRes.correctCount),
            readingScore: getIeltsBand(rRes.correctCount)
          })
        })
        .then(async res => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Submission was not accepted');
          return data;
        })
        .then(data => {
          console.log('Submission synced to backend successfully:', data);
          if (window.parent) {
            window.parent.postMessage({ type: 'IELTS_TEST_SUBMITTED', testId: tId }, window.location.origin);
          }
        })
        .catch(err => {
          console.error('Failed to submit to database backend:', err);
          alert('Your submission could not be confirmed. Please check your connection and try again.');
        });
        return;
      }
      `;
      const beforeFinishWriting = content;
      content = content.replace(finishWritingTarget, finishWritingReplacement);

      // Refuse rather than ship a test that cannot submit.
      //
      // This whole branch exists to redirect the template's own local results
      // screen into a POST to the platform. If the pattern misses, the upload
      // "succeeds", the paper looks perfect, and the only symptom appears after a
      // class has sat it: every student saw their own score, and the teacher
      // received nothing. That is the most expensive possible way to find a typo
      // in a regex, so it fails loudly here instead.
      if (content === beforeFinishWriting) {
        const snippet = (beforeFinishWriting.match(/function finishWriting[\s\S]{0,200}/) || ['(finishWriting not found at all)'])[0];
        return res.status(422).json({
          error: 'This file has finishWriting() but not in a shape the platform can rewire, so it would '
            + 'show students their own scores and submit nothing. Refusing the upload rather than losing a sitting. '
            + 'The submission rewrite in server.js needs to cover this variant.',
          foundInstead: snippet.replace(/\s+/g, ' ').slice(0, 200)
        });
      }
    } else if (
      content.includes('function checkAnswers(')
      && content.includes('correctAnswers')
    ) {
      // "Prediction" template family (New listening/reading predictions folders): a
      // self-scoring client-side quiz with no backend submission of its own, and one
      // that reveals correct/incorrect marks and a results view the moment the student
      // checks their answers. Full mock tests must never show scores until the teacher
      // releases them, so the original "Check Answers" button is completely replaced
      // (not just wrapped) with a silent harvester that never runs the original
      // checkAnswers() reveal logic at all. Different generations of this template use
      // different button ids and reveal-function names (checkBtn/showResultsModal vs.
      // checkAnswersBtn/openResultModal), so this locates the button generically
      // (by id candidates, falling back to matching its label) instead of assuming one
      // fixed id, and never needs to know the reveal function's name at all -- it just
      // never lets the button's original click handler run.
      //
      // Some generations wrap their entire script in a
      // document.addEventListener('DOMContentLoaded', () => { ... }) closure, which
      // makes correctAnswers (and everything else) lexically invisible to this
      // separately-appended bridge script no matter where it's placed -- this is a
      // hard JS scoping wall, not something the bridge's own code can work around.
      // Whichever button ends up bound to checkAnswers is only ever bound once
      // correctAnswers already exists in that same scope, so that's a safe, generic
      // point to expose it onto window for the bridge to read afterward. A no-op
      // wherever correctAnswers was already a bare global (most generations).
      content = content.replace(
        /(\w+)\.addEventListener\(\s*['"]click['"]\s*,\s*checkAnswers\s*\)\s*;/,
        (match) => `${match}\ntry { if (typeof correctAnswers !== 'undefined') window.correctAnswers = correctAnswers; } catch (e) {}`
      );
      usedHarvestBridge = true;

      // The bridge takes over the Check Answers *button*, but the template also
      // calls checkAnswers() straight from its countdown: on expiry it reveals
      // every correct answer, the results modal, and unlocks the transcript.
      // That call is inside the timer closure, so nothing the bridge does at
      // runtime can intercept it -- window.checkAnswers is a different binding.
      //
      // A 30-minute countdown running out during a 30-minute listening paper is
      // ordinary use, not an edge case, so this is a reliable way for a student
      // to be handed the answer key mid-exam.
      //
      // Rewritten here, in the source text, where scoping does not apply: route
      // the expiry through the button instead of the function. On the platform
      // the bridge owns that button, so expiry becomes a silent submit; opened
      // standalone with no bridge, the fallback keeps the original reveal, which
      // is the right behaviour for self-study.
      let timerRevealsFixed = 0;
      content = content.replace(
        /if\s*\(\s*!\s*checked\s*\)\s*checkAnswers\s*\(\s*\)\s*;/g,
        () => {
          timerRevealsFixed++;
          return "if(!checked){ var __cb=document.getElementById('checkBtn')||document.getElementById('checkAnswersBtn'); "
            + "if(__cb){ __cb.click(); } else { checkAnswers(); } }";
        }
      );
      if (timerRevealsFixed) {
        console.log(`[upload] routed ${timerRevealsFixed} timer-expiry answer reveal(s) through the submit button`);
      }

      // The promotion above only fires on templates that bind checkAnswers in
      // that one exact way. Whole generations don't, and on those the key stays
      // sealed in a closure: the bridge finds no correctAnswers, harvests
      // nothing, and every paper scores the floor band while looking like a
      // normal submission. Two listening files failed exactly that way.
      //
      // So take the key out of the file's text here, where scoping is irrelevant
      // -- the bridge falls back to this copy when the global is absent. Embedded
      // verbatim rather than re-serialized: it is already a JS object literal and
      // may use forms JSON does not accept. Skipped if it contains anything that
      // would break out of the template literal it lands in.
      let embeddedCorrectAnswers = 'null';
      try {
        const at = content.search(/correctAnswers\s*=\s*\{/);
        if (at !== -1) {
          // Walk the braces rather than regex to the first "}". A non-greedy
          // match stops inside the first nested value -- a key like
          // '3': ['4.30','4:30'] ended the match mid-array -- and the truncated
          // literal broke the whole injected script, taking every one of the
          // template's own functions down with it: no section switching, no
          // start handler, no scoring.
          const open = content.indexOf('{', at);
          let depth = 0, end = -1, quote = null;
          for (let i = open; i < content.length; i++) {
            const ch = content[i];
            if (quote) {
              if (ch === '\\') i++;
              else if (ch === quote) quote = null;
              continue;
            }
            if (ch === '"' || ch === "'") { quote = ch; continue; }
            if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
          }
          const literal = end !== -1 ? content.slice(open, end + 1) : null;
          if (literal && literal.length < 200000 && !literal.includes('`') && !literal.includes('${')) {
            // Compile it before shipping it. new Function checks the syntax
            // without running the code, so a bad extraction is dropped here
            // instead of breaking the page it lands in.
            new Function('return ' + literal);
            embeddedCorrectAnswers = literal;
          }
        }
      } catch (e) {
        embeddedCorrectAnswers = 'null';   // unusable extraction -- the global path still works
      }

      const harvestBridgeSnippet = `
      (function() {
        var params = new URLSearchParams(window.location.search);
        var __bridgeTestId = params.get('testId') || '${testId}';
        var __bridgeModuleType = params.get('moduleType') || '${moduleType}';
        // correctAnswers may be a bare global (most generations), or invisible to
        // this script entirely because it's closure-scoped inside the template's
        // own DOMContentLoaded handler -- in which case it was exposed onto window
        // right where the original check button gets bound (see above). That
        // exposure only happens once the template's own DOMContentLoaded handler
        // actually runs, which can easily be after this bridge script's own
        // top-level code executes -- so this must be looked up fresh at the point
        // of use (when the student finishes the section), never cached early.
        var __embeddedCorrectAnswers = ${embeddedCorrectAnswers};
        function __getCorrectAnswers() {
          var live = (typeof correctAnswers !== 'undefined') ? correctAnswers : window.correctAnswers;
          if (live && typeof live === 'object') return live;
          // Closure-scoped key: use the copy lifted out of the file at upload.
          return __embeddedCorrectAnswers;
        }

        // Some template generations keep only ONE part/section's questions in the
        // DOM at a time, completely replacing that container's HTML (with fresh,
        // blank inputs -- no restoration of what was already answered) every time
        // the student switches parts. That means by the time the student reaches
        // the last part and finishes, every earlier part's answers are already
        // gone from the DOM -- not hidden, genuinely destroyed -- and nothing
        // (harvesting via getUserAnswer, or the template's own checkAnswers(),
        // which reads the exact same live DOM) can recover them after the fact.
        // A real incident: a student's Reading answers for two whole parts were
        // silently dropped this way, and she had no way to know until after
        // submitting. Track every answer AS the student enters it, via a
        // delegated listener on the document itself (never replaced, unlike the
        // question elements), so nothing depends on which part happens to be
        // currently rendered when this section is completed.
        var __liveAnswers = {};
        function __recordLiveAnswer(el) {
          try {
            if (!el || !el.name && !el.id) return;
            var match = /^q(\\d+)$/.exec(el.name || '') || /^q(\\d+)$/.exec(el.id || '');
            if (!match) return;
            var n = Number(match[1]);
            if (!n) return;
            if (el.type === 'radio' || el.type === 'checkbox') {
              if (el.checked) __liveAnswers[n] = el.value;
            } else if ('value' in el) {
              __liveAnswers[n] = el.value;
            }
          } catch (e) {}
        }
        document.addEventListener('input', function(e) { __recordLiveAnswer(e.target); }, true);
        document.addEventListener('change', function(e) { __recordLiveAnswer(e.target); }, true);

        // Tracking answers internally (above) keeps the eventual submission
        // correct, but a student (or anyone checking on them) who navigates
        // back to an earlier part reasonably expects to SEE their own answer
        // there, not just trust it's silently remembered -- otherwise it
        // still looks exactly like the original bug even once submissions are
        // fixed. Whenever this template regenerates a part's fresh, blank
        // inputs, re-fill them from what's already tracked. Setting
        // .value/.checked here doesn't itself trigger another childList
        // mutation, so this can't loop with the observer that calls it.
        function __restoreLiveAnswersIntoDom() {
          try {
            Object.keys(__liveAnswers).forEach(function (nStr) {
              var n = Number(nStr);
              var value = __liveAnswers[n];
              var el = document.getElementById('q' + n);
              if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT') && el.type !== 'radio' && el.type !== 'checkbox') {
                if (el.value !== value) el.value = value;
                return;
              }
              var radios = document.querySelectorAll('input[name="q' + n + '"]');
              radios.forEach(function (r) {
                var shouldBeChecked = r.value === value;
                if (r.checked !== shouldBeChecked) r.checked = shouldBeChecked;
              });
            });
          } catch (e) {}
        }
        new MutationObserver(function () { __restoreLiveAnswersIntoDom(); })
          .observe(document.body, { childList: true, subtree: true });

        // The footer question navigator only ever renders the CURRENT part's
        // numbers (buildSubNav clears it and redraws just partRange[p]), so a
        // student on Part 2 sees 14-26 and has no way to see or reach 1-13 from
        // there -- it looks like the earlier questions vanished. Teacher asked
        // for every question to be listed so candidates can start from whichever
        // passage they like. The template's own goToQuestion() already switches
        // part when the target is elsewhere, so the missing piece is purely the
        // buttons. Rather than replace buildSubNav (a script-scoped function this
        // separately-injected script cannot rebind), let it draw its part as
        // usual and fill in the rest around it: the current part's buttons keep
        // the template's exact state classes (answered/active/correct/incorrect),
        // and appendChild reorders everything into 1..N.
        var __navFilling = false;
        // Three reading template generations exist, each with its own container
        // id, number attribute and click entry point ('sub-questions'/data-qnum/
        // goToQuestion, 'qNavWrap'/data-q/goToQuestion, 'questionRow'/data-q/
        // scrollToQuestion). They agree on the .subQuestion class, so the nav is
        // located by that rather than by hardcoding one generation's markup.
        function __findQuestionNav() {
          var first = document.querySelector('.subQuestion');
          if (first && first.parentElement) return first.parentElement;
          var ids = ['sub-questions', 'qNavWrap', 'questionRow'];
          for (var i = 0; i < ids.length; i++) {
            var el = document.getElementById(ids[i]);
            if (el) return el;
          }
          return null;
        }
        function __navNumberOf(btn) {
          var v = btn.getAttribute('data-qnum');
          if (v === null) v = btn.getAttribute('data-q');
          return v === null ? null : String(v);
        }
        // Purely read-only: no template calls, no caching, no side effects --
        // this only decides whether a navigator button looks "answered".
        function __navHasAnswer(n) {
          try {
            if (Object.prototype.hasOwnProperty.call(__liveAnswers, n) && __liveAnswers[n]) return true;
            var el = document.getElementById('q' + n);
            if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT') && String(el.value || '').trim()) return true;
            if (document.querySelector('input[name="q' + n + '"]:checked')) return true;
            var slot = document.querySelector('.dnd-slot[data-q="' + n + '"]');
            if (slot && slot.dataset && slot.dataset.value) return true;
            var ldmSlot = document.querySelector('.ldm-slot[data-question="' + n + '"]');
            if (ldmSlot && ldmSlot.dataset && ldmSlot.dataset.answer) return true;
            // Shared "choose two letters" groups (q20_21 and friends): any tick
            // in a group this question belongs to counts as answered.
            var groups = document.querySelectorAll('input[type="checkbox"][name^="q"][name*="_"]:checked');
            for (var g = 0; g < groups.length; g++) {
              var parts = String(groups[g].name).slice(1).split('_');
              for (var p = 0; p < parts.length; p++) {
                if (Number(parts[p]) === n) return true;
              }
            }
          } catch (e) {}
          return false;
        }
        function __goToQuestionAnyTemplate(q) {
          // Every generation's own handler already switches part when the target
          // is in another passage, so reuse it rather than reimplementing it.
          if (typeof window.goToQuestion === 'function') return window.goToQuestion(q);
          if (typeof window.scrollToQuestion === 'function') return window.scrollToQuestion(q);
        }
        function __fillFullQuestionNav() {
          var container = __findQuestionNav();
          if (!container) return;
          var drawn = container.querySelectorAll('.subQuestion');
          if (!drawn.length) return;

          var existing = {};
          for (var d = 0; d < drawn.length; d++) {
            var key = __navNumberOf(drawn[d]);
            if (key !== null) existing[key] = drawn[d];
          }

          var minQ = Infinity;
          var maxQ = 0;
          try {
            var ranges = window.partRanges || window.parts || null;
            if (ranges) {
              for (var k in ranges) {
                if (!Object.prototype.hasOwnProperty.call(ranges, k)) continue;
                var r = ranges[k];
                var s = Array.isArray(r) ? r[0] : r.start;
                var e2 = Array.isArray(r) ? r[1] : r.end;
                if (s) minQ = Math.min(minQ, Number(s));
                if (e2) maxQ = Math.max(maxQ, Number(e2));
              }
            }
          } catch (e) {}
          if (!isFinite(minQ) || !maxQ) { minQ = 1; maxQ = 40; }

          // Clone one of the template's own buttons so the added ones are
          // identical in markup, classes and styling to the ones it draws --
          // rather than guessing at each generation's inner structure.
          var model = drawn[0];
          var frag = document.createDocumentFragment();
          for (var n = minQ; n <= maxQ; n++) {
            var btn = existing[String(n)];
            if (!btn) {
              btn = model.cloneNode(true);
              btn.className = 'subQuestion';
              btn.removeAttribute('disabled');
              if (model.hasAttribute('data-qnum')) btn.setAttribute('data-qnum', n);
              if (model.hasAttribute('data-q')) btn.setAttribute('data-q', n);
              if (!model.hasAttribute('data-qnum') && !model.hasAttribute('data-q')) btn.setAttribute('data-q', n);
              var span = btn.querySelector('span');
              if (span) span.textContent = String(n); else btn.textContent = String(n);
              btn.addEventListener('click', (function (q) {
                return function () { __goToQuestionAnyTemplate(q); };
              })(n));
              // Answered styling is probed WITHOUT going through __harvestAnswer:
              // that path falls through to the checkbox-group scorer, whose
              // result is cached, so merely drawing the navigator would freeze a
              // pair's verdict as "nothing ticked" for the rest of the session.
              // A read-only DOM check keeps this display concern from touching
              // scoring state at all.
              try { if (__navHasAnswer(n)) btn.classList.add('answered'); } catch (e) {}
            }
            frag.appendChild(btn);
          }
          __navFilling = true;
          try { container.appendChild(frag); } finally {
            setTimeout(function () { __navFilling = false; }, 0);
          }
        }

        function __installFullQuestionNav() {
          var container = __findQuestionNav();
          if (!container) {
            // The nav may not exist yet on first paint; watch for it once.
            var bodyObserver = new MutationObserver(function () {
              if (__findQuestionNav()) { bodyObserver.disconnect(); __installFullQuestionNav(); }
            });
            bodyObserver.observe(document.body, { childList: true, subtree: true });
            return;
          }
          new MutationObserver(function () {
            if (__navFilling) return;
            __fillFullQuestionNav();
          }).observe(container, { childList: true });
          __fillFullQuestionNav();
        }

        if (document.readyState !== 'loading') __installFullQuestionNav();
        else document.addEventListener('DOMContentLoaded', __installFullQuestionNav);

        // "Choose N answers" checkbox questions (e.g. Q20/21 sharing one
        // checkbox group named "q20_21") are scored by how many of the
        // student's checked boxes are in the correct set, not by matching one
        // box to one question -- the Nth question in the group is correct once
        // at least N of the checked boxes are right (mirrors this template
        // family's own checkAnswers() logic for this question type exactly).
        // Computed once per group and cached, since both answer harvesting and
        // correctness checking need the same result for the same question.
        var __groupCreditCache = {};
        function __checkboxGroupCredit(n, fallbackAnswer) {
          // The cached result is reused except when it was computed from an empty
          // live DOM and a harvested value is now available -- the student may have
          // navigated away from this part and had its boxes rebuilt out from under
          // us, which is exactly the data-loss case __liveAnswers exists to cover.
          if (Object.prototype.hasOwnProperty.call(__groupCreditCache, n)
            && !(fallbackAnswer && __groupCreditCache[n] && !__groupCreditCache[n].userAnswer)) {
            return __groupCreditCache[n];
          }
          var result = null;
          try {
            var groupNames = Array.from(document.querySelectorAll('input[type="checkbox"][name^="q"][name*="_"]'))
              .reduce(function (names, el) { if (names.indexOf(el.name) === -1) names.push(el.name); return names; }, []);
            for (var g = 0; g < groupNames.length; g++) {
              var groupName = groupNames[g];
              // The name is an inclusive RANGE, not a list: "q11_13" is the
              // "choose THREE letters" group covering questions 11, 12 and 13.
              // Reading it as just 11 and 13 dropped question 12 out of the
              // group entirely, so it could never be credited and every student
              // silently lost that mark. Consecutive names like "q20_21" mean
              // the same thing either way, which is why this only surfaced on a
              // three-question group.
              var bounds = groupName.slice(1).split('_').map(Number);
              var parts = [];
              if (bounds.length === 2 && bounds[1] > bounds[0]) {
                for (var b = bounds[0]; b <= bounds[1]; b++) parts.push(b);
              } else {
                parts = bounds;
              }
              var pos = parts.indexOf(n);
              if (pos === -1) continue;
              var checkedVals = Array.from(document.querySelectorAll('input[name="' + groupName + '"]:checked')).map(function (c) { return c.value; });
              if (!checkedVals.length && fallbackAnswer) {
                checkedVals = String(fallbackAnswer).split(',')
                  .map(function (s) { return s.trim(); })
                  .filter(Boolean);
              }
              var __ca = __getCorrectAnswers();
              // correctAnswers is keyed by question numbers, which may or may not
              // include the "q" prefix the input's own name attribute carries --
              // try both rather than assuming one convention.
              var __caGroup = (typeof __ca === 'object' && __ca) ? (__ca[groupName] || __ca[groupName.slice(1)]) : undefined;
              var correctSet = Array.isArray(__caGroup) ? __caGroup : [];
              // Other generations in this family key the SAME shared checkbox group
              // per individual question instead ("'21':'C','22':'D'" rather than
              // "'21_22':['C','D']"). Both halves of the pair then harvest the same
              // combined "C, D" string, which can never equal a single letter, so
              // without this a student who ticked exactly the right two boxes loses
              // the mark on BOTH questions. Rebuild the set from the group's own
              // question numbers whenever no group-keyed entry exists.
              if (!correctSet.length && typeof __ca === 'object' && __ca) {
                // Generations differ: some key each question in the group to its
                // own letter ("11":"C"), others repeat the whole accepted set
                // against every question in it ("11":["C","D","E"]). Flatten
                // both into one set of accepted letters, de-duplicated -- taking
                // only strings dropped the array form entirely and left the
                // group with no key at all, marking every answer wrong.
                var collected = [];
                for (var pi = 0; pi < parts.length; pi++) {
                  var value = __ca[String(parts[pi])];
                  var list = Array.isArray(value) ? value : (typeof value === 'string' && value ? [value] : []);
                  for (var li = 0; li < list.length; li++) {
                    if (collected.indexOf(list[li]) === -1) collected.push(list[li]);
                  }
                }
                correctSet = collected;
              }
              var matchCount = checkedVals.filter(function (v) { return correctSet.indexOf(v) !== -1; }).length;
              result = {
                userAnswer: checkedVals.join(', '),
                correctAnswer: correctSet[pos] !== undefined ? correctSet[pos] : correctSet.join(' / '),
                isCorrect: matchCount >= (pos + 1)
              };
              break;
            }
          } catch (e) {}
          __groupCreditCache[n] = result;
          return result;
        }

        function __harvestAnswer(n) {
          // Checked first, and preferred over everything below: the template's own
          // getUserAnswer/getQuestionAnswer (and every DOM query after it) all read
          // whatever's currently in the live DOM, which is exactly what's unreliable
          // for a part the student has since navigated away from. The live-tracked
          // value is only missing for a question that was never interacted with via
          // a plain input/change event (e.g. true drag-and-drop), which the
          // fallbacks below still cover.
          if (Object.prototype.hasOwnProperty.call(__liveAnswers, n)) return __liveAnswers[n];
          try {
            if (typeof getUserAnswer === 'function') return getUserAnswer(n) || '';
            if (typeof getQuestionAnswer === 'function') return getQuestionAnswer(n) || '';
          } catch (e) {}
          // Some template generations never expose a named per-question helper --
          // they read the answer inline inside their own checkAnswers(), using one
          // of these DOM conventions depending on question type. Mirrors that same
          // logic here so harvesting still works without calling into the
          // template's own (replaced) checkAnswers().
          try {
            var el = document.getElementById('q' + n);
            if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT')) return (el.value || '').trim();
          } catch (e) {}
          try {
            var checked = document.querySelector('input[name="q' + n + '"]:checked');
            if (checked) return checked.value || '';
          } catch (e) {}
          try {
            var slot = document.querySelector('.dnd-slot[data-q="' + n + '"]');
            if (slot && slot.dataset && slot.dataset.value) return slot.dataset.value;
          } catch (e) {}
          // The drag-matching generation ("Choose FOUR answers from the box"):
          // a different class, a different attribute, and the letter kept under
          // .answer rather than .value. It is also a <div>, so nothing above can
          // see it -- no name, no id, no .value -- and no input/change event ever
          // fires, so __liveAnswers never holds it either. Without this, those
          // questions harvest as blank: a student who drags all four correctly
          // still scores zero on them, and nothing in the submission looks wrong.
          try {
            var ldm = document.querySelector('.ldm-slot[data-question="' + n + '"]');
            if (ldm && ldm.dataset && ldm.dataset.answer) return ldm.dataset.answer;
          } catch (e) {}
          // The matching-grid generation: a table of statements against a list of
          // names or categories, where the student clicks a cell rather than using
          // any kind of input. The chosen cell is flagged data-selected="true" and
          // carries the letter in data-value.
          //
          // Nothing above can see it -- there is no input, no name, no id and no
          // value -- so these harvested blank. Students reported picking answers on
          // Reading prediction 4 and the paper recording nothing for questions
          // 32-39: eight marks, lost silently, on a paper that looked answered.
          //
          // As with the drag slots, the bridge already knew this selector, but only
          // to classify a question's TYPE, never to read one.
          try {
            var cell = document.querySelector('.clickable-cell[data-question="' + n + '"][data-selected="true"]');
            if (cell) {
              var cv = cell.getAttribute('data-value');
              if (cv) return cv;
            }
          } catch (e) {}
          try {
            var groupResult = __checkboxGroupCredit(n);
            if (groupResult) return groupResult.userAnswer;
          } catch (e) {}
          return '';
        }

        function __normalize(v) {
          return String(v == null ? '' : v).trim().toLowerCase();
        }

        // Only one template generation (the one behind buildExplanationHtml) exposes
        // a real, pre-written per-question explanation with evidence quoted from the
        // passage. Every other variant in this family still has enough structure to
        // build a useful (if less specific) one: a per-question type, from whichever
        // metadata object the template happens to expose, or inferred from the DOM
        // shape of the answer element when no such object exists at all (true for
        // every listening variant so far); plus the question's own prompt text, when
        // available. Never assumes any one variant's exact data shape.
        function __inferQuestionType(n) {
          try {
            if (typeof questions === 'object' && questions && questions[n] && questions[n].type) return questions[n].type;
          } catch (e) {}
          try {
            if (typeof questionTypeMap === 'object' && questionTypeMap && questionTypeMap[n]) return questionTypeMap[n];
          } catch (e) {}
          try {
            if (document.querySelector('.clickable-cell[data-question="' + n + '"]')) return 'matching';
            if (document.querySelector('.summary-drop-zone[data-q-start="' + n + '"]')) return 'matching';
            if (document.querySelector('.ldm-slot[data-question="' + n + '"]')) return 'matching';
            var el = document.getElementById('q' + n);
            if (el && el.tagName === 'SELECT') return 'select';
            if (el && el.tagName === 'INPUT') return 'text';
            if (document.querySelector('[name="q' + n + '"]')) return 'mcq';
          } catch (e) {}
          return null;
        }

        function __questionPrompt(n) {
          try {
            if (typeof questions === 'object' && questions && questions[n]) {
              var q = questions[n];
              return q.prompt || q.statement || q.label || q.instruction || null;
            }
          } catch (e) {}
          return null;
        }

        function __genericTip(type) {
          var tips = {
            tfn: 'Look for exact support, exact contradiction, or no clear information.',
            ynng: 'Look for exact support, exact contradiction, or no clear information.',
            text: 'Check the exact word(s) used (and the stated word limit) -- spelling counts.',
            select: 'Match based on the overall meaning, not just one keyword.',
            headings: 'Choose the heading that matches the overall idea, not just one detail.',
            mcq: 'Eliminate options that contradict what was said; the correct one is fully supported.',
            matching: 'Track the exact feature, person, or detail mentioned for each item.',
            'matching-select': 'Track the exact feature or person mentioned for each item.'
          };
          return (type && tips[type]) || 'Compare your answer with the correct one to see exactly where your understanding differed.';
        }

        function __escapeHtml(s) {
          return String(s == null ? '' : s).replace(/[&<>"]/g, function(c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
          });
        }

        function __buildGenericExplanationHtml(n) {
          var type = __inferQuestionType(n);
          var prompt = __questionPrompt(n);
          var html = '<div class="__genericExplanation">';
          if (prompt) html += '<p style="font-weight:600;margin-bottom:6px">' + __escapeHtml(prompt) + '</p>';
          html += '<p><em>How to approach this type:</em> ' + __escapeHtml(__genericTip(type)) + '</p>';
          html += '</div>';
          return html;
        }

        // __finalise distinguishes the student finishing the section (lock it) from
        // the continuous auto-save (report only, change nothing they can see).
        function __silentCheckAndReport(__finalise) {
          var answers = {};
          var detail = {};
          var correctCount = 0;
          // Safe to look up (and cache for this whole run) only now -- this only
          // ever runs once the student clicks the button, long after the
          // template's own DOMContentLoaded handler has had every chance to run.
          var __correctAnswers = __getCorrectAnswers();
          // Scoring must never inherit a checkbox-group verdict computed earlier
          // in the page's life. Anything that probes an answer before submission
          // (the question navigator's "answered" highlight, for one) would
          // otherwise cache an empty result from before the student ticked
          // anything, and that stale verdict would win here -- silently zeroing a
          // correctly answered pair. Recompute from the live DOM at submit time.
          __groupCreditCache = {};
          for (var n = 1; n <= 40; n++) {
            var userAns = __harvestAnswer(n);
            answers[n] = userAns;
            // These must be reset (not just declared) every iteration: "var" is
            // function-scoped, not block-scoped, so a bare "var x;" on iteration 2
            // is a no-op that silently keeps iteration 1's value if this question
            // doesn't overwrite it -- exactly what happened before this fix, where
            // every question after the first one with a real explanation quietly
            // inherited that first question's explanation text.
            var correctAnswerForN = undefined;
            var isCorrectForN = false;
            try {
              // A shared "choose two letters" checkbox group must be scored as a SET
              // before any single-answer comparison is attempted. Both halves of the
              // pair harvest the same combined "C, D" value, so exact-matching that
              // against an individually-keyed answer ('21':'C') marks a fully correct
              // pair wrong on both questions -- real students lost real marks to this.
              // Group scoring therefore runs first, not merely as an "else" for the
              // templates that happen to key the pair as '21_22'.
              var groupResult = __checkboxGroupCredit(n, userAns);
              if (groupResult) {
                correctAnswerForN = groupResult.correctAnswer;
                isCorrectForN = groupResult.isCorrect;
                if (isCorrectForN) correctCount++;
              } else if (typeof __correctAnswers === 'object' && __correctAnswers && __correctAnswers[n] !== undefined) {
                var correct = __correctAnswers[n];
                correctAnswerForN = Array.isArray(correct) ? correct[0] : correct;
                var isMatch = Array.isArray(correct)
                  ? correct.some(function(c) { return __normalize(c) === __normalize(userAns); })
                  : __normalize(correct) === __normalize(userAns);
                if (isMatch) { correctCount++; isCorrectForN = true; }
              }
            } catch (e) {}
            var explanationHtml = undefined;
            try {
              if (typeof buildExplanationHtml === 'function') explanationHtml = buildExplanationHtml(n);
            } catch (e) {}
            if (!explanationHtml) {
              try { explanationHtml = __buildGenericExplanationHtml(n); } catch (e) {}
            }
            if (correctAnswerForN !== undefined) {
              detail[n] = {
                userAnswer: userAns,
                correctAnswer: correctAnswerForN,
                isCorrect: isCorrectForN
              };
              if (explanationHtml) detail[n].explanationHtml = explanationHtml;
            }
          }
          function __fallbackBand(correct) {
            // Official IELTS raw-score conversion. Every band below 4.5 used to
            // collapse to a flat 4.0, so a blank paper and 12/40 scored the same.
            var t = [[39,9],[37,8.5],[35,8],[32,7.5],[30,7],[26,6.5],[23,6],[18,5.5],[16,5],[13,4.5],[10,4],[6,3.5],[4,3],[0,2.5]];
            for (var i = 0; i < t.length; i++) { if (correct >= t[i][0]) return t[i][1]; }
            return 2.5;
          }
          var band = __fallbackBand(correctCount);
          try {
            if (typeof calculateBandScore === 'function') {
              var reported = parseFloat(calculateBandScore(correctCount));
              if (!isNaN(reported)) band = reported;
            }
          } catch (e) {}

          // Stop any internal timer/audio and lock the answers in, without ever
          // revealing correctness (these variable names are consistent across this
          // template family's listening/reading variants).
          //
          // Only when the student has actually finished. This same function is the
          // continuous auto-save, called once at install and again on every input,
          // change and click -- so locking here made the paper read-only 300ms
          // after it loaded: every option disabled, the audio paused, the sliders
          // dead, before a single question could be answered.
          if (__finalise) {
            try { if (typeof timerInterval !== 'undefined' && timerInterval) clearInterval(timerInterval); } catch (e) {}
            try { if (typeof timerRunning !== 'undefined') timerRunning = false; } catch (e) {}
            document.querySelectorAll('audio').forEach(function(a) { try { a.pause(); } catch (e) {} });
            document.querySelectorAll('input, select, textarea').forEach(function(el) { el.disabled = true; });
          }

          if (window.parent) {
            window.parent.postMessage({
              type: 'IELTS_MODULE_COMPLETE',
              testId: __bridgeTestId,
              moduleType: __bridgeModuleType,
              answers: answers,
              detail: detail,
              correctCount: correctCount,
              band: band
            }, window.location.origin);
          }
        }

        function __reclaimHeaderSpace() {
          // This template family is now always embedded inside the platform's own
          // chrome (a header with the test title/shared timer/submit button, plus
          // module tabs), which duplicates this file's own internal <header> (its
          // own title, a second timer, notes/theme toggles) -- wasted space that
          // should go to the passage/audio content, and a confusingly duplicate
          // timer. The bottom nav is left alone: the "Complete Section" button and
          // part/section navigation live inside it.
          //
          // Hiding the header alone isn't enough -- these templates commonly give
          // some other fixed-position wrapper a hardcoded top offset to make room
          // for it (e.g. a content wrapper at top:60px to clear a 60px header),
          // and that offset doesn't move just because the header disappears. Class
          // names for that wrapper vary per template, so instead of guessing one,
          // measure the header's real height and reclaim it from whatever
          // fixed-position element was offset by roughly that amount.
          try {
            var header = document.querySelector('header');
            if (!header) return;
            // These modules are mounted (but not necessarily visible) as soon as
            // the exam starts, to preserve audio/progress across tab switches --
            // so this can run while still hidden behind another active tab, where
            // getBoundingClientRect() returns 0 for everything (a hidden ancestor
            // generates no layout box at all). The header's height is an explicit
            // pixel value in this template family's own CSS, though, so the
            // computed style resolves correctly regardless of visibility -- prefer
            // that, and only fall back to the layout measurement if it doesn't.
            var computedHeight = parseFloat(getComputedStyle(header).height);
            var headerHeight = !isNaN(computedHeight) && computedHeight > 0
              ? computedHeight
              : header.getBoundingClientRect().height;
            if (!headerHeight || headerHeight <= 0) return;
            document.querySelectorAll('*').forEach(function(el) {
              if (el === header) return;
              var style = getComputedStyle(el);
              if (style.position !== 'fixed') return;
              var top = parseFloat(style.top);
              if (!isNaN(top) && Math.abs(top - headerHeight) < 4) {
                el.style.top = '0px';
              }
            });
            header.style.display = 'none';
          } catch (e) {}
        }

        function __shrinkPartBanner() {
          // The reading template's "Part 1/2/3" banner (.part-banner / #partBanner)
          // is real, useful content (a heading plus the part's instructions), not
          // chrome to hide -- but its default padding and margin cost real
          // passage-reading room. Shrink them, then (same reasoning as the header
          // above) the passage/questions container has a hardcoded top offset sized
          // to clear the banner at its old height, so recompute that offset directly
          // from the banner's new, shorter bottom edge instead of guessing a delta
          // to subtract -- this template doesn't exist in every variant, so this
          // no-ops harmlessly wherever the banner (and thus this whole function)
          // isn't present at all.
          try {
            var banner = document.querySelector('.part-banner') || document.getElementById('partBanner');
            if (!banner) return;
            banner.style.padding = '6px 16px';
            banner.style.margin = '4px 16px';

            var passage = document.querySelector('.passage-panel') || document.getElementById('passagePanel')
              || document.querySelector('.questions-panel') || document.getElementById('questionsPanel');
            if (!passage) return;
            var container = passage.parentElement;
            while (container && container !== document.body) {
              var pos = getComputedStyle(container).position;
              if (pos === 'absolute' || pos === 'fixed') break;
              container = container.parentElement;
            }
            if (!container || container === document.body) return;

            function __repositionPanels() {
              var offsetParent = container.offsetParent || document.body;
              var bannerBottom = banner.getBoundingClientRect().bottom;
              var offsetParentTop = offsetParent.getBoundingClientRect().top;
              var newTop = bannerBottom - offsetParentTop;
              // getBoundingClientRect() returns all zeros for every element in this
              // document whenever an ancestor OUTSIDE it (the platform's own tab
              // switcher) has it display:none -- both iframes mount immediately when
              // the exam starts, but only the active tab's is actually visible, and
              // Reading isn't the default tab. So this can't just retry a few times
              // and give up: it may need to wait for the student to switch to this
              // tab at all, whenever that happens. Keep polling (cheap, and the
              // interval clears itself the moment it succeeds) rather than capping
              // the attempts.
              if (newTop > 0) { container.style.top = newTop + 'px'; return true; }
              return false;
            }
            if (!__repositionPanels()) {
              var __pollId = setInterval(function() {
                if (__repositionPanels()) clearInterval(__pollId);
              }, 250);
            }
            // Keep watching afterwards too: the banner's height also changes
            // whenever the student switches parts (Part 1 -> Part 2, etc).
            new MutationObserver(__repositionPanels).observe(banner, {
              childList: true, subtree: true, characterData: true
            });
          } catch (e) {}
        }

        function __findCheckButton() {
          var idCandidates = ['checkBtn', 'checkAnswersBtn'];
          for (var i = 0; i < idCandidates.length; i++) {
            var byId = document.getElementById(idCandidates[i]);
            if (byId) return byId;
          }
          var buttons = document.querySelectorAll('button');
          for (var j = 0; j < buttons.length; j++) {
            if (/check\\s*answers?/i.test(buttons[j].textContent || '')) return buttons[j];
          }
          return null;
        }

        // Real IELTS Listening audio plays exactly once -- no pausing, rewinding,
        // or replaying once started. Some template generations enforce this
        // themselves; this one (and evidently others) simply don't, leaving a
        // working pause button with nothing stopping a student from pausing to
        // think, take notes at leisure, or look something up. Overriding
        // .pause() as a no-op stops the template's own play/pause button (which
        // calls it directly); the 'pause' listener catches anything else that
        // manages to pause the element some other way (OS media keys, browser
        // media session controls) and resumes immediately, unless it actually
        // finished.
        function __enforceNoAudioPause() {
          try {
            if (__bridgeModuleType !== 'listening') return;
            var audioEl = document.getElementById('mainAudio') || document.querySelector('audio');
            if (!audioEl || audioEl.dataset.noPauseEnforced === '1') return;
            audioEl.dataset.noPauseEnforced = '1';
            audioEl.pause = function () {};
            audioEl.addEventListener('pause', function () {
              if (!audioEl.ended) { try { audioEl.play().catch(function () {}); } catch (e) {} }
            });
          } catch (e) {}
        }

        // Scores, bands and correct-answer tables belong to the teacher's release,
        // not to the test page. Some generations render them into a modal and an
        // explanations panel the moment their own checkAnswers() runs, so this
        // hides them whenever they appear. Kept running briefly afterwards because
        // the results markup is sometimes built asynchronously, after the click.
        function __suppressRevealedResults() {
          var SELECTORS = [
            '.results-overlay', '.results-modal', '#resultsModal', '#results-modal',
            '.all-explanations', '#toggle-all-explanations-btn', '#retakeBtn'
          ];
          var hide = function () {
            for (var i = 0; i < SELECTORS.length; i++) {
              var found = document.querySelectorAll(SELECTORS[i]);
              for (var j = 0; j < found.length; j++) {
                try { found[j].style.setProperty('display', 'none', 'important'); } catch (e) {}
              }
            }
          };
          hide();
          var until = Date.now() + 10000;
          var timer = setInterval(function () {
            hide();
            if (Date.now() > until) clearInterval(timer);
          }, 200);
        }

        // These templates show which option is selected using CSS alone:
        //   .tf-option:has(input:checked) { background: ...; }
        // Nothing in JS maintains that state. Teacher reported that on the
        // True/False/Not Given questions you cannot change an answer -- pick TRUE,
        // realise it is FALSE, and the highlight stays on TRUE. The radio value
        // does change (scoring is unaffected), but :has() style invalidation on a
        // radio change is browser- and version-dependent, so the highlight can
        // stick to the first choice and the question looks locked.
        //
        // Mirroring the same appearance with a plain class removes the dependency
        // on :has() entirely. Purely visual -- no answer handling is touched.
        function __installSelectionHighlight() {
          try {
            var style = document.createElement('style');
            style.textContent =
              '.tf-option.__bridgeChecked, .multi-choice-option.__bridgeChecked' +
              '{background:#cfe3f9 !important;border-color:#7db3f5 !important;}' +
              '[data-theme="dark"] .tf-option.__bridgeChecked,' +
              '[data-theme="dark"] .multi-choice-option.__bridgeChecked' +
              '{background:#2e4766 !important;border-color:#7db3f5 !important;}';
            document.head.appendChild(style);
          } catch (e) {}

          var sync = function () {
            try {
              var radios = document.querySelectorAll('.tf-option input[type="radio"], .multi-choice-option input[type="radio"]');
              for (var i = 0; i < radios.length; i++) {
                var label = radios[i].closest('.tf-option, .multi-choice-option');
                if (!label) continue;
                if (radios[i].checked) label.classList.add('__bridgeChecked');
                else label.classList.remove('__bridgeChecked');
              }
            } catch (e) {}
          };

          // Capture phase, so the highlight updates even if something downstream
          // stops the event; click as well as change, because a click that lands
          // on an already-selected option fires no change event.
          document.addEventListener('change', sync, true);
          document.addEventListener('click', function () { setTimeout(sync, 0); }, true);
          sync();
        }

        // Teacher-released review. These templates already carry a rich review --
        // the passage with the evidence for each answer highlighted, the correct
        // answer per question, and explanations -- which the exam flow above
        // deliberately suppresses so students cannot see answers while sitting the
        // paper. Once the teacher releases a result, that same view is exactly what
        // they want the student to study, so this mode puts the student's stored
        // answers back and lets the template render its own review.
        //
        // Reached only via ?review=1, which the platform uses solely for a released
        // submission, and the page is read-only: the submit button is gone and
        // nothing is reported back.
        function __applyReviewAnswers(answers) {
          for (var n = 1; n <= 40; n++) {
            var value = answers[n] != null ? String(answers[n]) : '';
            if (!value) continue;
            try {
              var el = document.getElementById('q' + n);
              if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT')) {
                el.value = value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                continue;
              }
              var radios = document.querySelectorAll('input[type="radio"][name="q' + n + '"]');
              if (radios.length) {
                for (var r = 0; r < radios.length; r++) {
                  if (radios[r].value === value) {
                    radios[r].checked = true;
                    radios[r].dispatchEvent(new Event('change', { bubbles: true }));
                  }
                }
                continue;
              }
              // Shared "choose two letters" groups store one combined value
              // ("C, D") against every question in the group.
              var picked = value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
              var boxes = document.querySelectorAll('input[type="checkbox"][name^="q"][name*="_"]');
              for (var b = 0; b < boxes.length; b++) {
                var parts = String(boxes[b].name).slice(1).split('_');
                if (parts.indexOf(String(n)) === -1) continue;
                if (picked.indexOf(boxes[b].value) !== -1 && !boxes[b].checked) {
                  boxes[b].checked = true;
                  boxes[b].dispatchEvent(new Event('change', { bubbles: true }));
                }
              }
            } catch (e) {}
          }
        }

        function __installReviewMode() {
          try {
            var btn = __findCheckButton();
            if (btn) btn.style.setProperty('display', 'none', 'important');
          } catch (e) {}

          window.addEventListener('message', function (event) {
            if (event.origin !== window.location.origin) return;
            if (!event.data || event.data.type !== 'IELTS_REVIEW_ANSWERS') return;
            var answers = event.data.answers && typeof event.data.answers === 'object' ? event.data.answers : {};
            __applyReviewAnswers(answers);
            // The template's own grading renders the passage evidence, the correct
            // answers and the explanations, and locks the inputs afterwards.
            try {
              if (typeof window.checkAnswers === 'function') window.checkAnswers();
            } catch (e) {}
          });

          // Tell the platform this page is ready to receive the answers.
          try {
            window.parent.postMessage({ type: 'IELTS_REVIEW_READY' }, window.location.origin);
          } catch (e) {}
        }

        // Real report: on the True/False/Not Given questions, choosing TRUE by
        // accident left the answer stuck -- clicking FALSE or NOT GIVEN did
        // nothing.
        //
        // Cause is the passage-highlighting tool. Its mouseup handler is bound to
        // the whole document, so a click that also selects the option's word
        // (a double-click, or a click with the slightest drag) counts as a text
        // selection and pops the highlight toolbar at the cursor. The toolbar
        // prefers to sit above the cursor but flips below when there is no room
        // -- which is the case near the top of a passage -- and at ~146px tall it
        // then covers the next two or three options, swallowing the clicks. It
        // depends on where on the page you click, which is why it looked
        // intermittent.
        //
        // Highlighting is for studying the passage, not for the answer options,
        // so the selection is dropped when it lands inside an option. Their
        // handler runs on a 10ms timer and then sees nothing selected, so no
        // toolbar appears and the click reaches the option. Passage highlighting
        // is untouched.
        function __keepOptionsClickable() {
          var OPTION = '.tf-option, .multi-choice-option, .tf-options label, .options label';
          document.addEventListener('mouseup', function (event) {
            try {
              var target = event.target;
              var el = target && target.nodeType === 1 ? target : (target && target.parentElement);
              if (!el || !el.closest || !el.closest(OPTION)) return;
              var selection = window.getSelection();
              if (!selection || selection.isCollapsed || !String(selection).trim()) return;
              selection.removeAllRanges();
            } catch (e) {}
          }, true);
        }

        // These templates paint the question number over the answer box with
        // CSS -- .q-input-wrap::before draws it, and .filled hides it again --
        // and something in the template's own start-up is meant to add .filled
        // as the student types. It does not run here, so the number stays
        // sitting on top of whatever they write.
        //
        // Toggled from the bridge instead, which does not depend on any of the
        // template's own wiring. Also applied on load so answers restored into
        // the page do not come back with a number over them.
        function __hideNumberOnceAnswered() {
          // Setting .filled alone was not enough: the template's own
          // ".filled::before { opacity: 0 }" loses in the cascade, so the number
          // stayed painted over the answer even once the class was on. Restate
          // it here, last and !important, so it actually wins.
          try {
            var css = document.createElement('style');
            css.textContent = '.q-input-wrap.filled::before{opacity:0 !important;visibility:hidden !important;}';
            document.head.appendChild(css);
          } catch (err) {}

          function sync(field) {
            var wrap = field && field.closest ? field.closest('.q-input-wrap') : null;
            if (!wrap) return;
            if (String(field.value || '').trim()) wrap.classList.add('filled');
            else wrap.classList.remove('filled');
          }
          document.addEventListener('input', function (e) { try { sync(e.target); } catch (err) {} }, true);
          document.addEventListener('change', function (e) { try { sync(e.target); } catch (err) {} }, true);
          try {
            document.querySelectorAll('.q-input-wrap > input').forEach(sync);
          } catch (err) {}
        }

        // Drag-to-match questions arrive inert: the template wires the options
        // and slots in bindListeningDragMatching(), which it calls from the
        // start-up flow the platform bypasses (students are already logged in,
        // so that welcome step is skipped). The function is there and works --
        // it simply never runs, leaving every matching question unanswerable.
        //
        // Called by name because that is what these templates define. Anything
        // absent is skipped, so this is a no-op on generations without it.
        // Generations that DO wire it do so from their own DOMContentLoaded, which
        // is registered earlier in the document than this bridge and therefore
        // already ran. Calling the binder again then bound a second handler to
        // every option and slot, and the two fought each other: the first click
        // handler placed the letter and cleared the armed selection, the second saw
        // no armed selection and a now-filled slot, read that as "remove this
        // answer", and wiped it. Clicking a slot appeared to do nothing at all, so
        // those questions were unanswerable by clicking.
        //
        // Rather than guess whether the template already bound (listeners cannot be
        // inspected), replace the elements with clones first. That strips whatever
        // was bound to them, so after the call there is exactly one handler set --
        // correct both for generations that had wired it and those that never did.
        function __runTemplateInitialisers() {
          try {
            document.querySelectorAll('.ldm-option, .ldm-slot').forEach(function (el) {
              if (el.parentNode) el.parentNode.replaceChild(el.cloneNode(true), el);
            });
          } catch (e) {}
          ['bindListeningDragMatching', 'syncListeningMatchUI'].forEach(function (name) {
            try {
              if (typeof window[name] === 'function') window[name]();
            } catch (e) {}
          });
        }

        function __installBridge() {
          __enforceNoAudioPause();
          __hideNumberOnceAnswered();
          __runTemplateInitialisers();
          __reclaimHeaderSpace();
          __installSelectionHighlight();
          __keepOptionsClickable();

          var __reviewMode = false;
          try {
            __reviewMode = new URLSearchParams(window.location.search).get('review') === '1';
          } catch (e) {}
          if (__reviewMode) {
            __installReviewMode();
            return;   // no exam wiring, no suppression: this IS the reveal
          }

          // Hidden up front, not just after submitting: it is a student-facing
          // control whose whole purpose is revealing the answer key.
          try {
            var explToggle = document.getElementById('toggle-all-explanations-btn');
            if (explToggle) explToggle.style.setProperty('display', 'none', 'important');
          } catch (e) {}

          // Continuously harvest answers on input, change, or click inside iframe so answers are auto-saved in real-time
          var __debounceTimer = null;
          function __autoHarvest() {
            if (__debounceTimer) clearTimeout(__debounceTimer);
            __debounceTimer = setTimeout(function() {
              try { __silentCheckAndReport(false); } catch (e) {}
            }, 300);
          }
          document.addEventListener('input', __autoHarvest);
          document.addEventListener('change', __autoHarvest);
          document.addEventListener('click', __autoHarvest);
          __autoHarvest();

          var btn = __findCheckButton();
          if (!btn) return;
          // Strip any addEventListener-bound handlers by cloning, then replace the
          // click behavior entirely (inline onclick="checkAnswers()" attributes get
          // overwritten by the .onclick assignment below).
          var freshBtn = btn.cloneNode(true);
          btn.parentNode.replaceChild(freshBtn, btn);
          // The original label ("Check Answers") implies scoring, which this bridge
          // deliberately never shows the student. Relabel it as a plain completion
          // action before it's ever clicked, not just after.
          freshBtn.textContent = '✓ Complete Section';

          var __bridgeComplete = function() {
            if (freshBtn.dataset.bridgeSubmitted === '1') return;
            freshBtn.dataset.bridgeSubmitted = '1';
            __silentCheckAndReport(true);
            freshBtn.textContent = '✓ Section Completed';
            freshBtn.disabled = true;
            freshBtn.style.opacity = '0.6';
            freshBtn.style.cursor = 'default';
            // Belt and braces: even if some other handler still manages to run
            // the template's own scoring, the student must not see the marks.
            __suppressRevealedResults();
            alert('This section is marked complete and saved. You can switch tabs or submit the whole test when ready.');
          };

          // Cloning the button strips handlers bound BEFORE this point, but some
          // template generations run their own attachEvents()/initialize() after
          // this bridge installs and bind checkAnswers() to the replacement button.
          // Both then fire on one click: the bridge reports the result silently
          // AND the template pops its own results modal, showing the student their
          // score, band and the full correct-answer table -- exactly what
          // teacher-controlled release exists to prevent. A capture-phase listener
          // runs before any of those bubble-phase handlers, and
          // stopImmediatePropagation keeps them from running at all.
          freshBtn.addEventListener('click', function(event) {
            try {
              event.stopImmediatePropagation();
              event.preventDefault();
            } catch (e) {}
            __bridgeComplete();
          }, true);
          // Not via .onclick: that is itself a bubble-phase handler and would be
          // cancelled by the stopImmediatePropagation above.
          freshBtn.onclick = null;

          // "Complete Section" only means something in a multi-module exam, where
          // a section is locked before moving to the next one. On a single-module
          // test the section IS the test, so it sat next to the platform's own
          // Submit Test button as a second, redundant way to finish -- and it used
          // to be the only one that actually saved anything. Submit now harvests
          // by itself, so on a single-module test this button is hidden rather
          // than offered as a confusing choice. It stays in the DOM and fully
          // wired, because the platform still triggers it programmatically (via
          // __ieltsBridgeComplete) on submit, timeout and module hand-off.
          try {
            if (new URLSearchParams(window.location.search).get('multiModule') === '0') {
              freshBtn.style.setProperty('display', 'none', 'important');
            }
          } catch (e) {}
          // The parent platform needs to be able to trigger completion itself
          // (a module's own clock running out, or a sequential-locked exam
          // moving the student on) without a real user click -- but every
          // template generation names/labels this button differently, and
          // this bridge itself relabels it away from its original text the
          // moment it installs. A DOM search for "the check answers button"
          // from outside is exactly the kind of thing that silently stops
          // matching the instant either of those varies, which is a real
          // incident: a student's whole Reading section went unsubmitted
          // because the parent's button-matching heuristics didn't recognize
          // this button once it had already been relabeled. Exposing the
          // handler directly removes the need to find the button at all.
          window.__ieltsBridgeComplete = __bridgeComplete;
        }

        if (document.readyState !== 'loading') {
          __installBridge();
        } else {
          document.addEventListener('DOMContentLoaded', __installBridge);
        }
      })();
      `;
      content = content.replace('</body>', `<script>${harvestBridgeSnippet}</script>\n</body>`);
    } else if (
      content.includes('function submitTest(')
      && content.includes('const ANSWERS')
      && content.includes('renderDots')
    ) {
      // A different, newer self-scoring template generation (e.g. the
      // "Day N" Listening + bonus-Writing-Task-2 files) -- no checkAnswers/
      // getUserAnswer/correctAnswers naming at all, so the harvest-bridge
      // signature above never matches it, and it doesn't call
      // /api/student/submit or postMessage anything to the parent either.
      // Left completely unintegrated, a student could take it but the
      // teacher would never see a result and it wouldn't count toward
      // Skills Averages -- same silent-gap problem the harvest bridge above
      // exists to close, just for a template that names everything
      // differently. Every answer element shares one convention here
      // (id="a"+questionNumber, whether <input> or <select>), and ANSWERS/
      // PAIR_CORRECT are bare top-level consts (not inside an IIFE), so
      // they're reachable from this separately-injected <script> tag.
      const dayFamilyBridgeSnippet = `
      (function() {
        var params = new URLSearchParams(window.location.search);
        var __bridgeTestId = params.get('testId') || '${testId}';
        var __bridgeModuleType = params.get('moduleType') || '${moduleType}';

        function __computeBand(correctCount) {
          var bands = [[39,9],[37,8.5],[35,8],[32,7.5],[30,7],[26,6.5],[23,6],[18,5.5],[16,5],[13,4.5],[10,4],[6,3.5],[4,3],[0,2.5]];
          for (var i = 0; i < bands.length; i++) { if (correctCount >= bands[i][0]) return bands[i][1]; }
          return 2.5;
        }

        function __harvestAll() {
          var answers = {};
          var detail = {};
          var correctCount = 0;
          for (var n = 1; n <= 40; n++) {
            var el = document.getElementById('a' + n);
            if (!el) continue;
            var userAnswer = String(el.value || '').trim();
            var isCorrect = false;
            var correctAnswerDisplay = '';
            try {
              if (typeof PAIR_CORRECT !== 'undefined' && PAIR_CORRECT[n]) {
                var pair = PAIR_CORRECT[n];
                isCorrect = pair.indexOf(userAnswer) !== -1;
                correctAnswerDisplay = pair.join(' or ');
              } else if (typeof ANSWERS !== 'undefined' && ANSWERS[n] !== undefined) {
                correctAnswerDisplay = ANSWERS[n];
                isCorrect = userAnswer.toLowerCase() === String(ANSWERS[n]).toLowerCase();
              }
            } catch (e) {}
            if (isCorrect) correctCount++;
            answers[n] = userAnswer;
            detail[n] = { userAnswer: userAnswer, correctAnswer: correctAnswerDisplay, isCorrect: isCorrect };
          }
          return { answers: answers, detail: detail, correctCount: correctCount };
        }

        // This template carries its own "Writing Task 2" tab with an essay box
        // inside the Listening iframe, while the platform ALSO shows the same
        // Task 2 prompt in its native (gradeable) Writing module. Two boxes for
        // one essay, and the in-iframe one is the obvious place to type -- so
        // students wrote there and the essay was silently thrown away, never
        // reaching the teacher. Hide the duplicate so there is exactly one place
        // to write: the native module the teacher actually grades. The prompt
        // itself is not lost; it is shown verbatim in that module.
        function __hideDuplicateWritingTab() {
          try {
            var tabs = document.querySelectorAll('.stab');
            for (var i = 0; i < tabs.length; i++) {
              if (/writing/i.test(tabs[i].textContent || '')) tabs[i].style.display = 'none';
            }
          } catch (e) {}
        }

        function __harvestEssay() {
          try {
            var box = document.getElementById('essayText');
            return box ? String(box.value || '').trim() : '';
          } catch (e) { return ''; }
        }

        // Teacher-released review, same idea as the other bridge: put the
        // student's stored answers back and let the template's own submitTest()
        // render its results grid with the correct answers. Read-only, reached
        // only via ?review=1, which the platform opens solely for a released
        // submission.
        function __installDayFamilyReview() {
          try {
            var submitBtn = document.querySelector('.btn-submit');
            if (submitBtn) submitBtn.style.setProperty('display', 'none', 'important');
          } catch (e) {}

          window.addEventListener('message', function (event) {
            if (event.origin !== window.location.origin) return;
            if (!event.data || event.data.type !== 'IELTS_REVIEW_ANSWERS') return;
            var answers = event.data.answers && typeof event.data.answers === 'object' ? event.data.answers : {};
            for (var n = 1; n <= 40; n++) {
              try {
                var el = document.getElementById('a' + n);
                if (!el) continue;
                var value = answers[n] != null ? String(answers[n]) : '';
                if (!value) continue;
                el.value = value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              } catch (e) {}
            }
            try {
              if (typeof window.submitTest === 'function') window.submitTest();
            } catch (e) {}
            // Its own grading leaves the fields editable; lock them so this
            // stays a review rather than something that looks re-answerable.
            try {
              var fields = document.querySelectorAll('input, select, textarea');
              for (var f = 0; f < fields.length; f++) fields[f].disabled = true;
            } catch (e) {}
          });

          try {
            window.parent.postMessage({ type: 'IELTS_REVIEW_READY' }, window.location.origin);
          } catch (e) {}
        }

        function __installDayFamilyBridge() {
          var __reviewMode = false;
          try { __reviewMode = params.get('review') === '1'; } catch (e) {}
          if (__reviewMode) {
            __installDayFamilyReview();
            return;
          }

          __hideDuplicateWritingTab();
          var btn = document.querySelector('.btn-submit');
          if (!btn) return;
          var freshBtn = btn.cloneNode(true);
          btn.parentNode.replaceChild(freshBtn, btn);
          freshBtn.textContent = '✓ Complete Section';
          freshBtn.onclick = function() {
            if (freshBtn.dataset.bridgeSubmitted === '1') return;
            freshBtn.dataset.bridgeSubmitted = '1';
            try { var a = document.getElementById('mainAudio'); if (a) a.pause(); } catch (e) {}
            var result = __harvestAll();
            window.parent.postMessage({
              type: 'IELTS_MODULE_COMPLETE',
              testId: __bridgeTestId,
              moduleType: __bridgeModuleType,
              answers: result.answers,
              detail: result.detail,
              correctCount: result.correctCount,
              band: __computeBand(result.correctCount),
              // Safety net for anyone who reached the in-iframe essay box before
              // it was hidden: the parent adopts this only when its own Task 2
              // box is still empty, so it can never overwrite the student's work.
              essay: __harvestEssay()
            }, window.location.origin);
            freshBtn.textContent = '✓ Section Completed';
            freshBtn.disabled = true;
            freshBtn.style.opacity = '0.6';
            freshBtn.style.cursor = 'default';
            alert('This section is marked complete and saved. You can switch tabs or submit the whole test when ready.');
          };
          window.__ieltsBridgeComplete = freshBtn.onclick;

          // Same reasoning as the bridge above: redundant next to the platform's
          // Submit Test button when this module is the whole test. Hidden, not
          // removed -- the platform still fires it programmatically.
          try {
            if (params.get('multiModule') === '0') {
              freshBtn.style.setProperty('display', 'none', 'important');
            }
          } catch (e) {}
        }

        if (document.readyState !== 'loading') {
          __installDayFamilyBridge();
        } else {
          document.addEventListener('DOMContentLoaded', __installDayFamilyBridge);
        }
      })();
      `;
      content = content.replace('</body>', `<script>${dayFamilyBridgeSnippet}</script>\n</body>`);
    } else if (
      content.includes('const answerKey = {')
      && content.includes('submit-check-btn')
      && content.includes('data-q=')
    ) {
      // A third self-scoring generation (the "Authentic Listening" files). It
      // reports nothing at all -- no fetch, no postMessage -- so without this a
      // student could sit the whole paper and the teacher would see no score,
      // and it would not count toward Skills Averages.
      //
      // Unlike the other two, this template's whole script is wrapped in an
      // IIFE, so answerKey/acceptedAnswers are unreachable from a separately
      // injected <script>. They are static object literals though, so they are
      // parsed out here and baked into the bridge instead of being read from
      // the page at runtime.
      const literalToJson = (source, name) => {
        const start = source.indexOf(`${name} = {`);
        if (start === -1) return null;
        const open = source.indexOf('{', start);
        let depth = 0;
        for (let i = open; i < source.length; i += 1) {
          if (source[i] === '{') depth += 1;
          else if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) {
              const body = source.slice(open, i + 1);
              try {
                // Numeric keys are unquoted in the source; JSON needs them quoted.
                return JSON.parse(body.replace(/([{,]\s*)(\d+)\s*:/g, '$1"$2":'));
              } catch (e) {
                return null;
              }
            }
          }
        }
        return null;
      };

      const parsedKey = literalToJson(content, 'const answerKey');
      const parsedAccepted = literalToJson(content, 'acceptedAnswers') || {};
      // This template ships the supporting evidence for each answer. Without
      // passing it through, the teacher's per-question review and the student's
      // released review show a correct answer with no reason for it -- which is
      // the part that actually teaches.
      const parsedExplanations = literalToJson(content, 'answerExplanations') || {};

      if (!parsedKey) {
        console.error(`Upload "${title}": recognised the authentic-listening template but could not read its answer key; results would not be reported.`);
      } else {
        const authenticBridgeSnippet = `
        (function() {
          var params = new URLSearchParams(window.location.search);
          var __testId = params.get('testId') || '${testId}';
          var __moduleType = params.get('moduleType') || '${moduleType}';
          var __review = params.get('review') === '1';
          var KEY = ${JSON.stringify(parsedKey)};
          var ACCEPTED = ${JSON.stringify(parsedAccepted)};
          var EXPLAIN = ${JSON.stringify(parsedExplanations)};

          function __escape(s) {
            return String(s == null ? '' : s)
              .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          }

          function __band(c) {
            var t = [[39,9],[37,8.5],[35,8],[32,7.5],[30,7],[26,6.5],[23,6],[18,5.5],[16,5],[13,4.5],[10,4],[6,3.5],[4,3],[0,2.5]];
            for (var i = 0; i < t.length; i++) { if (c >= t[i][0]) return t[i][1]; }
            return 2.5;
          }
          function __norm(v) { return String(v == null ? '' : v).trim().toLowerCase().replace(/[ \\t\\n\\r]+/g, ' '); }

          function __fieldFor(n) {
            return document.querySelector('[data-q="' + n + '"]');
          }

          // This template renders one part at a time -- only ten answer fields
          // exist in the DOM at any moment -- so reading the page at submit time
          // would capture the last part and silently lose the other thirty
          // answers. Every answer is therefore recorded as the student enters it.
          var __live = {};
          function __track(el) {
            if (!el || !el.getAttribute) return;
            var q = el.getAttribute('data-q');
            if (!q) return;
            __live[q] = el.value;
          }
          document.addEventListener('input', function (e) { __track(e.target); }, true);
          document.addEventListener('change', function (e) { __track(e.target); }, true);

          function __harvest() {
            var answers = {}, detail = {}, correct = 0;
            // Sweep whatever is on screen now, so a part never navigated away
            // from is still included.
            try {
              var present = document.querySelectorAll('[data-q]');
              for (var p = 0; p < present.length; p++) __track(present[p]);
            } catch (e) {}
            for (var n = 1; n <= 40; n++) {
              var el = __fieldFor(n);
              var given = el ? String(el.value || '').trim() : String(__live[n] == null ? '' : __live[n]).trim();
              var accepted = ACCEPTED[n] || (KEY[n] !== undefined ? [KEY[n]] : []);
              var ok = false;
              if (given) {
                for (var a = 0; a < accepted.length; a++) {
                  if (__norm(accepted[a]) === __norm(given)) { ok = true; break; }
                }
              }
              if (ok) correct++;
              answers[n] = given;
              detail[n] = {
                userAnswer: given,
                correctAnswer: accepted.join(' / ') || String(KEY[n] == null ? '' : KEY[n]),
                isCorrect: ok
              };
              if (EXPLAIN[n]) {
                detail[n].explanationHtml =
                  '<div class="__genericExplanation"><p><em>Where this is answered:</em> '
                  + __escape(EXPLAIN[n]) + '</p></div>';
              }
            }
            return { answers: answers, detail: detail, correctCount: correct };
          }

          // This template ships its own "Review" control, and it is live from
          // the moment the page loads -- a student can press it before answering
          // anything and get the full transcript, the answer key and unlocked
          // audio, mid-exam. Hiding the results screen on submit was never
          // enough, because the leak does not wait for a submit.
          //
          // Kept during a released review, where showing the transcript and the
          // answers is the entire point.
          function __hideOwnReviewControl() {
            if (__review) return;
            // Taken out of the document rather than just hidden: display:none
            // stops the click a student can make, but leaves the control and its
            // handler sitting there for anyone who reaches it another way. This
            // one reveals the answer key, so it should not survive at all.
            function hide() {
              try {
                var el = document.getElementById('review-btn');
                if (el && el.parentNode) el.parentNode.removeChild(el);
              } catch (e) {}
            }
            hide();
            // It sits behind the template's start screens, so it can appear
            // later; and re-hide if the template ever re-renders its chrome.
            try {
              new MutationObserver(hide).observe(document.documentElement, { childList: true, subtree: true });
            } catch (e) {}
          }

          function __install() {
            var btn = document.getElementById('submit-check-btn');
            if (!btn) return;

            if (__review) {
              // Released review: put the stored answers back and let the
              // template show its own results screen. Read-only.
              btn.style.setProperty('display', 'none', 'important');
              window.addEventListener('message', function (event) {
                if (event.origin !== window.location.origin) return;
                if (!event.data || event.data.type !== 'IELTS_REVIEW_ANSWERS') return;
                var given = event.data.answers || {};
                for (var n = 1; n <= 40; n++) {
                  var el = __fieldFor(n);
                  if (!el || given[n] == null || given[n] === '') continue;
                  el.value = given[n];
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                }
                try { btn.style.removeProperty('display'); btn.click(); btn.style.setProperty('display', 'none', 'important'); } catch (e) {}
              });
              try { window.parent.postMessage({ type: 'IELTS_REVIEW_READY' }, window.location.origin); } catch (e) {}
              return;
            }

            // Exam: report silently and never let its own results screen show.
            var done = false;
            btn.addEventListener('click', function (event) {
              try { event.stopImmediatePropagation(); event.preventDefault(); } catch (e) {}
              if (done) return;
              done = true;
              var result = __harvest();
              try { document.querySelectorAll('audio').forEach(function (a) { a.pause(); }); } catch (e) {}
              window.parent.postMessage({
                type: 'IELTS_MODULE_COMPLETE',
                testId: __testId, moduleType: __moduleType,
                answers: result.answers, detail: result.detail,
                correctCount: result.correctCount, band: __band(result.correctCount)
              }, window.location.origin);
              btn.textContent = '✓ Completed';
              btn.disabled = true;
              btn.style.opacity = '0.6';
              try {
                var results = document.getElementById('screen-results');
                if (results) results.style.setProperty('display', 'none', 'important');
              } catch (e) {}
              alert('This section is marked complete and saved. You can submit the whole test when ready.');
            }, true);
            window.__ieltsBridgeComplete = function () { btn.click(); };
          }

          // Straight away, not once the submit button turns up: the Review
          // control is reachable from the first paint, long before the student
          // reaches a screen that has a submit button on it.
          __hideOwnReviewControl();

          // The button lives behind this template's own start screens, so it may
          // not exist yet when this first runs. Keep looking rather than giving
          // up silently -- a bridge that quietly does not install is exactly the
          // failure this exists to prevent.
          var __tries = 0;
          function __installWhenReady() {
            if (document.getElementById('submit-check-btn')) { __install(); return; }
            if (++__tries > 100) return;
            setTimeout(__installWhenReady, 150);
          }
          if (document.readyState !== 'loading') __installWhenReady();
          else document.addEventListener('DOMContentLoaded', __installWhenReady);
        })();
        `;
        content = content.replace('</body>', `<script>${authenticBridgeSnippet}</script>\n</body>`);
      }
    }

    // 2b. Safety net on top of the branch-specific handling above: fix any
    // mojibake from the source file's original encoding, and guarantee the
    // password/Test-Taker-ID gate is neutralized even if this file's function
    // names didn't match either branch above.
    // These files come from public Telegram channels and carry their branding:
    // a handle in the <title>, a watermark overlay, and a "join the channel"
    // button. Students sitting the teacher's paper should not be shown someone
    // else's channel, so the tags are stripped on upload rather than left for
    // each file to be hand-edited.
    const stripChannelTags = (html) => {
      let out = html;
      let removed = 0;
      const drop = (pattern, replacement = '') => {
        const before = out;
        out = out.replace(pattern, replacement);
        if (out !== before) removed += 1;
      };

      // Whole anchor elements that exist only to promote a channel.
      drop(/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*?(?:tg-icon|Join\s+[A-Za-z0-9_]+\s+on\s+Telegram)(?:(?!<\/a>)[\s\S])*?<\/a>/gi);
      // The watermark overlay's handle line and its "content protected" notice.
      drop(/<div class="t">\s*@[A-Za-z0-9_]{3,}\s*<\/div>/gi);
      // Any remaining bare @handle in visible text. CSS at-rules must survive,
      // so those names are excluded explicitly rather than matched loosely.
      drop(/@(?!media\b|keyframes\b|import\b|font-face\b|supports\b|charset\b|page\b|namespace\b|layer\b|container\b)[A-Za-z0-9_]{3,}/g);
      // Titles left as "Real Title | " once the handle above is gone.
      drop(/<title>([^<]*?)[\s|—-]+<\/title>/i, '<title>$1</title>');
      // Href mangled by the older Jasurbek/t.me replacements running in order.
      drop(/href="#[^"]*"/gi, 'href="#"');

      return { html: out, removed };
    };

    const tagStrip = stripChannelTags(content);
    content = tagStrip.html;
    if (tagStrip.removed > 0) {
      console.log(`Upload "${title}": stripped ${tagStrip.removed} channel-branding pattern(s).`);
    }

    const sanitized = sanitizeTestHtml(content);
    content = sanitized.html;
    if (sanitized.mojibakeFixedCount > 0) {
      console.log(`Upload "${title}": fixed ${sanitized.mojibakeFixedCount} mojibake span(s).`);
    }
    if (sanitized.gateRemoved) {
      console.log(`Upload "${title}": neutralized an embedded password/ID gate.`);
    }

    // 3. Persist the processed HTML in the database first. The file is only a fast local cache.
    const moduleData = {
      isIframe: true,
      iframeUrl: `/tests/${fileName}`,
      ...(usedHarvestBridge ? { bridgeType: 'harvest' } : {})
    };
    const targetColumn = moduleType === 'reading' ? 'reading_data' : 'listening_data';
    await db.run(`
      UPDATE tests
      SET ${targetColumn} = ?, html_content = ?
      WHERE id = ?
    `, [JSON.stringify(moduleData), content, testId]);

    // NOTE: do not declare the other module here.
    //
    // A previous version of this file did, reasoning that a single file holding
    // both answer keys "is" both modules. That is true of the paper but false of
    // the platform: StudentTestRunner renders one iframe per declared module, so
    // declaring both loaded this self-contained paper TWICE, side by side. A
    // student sat Listening in the first copy; pressing next advanced that copy
    // to its own Reading stage, while the Reading tab held a second copy still
    // showing Listening. The two never share state, and this template only posts
    // at the very end, so the whole sitting was lost.
    //
    // A module missing its declaration costs a band (fixed where scores are
    // computed, in /api/student/submit). Declaring one that should not exist
    // costs the exam. Never trade the second for the first.

    if (process.env.DISABLE_TEST_FILE_CACHE !== 'true') {
      try {
        fs.writeFileSync(filePath, content, 'utf8');
      } catch (fileError) {
        console.warn(`Could not cache ${fileName} on disk; database copy will be used:`, fileError.message);
      }
    }
    
    res.json({
      success: true,
      testId,
      mojibakeFixedCount: sanitized.mojibakeFixedCount,
      gateRemoved: sanitized.gateRemoved
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Point an existing test's Listening and/or Reading module at the iframe data
// of other already-uploaded (standalone template) test rows, without touching
// its writing_data. Used to rebuild a combined full-mock's modules from freshly
// uploaded source files -- e.g. after fixing broken listening_data/reading_data
// that never had a working iframeUrl -- while leaving its writing task intact.
// Find audio assets no test points at any more, and optionally delete them.
//
// Every reprocess of a listening test used to leave its whole track behind (now
// fixed at the source), so these accumulated: 225 MB of 320 MB on first run,
// most of it one 9.93 MB copy per debugging iteration of a single file.
//
// Dry run unless { confirm: true } is passed -- the report is the point, and
// deleting a track a test still needs would break that paper mid-exam.
//
// References are read from BOTH the database and server/public/tests on disk.
// mock1-9 ship as files with no html_content row, and a database-only check
// would call their audio orphaned and delete tracks that are actually in use.
app.post('/api/admin/audio-assets/sweep', requireRole('admin'), async (req, res) => {
  const confirm = req.body?.confirm === true;

  try {
    const assets = await db.all('SELECT id, mime_type, LENGTH(data_base64) AS len FROM test_audio_assets ORDER BY id');
    if (!assets.length) return res.json({ success: true, assets: 0, orphans: [], note: 'no audio assets stored' });

    const referenced = new Set();
    const rows = await db.all('SELECT html_content FROM tests WHERE html_content IS NOT NULL');
    for (const row of rows) {
      for (const m of String(row.html_content).matchAll(/\/tests-audio\/(\d+)/g)) referenced.add(m[1]);
    }
    try {
      const dir = path.join(__dirname, 'public', 'tests');
      for (const name of await fs.promises.readdir(dir)) {
        if (!name.endsWith('.html')) continue;
        const text = await fs.promises.readFile(path.join(dir, name), 'utf8');
        for (const m of text.matchAll(/\/tests-audio\/(\d+)/g)) referenced.add(m[1]);
      }
    } catch (e) {}

    const orphans = assets.filter(a => !referenced.has(String(a.id)));
    // base64 is 4 characters per 3 bytes.
    const mb = list => +(list.reduce((sum, a) => sum + Number(a.len || 0) * 0.75, 0) / 1024 / 1024).toFixed(1);

    let deleted = [];
    if (confirm) {
      for (const a of orphans) {
        await db.run('DELETE FROM test_audio_assets WHERE id = ?', [a.id]);
        for (const suffix of ['.bin', '.bin.type']) {
          try { await fs.promises.unlink(path.join(audioCacheDir, `${a.id}${suffix}`)); } catch (e) {}
        }
        deleted.push(a.id);
      }
    }

    res.json({
      success: true,
      dryRun: !confirm,
      assets: assets.length,
      inUse: { count: assets.length - orphans.length, approxMB: mb(assets.filter(a => referenced.has(String(a.id)))) },
      orphans: orphans.map(a => ({ id: a.id, approxMB: +(Number(a.len) * 0.75 / 1024 / 1024).toFixed(2) })),
      reclaimableMB: mb(orphans),
      deleted,
      note: confirm ? `deleted ${deleted.length} orphaned asset(s)` : 'dry run -- re-send with { "confirm": true } to delete'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a test row and reclaim its storage.
//
// The platform had no way to remove a test, so mistakes (a bad upload, a probe,
// a duplicate) accumulated as rows nobody could clear -- and a listening test
// pins a base64 audio asset that can be 15-20 MB, which matters on a database
// whose transfer quota has already been exhausted once.
//
// Refuses any test a student has actually sat: those rows are the record of
// someone's result, and losing them silently is far worse than a stale title in
// a dropdown. Unlink or rename such a test instead.
app.post('/api/admin/tests/:id/delete', requireRole('admin'), async (req, res) => {
  const testId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(testId)) return res.status(400).json({ error: 'Invalid test id' });

  try {
    const test = await db.get('SELECT id, title, listening_data, reading_data FROM tests WHERE id = ?', [testId]);
    if (!test) return res.status(404).json({ error: `Test ${testId} not found` });

    const subs = await db.get('SELECT COUNT(*) AS n FROM submissions WHERE test_id = ?', [testId]);
    if (Number(subs?.n || 0) > 0) {
      return res.status(409).json({
        error: `Test ${testId} ("${test.title}") has ${subs.n} submission(s) and will not be deleted. `
          + `Those rows are students' results. Rename the test instead if it should be retired.`
      });
    }

    // Assignments matter as much as submissions here. A test with no submissions
    // can still be sitting on dozens of students' dashboards waiting to be sat,
    // and deleting it takes the paper off their list with no trace of why. Caught
    // exactly this way in testing: the guard passed on a test that had no
    // submissions and 55 pending assignments, and removed it silently.
    //
    // Overridable, because clearing a genuinely bad upload is the whole point --
    // but it has to be asked for, and the count is named so the caller knows what
    // they are agreeing to.
    const assigned = await db.get('SELECT COUNT(*) AS n FROM assignments WHERE test_id = ?', [testId]);
    if (Number(assigned?.n || 0) > 0 && req.body?.force !== true) {
      return res.status(409).json({
        error: `Test ${testId} ("${test.title}") is assigned to ${assigned.n} student(s) who have not sat it yet. `
          + `Deleting it removes the paper from their dashboards. Re-send with { "force": true } to go ahead.`,
        assignments: Number(assigned.n)
      });
    }

    // The audio asset this test points at, if any. Only dropped when no other
    // test still references it -- combined tests deliberately share one asset by
    // pointing their modules at another test's file.
    const audioIds = new Set();
    for (const blob of [test.listening_data, test.reading_data]) {
      const m = /\/tests-audio\/(\d+)/.exec(String(blob || ''));
      if (m) audioIds.add(m[1]);
    }
    const page = await db.get('SELECT html_content FROM tests WHERE id = ?', [testId]);
    for (const m of String(page?.html_content || '').matchAll(/\/tests-audio\/(\d+)/g)) audioIds.add(m[1]);

    await db.run('DELETE FROM assignments WHERE test_id = ?', [testId]);
    await db.run('DELETE FROM tests WHERE id = ?', [testId]);

    const freed = [];
    for (const audioId of audioIds) {
      // Matched with the closing quote, because a bare LIKE '%/tests-audio/5%'
      // also matches /tests-audio/50 and /tests-audio/51. That direction is the
      // safe one -- it only ever declines to free an asset -- but it meant no
      // asset was ever reclaimed once ids reached two digits, which defeats the
      // point of deleting a 15 MB track.
      const others = await db.get(
        'SELECT COUNT(*) AS n FROM tests WHERE html_content LIKE ?',
        [`%/tests-audio/${audioId}"%`]
      );
      if (Number(others?.n || 0) === 0) {
        await db.run('DELETE FROM test_audio_assets WHERE id = ?', [audioId]);
        // The streaming route serves from an on-disk cache it materialises on
        // first request, and checks that cache before the database. Dropping only
        // the row therefore reclaims nothing and the track keeps streaming -- the
        // asset looks deleted while still being served.
        for (const suffix of ['.bin', '.bin.type']) {
          try { await fs.promises.unlink(path.join(audioCacheDir, `${audioId}${suffix}`)); } catch (e) {}
        }
        freed.push(Number(audioId));
      }
    }

    // A disk copy may exist too, but only remove it when this test was created by
    // an upload -- that copy is a cache of html_content and nothing else needs it.
    //
    // When html_content is NULL the file IS the test: mock1-9 ship in the repo as
    // source, with no database row behind them. Deleting one of those removes a
    // tracked file, which is what happened in testing before this check existed.
    if (page?.html_content) {
      try {
        const onDisk = path.join(__dirname, 'public', 'tests', `mock${testId}.html`);
        if (fs.existsSync(onDisk)) fs.unlinkSync(onDisk);
      } catch (e) {}
    }

    res.json({ success: true, deleted: testId, title: test.title, audioAssetsFreed: freed });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/tests/:id/link-modules', requireRole('admin'), async (req, res) => {
  const targetId = Number.parseInt(req.params.id, 10);
  const listeningFromTestId = Number.parseInt(req.body.listeningFromTestId, 10);
  const readingFromTestId = Number.parseInt(req.body.readingFromTestId, 10);
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'Invalid test id' });
  try {
    const target = await db.get('SELECT id FROM tests WHERE id = ?', [targetId]);
    if (!target) return res.status(404).json({ error: `Test ${targetId} not found` });

    if (Number.isInteger(listeningFromTestId)) {
      const src = await db.get('SELECT listening_data FROM tests WHERE id = ?', [listeningFromTestId]);
      if (!src || !src.listening_data) return res.status(404).json({ error: `Source listening test ${listeningFromTestId} not found` });
      await db.run('UPDATE tests SET listening_data = ? WHERE id = ?', [src.listening_data, targetId]);
    }
    if (Number.isInteger(readingFromTestId)) {
      const src = await db.get('SELECT reading_data FROM tests WHERE id = ?', [readingFromTestId]);
      if (!src || !src.reading_data) return res.status(404).json({ error: `Source reading test ${readingFromTestId} not found` });
      await db.run('UPDATE tests SET reading_data = ? WHERE id = ?', [src.reading_data, targetId]);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Updates only a test's writing_data (Task 1/2 prompts and Task 1 chart
// image), leaving listening_data/reading_data untouched. Exists for the same
// reason link-modules does above: a real incident where fixing Task 1's chart
// via /api/admin/sync-mock10 (which overwrites all three module fields from a
// stale JSON snapshot) silently reverted this test's listening/reading back
// to old broken native-format data, reproducing the exact crash it had
// before being rebuilt into iframe modules -- because that snapshot file was
// never updated after the rebuild. Fixing one module's content should never
// risk regressing another's.
app.post('/api/admin/tests/:id/writing-data', requireRole('admin'), async (req, res) => {
  const targetId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'Invalid test id' });
  const { writingData } = req.body;
  if (!writingData || typeof writingData !== 'object') {
    return res.status(400).json({ error: 'writingData object is required' });
  }
  try {
    const target = await db.get('SELECT id FROM tests WHERE id = ?', [targetId]);
    if (!target) return res.status(404).json({ error: `Test ${targetId} not found` });
    await db.run('UPDATE tests SET writing_data = ? WHERE id = ?', [JSON.stringify(writingData), targetId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// One-time data-repair endpoint (safe to call more than once -- it only ever
// acts on rows matching the exact bug signature below, so a second run is a
// no-op). Fixes a real, now-closed bug: before /api/student/submit/:testId
// correctly returned null for a module a test has no component for,
// standalone Listening-only (or Reading-only) test submissions had the OTHER
// score computed against an empty/undefined question set and stored as 0 --
// not null -- for that module. That's silently corrupt data, not a real
// score: getIeltsBand() can never naturally produce exactly 0 for a genuine
// attempt (it returns null for zero questions, or at minimum 3.0 for a very
// low but real one), so a stored 0 only ever means "this module never
// existed for this test." That in turn dragged the affected skill's average
// on the student's own dashboard toward 0 any time it was mixed with a
// genuinely-graded submission -- confirmed live across dozens of real
// students on production. Precisely nulls out listening_score/reading_score
// only where the submission's own test genuinely has no such module, rather
// than blanket-nulling every stored 0 (which the null-min-3.0 property makes
// safe to do broadly, but checking against the actual test definition is the
// more defensible fix and costs nothing extra here).
// Re-grade submissions that lost marks to the shared-checkbox-group bug, where
// a fully correct "choose two letters" pair scored zero because both halves
// harvested the same combined "C, D" string and were exact-matched against a
// single letter. The stored detail already contains everything needed to redo
// this: each question's picked set, its key, and the old verdict -- so marks are
// recomputed from what the student actually submitted, never invented.
// Supports ?dryRun=true, and is idempotent (re-running changes nothing further).
app.post('/api/admin/regrade-checkbox-pairs', requireRole('admin'), async (req, res) => {
  const dryRun = req.query.dryRun === 'true';
  // Same table the injected bridge uses (and identical to the templates' own
  // calculateBandScore), so bands only move because marks moved.
  const bandFor = (correct) => {
    // Official IELTS raw-score conversion. Every band below 4.5 used to
    // collapse to a flat 4.0, so a blank paper and 12/40 scored the same.
    var t = [[39,9],[37,8.5],[35,8],[32,7.5],[30,7],[26,6.5],[23,6],[18,5.5],[16,5],[13,4.5],[10,4],[6,3.5],[4,3],[0,2.5]];
    for (var i = 0; i < t.length; i++) { if (correct >= t[i][0]) return t[i][1]; }
    return 2.5;
  };

  const regradeDetail = (detail) => {
    const nums = Object.keys(detail).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
    const next = JSON.parse(JSON.stringify(detail));
    let changed = 0;
    let i = 0;
    while (i < nums.length) {
      const n = nums[i];
      const picked = String(detail[n]?.userAnswer ?? '');
      // A shared checkbox group shows up as consecutive questions carrying the
      // identical multi-value answer string -- that IS the group membership.
      if (!picked.includes(',')) { i += 1; continue; }
      const members = [n];
      let j = i + 1;
      while (j < nums.length && String(detail[nums[j]]?.userAnswer ?? '') === picked) {
        members.push(nums[j]);
        j += 1;
      }
      if (members.length > 1) {
        const correctSet = members.map(m => String(detail[m]?.correctAnswer ?? '').trim().toUpperCase());
        const chosen = picked.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
        const matchCount = chosen.filter(c => correctSet.includes(c)).length;
        members.forEach((m, pos) => {
          const shouldBe = matchCount >= pos + 1;
          if (!!next[m].isCorrect !== shouldBe) {
            next[m].isCorrect = shouldBe;
            changed += 1;
          }
        });
      }
      i = j;
    }
    return { next, changed };
  };

  try {
    const submissions = await db.all(`
      SELECT s.id, s.student_id, s.test_id, s.listening_score, s.reading_score,
             s.listening_detail, s.reading_detail, u.name AS student_name, t.title AS test_title
      FROM submissions s
      JOIN users u ON s.student_id = u.id
      JOIN tests t ON s.test_id = t.id
    `);

    const changes = [];
    const skipped = [];
    for (const sub of submissions) {
      for (const mod of ['listening', 'reading']) {
        const detail = parseJson(sub[`${mod}_detail`], null);
        if (!detail || typeof detail !== 'object' || !Object.keys(detail).length) continue;
        const oldCorrect = Object.values(detail).filter(d => d && d.isCorrect).length;
        const { next, changed } = regradeDetail(detail);
        if (!changed) continue;
        const storedBand = sub[`${mod}_score`];
        // Only touch a submission whose stored band this table actually
        // reproduces. Anything else was graded by different rules, and quietly
        // rewriting it would be a second bug rather than a fix.
        if (storedBand !== null && Math.abs(bandFor(oldCorrect) - Number(storedBand)) > 0.001) {
          skipped.push({
            submissionId: sub.id, student: sub.student_name, module: mod,
            reason: 'stored band does not match this band table',
            storedBand, bandFromStoredMarks: bandFor(oldCorrect)
          });
          continue;
        }
        const newCorrect = Object.values(next).filter(d => d && d.isCorrect).length;
        changes.push({
          submissionId: sub.id, studentId: sub.student_id, student: sub.student_name,
          test: sub.test_title, module: mod,
          marksRegained: newCorrect - oldCorrect,
          oldMarks: oldCorrect, newMarks: newCorrect,
          oldBand: storedBand, newBand: bandFor(newCorrect),
          _detail: next
        });
      }
    }

    if (!dryRun) {
      for (const c of changes) {
        await db.run(
          `UPDATE submissions SET ${c.module}_detail = ?, ${c.module}_score = ? WHERE id = ?`,
          [JSON.stringify(c._detail), c.newBand, c.submissionId]
        );
      }
    }

    res.json({
      success: true,
      dryRun,
      submissionsScanned: submissions.length,
      modulesChanged: changes.length,
      bandsChanged: changes.filter(c => Number(c.oldBand) !== c.newBand).length,
      skipped,
      changes: changes.map(({ _detail, ...rest }) => rest)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/fix-phantom-module-scores', requireRole('admin'), async (req, res) => {
  const dryRun = req.query.dryRun === 'true';
  try {
    const submissions = await db.all(`
      SELECT s.id, s.test_id, s.listening_score, s.reading_score, t.listening_data, t.reading_data
      FROM submissions s
      JOIN tests t ON s.test_id = t.id
      WHERE s.listening_score IS NOT NULL OR s.reading_score IS NOT NULL
    `);

    const hasListeningModule = (listeningData) => {
      const d = parseJson(listeningData, {});
      return d.isIframe === true || (Array.isArray(d.sections) && d.sections.length > 0);
    };
    const hasReadingModule = (readingData) => {
      const d = parseJson(readingData, {});
      return d.isIframe === true || (Array.isArray(d.passages) && d.passages.length > 0);
    };

    const toFix = [];
    for (const sub of submissions) {
      const clearListening = sub.listening_score !== null && !hasListeningModule(sub.listening_data);
      const clearReading = sub.reading_score !== null && !hasReadingModule(sub.reading_data);
      if (clearListening || clearReading) {
        toFix.push({ id: sub.id, testId: sub.test_id, clearListening, clearReading, oldListening: sub.listening_score, oldReading: sub.reading_score });
      }
    }

    if (!dryRun) {
      for (const fix of toFix) {
        if (fix.clearListening && fix.clearReading) {
          await db.run('UPDATE submissions SET listening_score = NULL, reading_score = NULL WHERE id = ?', [fix.id]);
        } else if (fix.clearListening) {
          await db.run('UPDATE submissions SET listening_score = NULL WHERE id = ?', [fix.id]);
        } else if (fix.clearReading) {
          await db.run('UPDATE submissions SET reading_score = NULL WHERE id = ?', [fix.id]);
        }
      }
    }

    res.json({ success: true, dryRun, submissionsScanned: submissions.length, submissionsFixed: toFix.length, details: toFix });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Toggle a test's navigation style: sequential-locked (Listening then Reading
// then Writing, one-way, no going back -- matching the real computer-delivered
// exam) vs the platform's normal free tab-switching between modules.
app.post('/api/admin/tests/:id/settings', requireRole('admin'), async (req, res) => {
  const targetId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'Invalid test id' });
  try {
    const target = await db.get('SELECT id FROM tests WHERE id = ?', [targetId]);
    if (!target) return res.status(404).json({ error: `Test ${targetId} not found` });
    if (typeof req.body.sequentialLock === 'boolean') {
      await db.run('UPDATE tests SET sequential_lock = ? WHERE id = ?', [req.body.sequentialLock ? 1 : 0, targetId]);
    }
    // A test's title is what teachers and students identify it by in every
    // list, and until now nothing could change it after upload -- a test named
    // during a hurried upload kept that name for good.
    if (typeof req.body.title === 'string') {
      const title = req.body.title.trim();
      if (!title) return res.status(400).json({ error: 'title cannot be empty' });
      await db.run('UPDATE tests SET title = ? WHERE id = ?', [title, targetId]);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Assignments list
app.get('/api/admin/assignments', requireRole('teacher', 'admin'), async (req, res) => {
  try {
    const scoped = req.authUser.role === 'admin' ? '' : 'WHERE u.owner_teacher_id = ?';
    const params = req.authUser.role === 'admin' ? [] : [req.authUser.id];
    const assignments = await db.all(`
      SELECT a.id, a.status, a.assigned_at, u.name as student_name, u.id as student_id, t.title as test_title, t.id as test_id
      FROM assignments a
      JOIN users u ON a.student_id = u.id
      JOIN tests t ON a.test_id = t.id
      ${scoped}
      ORDER BY a.assigned_at DESC
    `, params);
    res.json(assignments);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Assign Test
app.post('/api/admin/assign', requireRole('teacher', 'admin'), async (req, res) => {
  const { studentIds, testId, testIds } = req.body; // studentIds and testIds are arrays
  const targetTestIds = Array.isArray(testIds) ? testIds : (testId ? [testId] : []);
  try {
    if (req.authUser.role === 'teacher') {
      for (const sId of studentIds) {
        if (!(await canAccessStudent(req.authUser, sId))) {
          return res.status(403).json({ error: `Student ${sId} is not one of your students` });
        }
      }
    }
    const stmt = await db.prepare("INSERT INTO assignments (student_id, test_id, assigned_at) VALUES (?, ?, datetime('now'))");
    for (const sId of studentIds) {
      for (const tId of targetTestIds) {
        // Check if already assigned
        const exists = await db.get('SELECT 1 FROM assignments WHERE student_id = ? AND test_id = ? AND status != \'completed\'', [sId, tId]);
        if (!exists) {
          await stmt.run(sId, tId);
        }
      }
    }
    await stmt.finalize();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Bulk Import Students
app.post('/api/admin/users/bulk-import', requireRole('teacher', 'admin'), async (req, res) => {
  const { students, ownerTeacherId } = req.body; // Array of { id, name, password, groupName }
  if (!Array.isArray(students) || students.length === 0) {
    return res.status(400).json({ error: 'No students provided' });
  }
  // A teacher's import is always owned by themselves -- ownerTeacherId in the
  // request body is only honoured for an admin doing setup on a school's
  // behalf.
  const owner = req.authUser.role === 'teacher' ? req.authUser.id : (ownerTeacherId || 'mrGreen');
  const results = [];
  for (const s of students) {
    try {
      const hashedPassword = await hashPassword(s.password);
      await db.run(
        'INSERT INTO users (id, name, password_hash, role, group_name, owner_teacher_id) VALUES (?, ?, ?, ?, ?, ?)',
        [s.id, s.name, hashedPassword, 'student', s.groupName || null, owner]
      );
      // s.password (plaintext) is only echoed back in this response so the
      // admin can distribute it now; it is never stored or shown again.
      results.push({ id: s.id, name: s.name, password: s.password, groupName: s.groupName || '', status: 'created' });
    } catch (err) {
      results.push({ id: s.id, name: s.name, password: s.password, groupName: s.groupName || '', status: 'skipped (ID exists)' });
    }
  }
  res.json({ success: true, results });
});

// Delete Assignment
app.delete('/api/admin/assignments/:id', requireRole('teacher', 'admin'), async (req, res) => {
  const { id } = req.params;
  try {
    const asg = await db.get('SELECT student_id FROM assignments WHERE id = ?', [id]);
    if (asg && !(await canAccessStudent(req.authUser, asg.student_id))) {
      return res.status(403).json({ error: 'Not permitted for this assignment' });
    }
    await db.run('DELETE FROM assignments WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reset Assignment (set back to assigned so student can retake)
app.post('/api/admin/assignments/:id/reset', requireRole('teacher', 'admin'), async (req, res) => {
  const { id } = req.params;
  try {
    const asg = await db.get('SELECT * FROM assignments WHERE id = ?', [id]);
    if (!asg) return res.status(404).json({ error: 'Assignment not found' });
    if (!(await canAccessStudent(req.authUser, asg.student_id))) {
      return res.status(403).json({ error: 'Not permitted for this assignment' });
    }
    const latestSubmission = await db.get(`
      SELECT id FROM submissions
      WHERE student_id = ? AND test_id = ?
      ORDER BY id DESC LIMIT 1
    `, [asg.student_id, asg.test_id]);
    if (latestSubmission) {
      await db.run('DELETE FROM submissions WHERE id = ?', [latestSubmission.id]);
    }
    await db.run("UPDATE assignments SET status = 'assigned' WHERE id = ?", [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clear Pending/Uncompleted Assignments (PRESERVES student submissions & graded work)
app.post('/api/admin/assignments/clear-pending', requireRole('admin'), async (req, res) => {
  try {
    await db.run("DELETE FROM assignments WHERE status != 'completed'");
    await db.run("DELETE FROM speaking_assignments WHERE status != 'completed'");
    res.json({ success: true, message: 'Pending assignments cleared. Student completed submissions remain safe.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clear All Assignments & Submissions (Purge History)
app.all('/api/admin/assignments/clear-all', requireRole('admin'), async (req, res) => {
  try {
    await db.run('DELETE FROM assignments');
    await db.run('DELETE FROM speaking_assignments');
    await db.run('DELETE FROM submissions');
    await db.run('DELETE FROM speaking_submissions');
    res.json({ success: true, message: 'All test assignments and student submissions cleared successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Re-assign default tests to all active students
app.post('/api/admin/reassign-default-tests', requireRole('admin'), async (req, res) => {
  try {
    const students = await db.all("SELECT id FROM users WHERE role = 'student'");
    const tests = await db.all("SELECT id FROM tests");
    if (students.length === 0 || tests.length === 0) {
      return res.status(400).json({ error: 'No students or tests found to assign.' });
    }

    let count = 0;
    const stmt = await db.prepare("INSERT INTO assignments (student_id, test_id, assigned_at) VALUES (?, ?, datetime('now'))");
    for (const student of students) {
      for (const test of tests) {
        const exists = await db.get("SELECT 1 FROM assignments WHERE student_id = ? AND test_id = ? AND status != 'completed'", [student.id, test.id]);
        if (!exists) {
          await stmt.run(student.id, test.id);
          count++;
        }
      }
    }
    await stmt.finalize();
    res.json({ success: true, message: `Successfully assigned ${count} test(s) across ${students.length} candidates.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reseed Demo Submissions & Sample Essays
app.post('/api/admin/reseed-demo-submissions', requireRole('admin'), async (req, res) => {
  try {
    const firstTest = await db.get('SELECT id FROM tests ORDER BY id ASC LIMIT 1');
    if (!firstTest) return res.status(400).json({ error: 'No mock tests found in database.' });
    const firstTestId = firstTest.id;

    // Ensure demo students exist
    const demoStudents = [
      { id: 'UNI2026A', name: 'Aria Thorne', role: 'student', group_name: 'Group 1' },
      { id: 'UNI2026B', name: 'Brandon Lee', role: 'student', group_name: 'Group 1' },
      { id: 'UNI2026C', name: 'Chloe Varma', role: 'student', group_name: 'Group 2' }
    ];

    for (const s of demoStudents) {
      const u = await db.get('SELECT id FROM users WHERE id = ?', [s.id]);
      if (!u) {
        await db.run('INSERT INTO users (id, name, password_hash, role, group_name) VALUES (?, ?, ?, ?, ?)', [s.id, s.name, 'student123', s.role, s.group_name]);
      }
    }

    // Insert sample assignments & submissions
    await db.run("INSERT INTO assignments (student_id, test_id, assigned_at, status) VALUES ('UNI2026C', ?, datetime('now', '-3 days'), 'completed')", [firstTestId]).catch(() => {});
    await db.run("INSERT INTO assignments (student_id, test_id, assigned_at, status) VALUES ('UNI2026B', ?, datetime('now', '-1 days'), 'completed')", [firstTestId]).catch(() => {});

    await db.run(`
      INSERT INTO submissions (
        student_id, test_id, started_at, submitted_at, 
        listening_answers, reading_answers, writing_answers, 
        listening_score, reading_score, writing_scores, writing_score, 
        teacher_feedback, graded_by, is_revealed
      ) VALUES (
        'UNI2026C', ?, datetime('now', '-3 days'), datetime('now', '-3 days', '+2 hours'),
        ?, ?, ?,
        7.5, 8.0, ?, 7.5,
        'Excellent effort, Chloe! Your essay was well-structured with highly cohesive transitions. Your grammatical range is wide, but watch out for spelling slips.',
        'teacher', 1
      )
    `,
      firstTestId,
      JSON.stringify({ 1: "Aria", 2: "Thorne", 3: "CB21LQ", 4: "Student", 5: "15", 6: "B", 7: "A" }),
      JSON.stringify({ 11: "B", 12: "FALSE", 13: "FALSE", 14: "1999" }),
      JSON.stringify({
        task1: "The bar chart illustrates the count of students signing up for different language programs at a university from 2020 to 2024. Overall, Spanish remained the most popular subject throughout the timeframe, whereas German recorded the lowest enrollment rate...",
        task2: "Gaining knowledge is a multifaceted process. While academic books provide a structured foundation of theories, practical experience offers hands-on application. In my opinion, a balanced combination of both is the most effective approach..."
      }),
      JSON.stringify({ ta: 7.5, cc: 8.0, lr: 7.0, gra: 7.5 })
    ).catch(() => {});

    await db.run(`
      INSERT INTO submissions (
        student_id, test_id, started_at, submitted_at, 
        listening_answers, reading_answers, writing_answers, 
        listening_score, reading_score, is_revealed
      ) VALUES (
        'UNI2026B', ?, datetime('now', '-1 days'), datetime('now', '-1 days', '+2 hours'),
        ?, ?, ?,
        5.5, 6.0, 0
      )
    `,
      firstTestId,
      JSON.stringify({ 1: "John", 2: "Lee", 3: "CB21LQ", 4: "Adult", 5: "25", 6: "A", 7: "B" }),
      JSON.stringify({ 11: "A", 12: "TRUE", 13: "FALSE", 14: "1995" }),
      JSON.stringify({
        task1: "The chart shows language enrollment. Spanish is high. French is medium. German is low. French goes up and down. Spanish goes up...",
        task2: "I think books are good but practice is better. When you work you learn more than when you read. Many people go to school and don't know how to do job..."
      })
    ).catch(() => {});

    res.json({ success: true, message: 'Sample student submissions & graded essays restored successfully!' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});




// ----------------------------------------
// SPEAKING MODULE APIS
// ----------------------------------------

// Helper: AI Punctuation & Formatting Restorer for Speech Transcripts
async function punctuateTranscriptWithAI(rawText, aiSettings) {
  if (!rawText || rawText.includes('[No answer]') || rawText.trim().length < 5) return rawText;
  
  const systemPrompt = `You are a professional speech transcript editor. 
Your task is to take raw speech-to-text transcript (which lacks punctuation and capitalization) and restore natural punctuation (commas, full stops, question marks, capital letters).
CRITICAL RULES:
- Do NOT alter the candidate's choice of words or original grammar structures.
- Keep exact wording intact.
- Add natural commas, periods, question marks, and capitalization.
- Return ONLY the punctuated text without commentary.`;

  try {
    if (aiSettings.provider === 'claude' && aiSettings.anthropic_api_key) {
      const anthropic = new Anthropic({ apiKey: aiSettings.anthropic_api_key });
      const res = await anthropic.messages.create({
        model: 'claude-opus-5',
        max_tokens: 4000,
        // Restoring punctuation is mechanical, and this runs on every part of
        // every submission -- low effort keeps it quick and cheap.
        output_config: { effort: 'low' },
        system: systemPrompt,
        messages: [{ role: 'user', content: `Raw Speech Transcript:\n${rawText}` }]
      });
      const text = res.content.find((block) => block.type === 'text');
      return text ? text.text.trim() : rawText;
    } else if (aiSettings.provider === 'openai' && aiSettings.openai_api_key) {
      const openai = new OpenAI({ apiKey: aiSettings.openai_api_key });
      const res = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: rawText }
        ],
        max_tokens: 1000
      });
      return res.choices[0].message.content.trim();
    } else if (aiSettings.gemini_api_key) {
      const genAI = new GoogleGenerativeAI(aiSettings.gemini_api_key);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      const res = await model.generateContent(`${systemPrompt}\n\nRaw Speech Transcript:\n${rawText}`);
      return res.response.text().replace(/```\n?/g, '').trim();
    }
  } catch (e) {
    console.error('Punctuation auto-restoration failed:', e.message);
  }
  return rawText;
}

// Helper: evaluate speaking with AI
async function evaluateSpeaking(transcripts, aiSettings) {
  const { part1, part2, part3 } = transcripts;
  const combinedText = `
PART 1 (Interview):
${part1 || '[No response]'}

PART 2 (Long Turn):
${part2 || '[No response]'}

PART 3 (Discussion):
${part3 || '[No response]'}
  `.trim();

  const systemPrompt = `You are a certified IELTS Speaking examiner with 10+ years of experience.
Evaluate the candidate's Speaking test responses below strictly against official IELTS Band Descriptors (Bands 4.0–9.0).
Score each criterion to the nearest 0.5 band.

Return ONLY a valid JSON object with this exact structure:
{
  "fluency": <number>,
  "lexical": <number>,
  "grammar": <number>,
  "pronunciation": <number>,
  "overall": <number>,
  "feedback": {
    "fluency": "<one concise improvement tip>",
    "lexical": "<one concise improvement tip>",
    "grammar": "<one concise improvement tip>",
    "pronunciation": "<one concise improvement tip>",
    "overall": "<2-3 sentence overall assessment>"
  }
}
The "overall" score should be the mean of the four criteria rounded to the nearest 0.5.`;

  const userMessage = `Evaluate these IELTS Speaking responses:\n\n${combinedText}`;

  try {
    let raw;
    let provider;
    if (aiSettings.provider === 'claude' && aiSettings.anthropic_api_key) {
      const anthropic = new Anthropic({ apiKey: aiSettings.anthropic_api_key });
      const tip = { type: 'string' };
      const band = { type: 'number' };
      const response = await anthropic.messages.create({
        model: 'claude-opus-5',
        // Scoring against band descriptors is judgment work, so thinking is left
        // on (the default). max_tokens caps thinking and answer together, so it
        // is set well above the size of the JSON itself -- too tight a limit
        // truncates mid-answer rather than returning a short one.
        max_tokens: 16000,
        // The schema is enforced rather than requested, so the reply is always
        // parseable JSON with every score present. The old prompt-only approach
        // is what parseAiJsonResponse below exists to clean up after.
        output_config: {
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: {
                fluency: band, lexical: band, grammar: band,
                pronunciation: band, overall: band,
                feedback: {
                  type: 'object',
                  properties: {
                    fluency: tip, lexical: tip, grammar: tip,
                    pronunciation: tip, overall: tip
                  },
                  required: ['fluency', 'lexical', 'grammar', 'pronunciation', 'overall'],
                  additionalProperties: false
                }
              },
              required: ['fluency', 'lexical', 'grammar', 'pronunciation', 'overall', 'feedback'],
              additionalProperties: false
            }
          }
        },
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      });
      const text = response.content.find((block) => block.type === 'text');
      raw = text ? text.text : '';
      provider = 'claude';
    } else if (aiSettings.provider === 'openai' && aiSettings.openai_api_key) {
      const openai = new OpenAI({ apiKey: aiSettings.openai_api_key });
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        response_format: { type: 'json_object' },
        max_tokens: 600
      });
      raw = response.choices[0].message.content;
      provider = 'openai';
    } else if (aiSettings.gemini_api_key) {
      const genAI = new GoogleGenerativeAI(aiSettings.gemini_api_key);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      const result = await model.generateContent(`${systemPrompt}\n\n${userMessage}`);
      raw = result.response.text();
      provider = 'gemini';
    } else {
      throw new Error('No AI API key configured. Please add your Gemini or OpenAI key in Admin Settings.');
    }

    const parsed = parseAiJsonResponse(raw);
    const requiredFields = ['fluency', 'lexical', 'grammar', 'pronunciation', 'overall'];
    const missing = requiredFields.filter(f => typeof parsed[f] !== 'number');
    if (missing.length > 0) {
      throw new Error(`AI response is missing expected score field(s): ${missing.join(', ')}`);
    }

    // Force every score onto a real IELTS band increment -- the prompt asks the
    // AI to round to the nearest 0.5, but it doesn't reliably do that on its own
    // (e.g. returning 6.3). Overall is recomputed from the four already-rounded
    // criteria rather than trusting the AI's separately-reported overall value,
    // so the displayed overall always matches its own sub-scores.
    parsed.fluency = roundIelts(parsed.fluency);
    parsed.lexical = roundIelts(parsed.lexical);
    parsed.grammar = roundIelts(parsed.grammar);
    parsed.pronunciation = roundIelts(parsed.pronunciation);
    parsed.overall = roundIelts(
      (parsed.fluency + parsed.lexical + parsed.grammar + parsed.pronunciation) / 4
    );

    return { result: parsed, provider };
  } catch (err) {
    throw new Error(`AI evaluation failed: ${err.message}`);
  }
}

// Parses a JSON object out of an LLM response, tolerating markdown code fences
// and any stray text the model adds despite instructions to return only JSON.
function parseAiJsonResponse(text) {
  const cleaned = String(text || '').replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {}
    }
    throw new Error('AI did not return valid JSON');
  }
}

// Admin Settings — Get
app.get('/api/admin/settings', requireRole('admin'), async (req, res) => {
  try {
    const settings = await db.get('SELECT * FROM ai_settings LIMIT 1');
    // Don't expose full keys — mask them
    if (settings) {
      settings.gemini_api_key_set = !!(settings.gemini_api_key);
      settings.openai_api_key_set = !!(settings.openai_api_key);
      settings.anthropic_api_key_set = !!(settings.anthropic_api_key);
      delete settings.gemini_api_key;
      delete settings.openai_api_key;
      delete settings.anthropic_api_key;
    }
    res.json(settings || {
      provider: 'gemini',
      gemini_api_key_set: false,
      openai_api_key_set: false,
      anthropic_api_key_set: false
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin Settings — Update
app.post('/api/admin/settings', requireRole('admin'), async (req, res) => {
  const { provider, gemini_api_key, openai_api_key, anthropic_api_key } = req.body;
  try {
    const existing = await db.get('SELECT id FROM ai_settings LIMIT 1');
    if (existing) {
      const updates = ['provider = ?', "updated_at = CURRENT_TIMESTAMP"];
      const vals = [provider];
      if (gemini_api_key !== undefined && gemini_api_key !== '') {
        updates.push('gemini_api_key = ?'); vals.push(gemini_api_key);
      }
      if (openai_api_key !== undefined && openai_api_key !== '') {
        updates.push('openai_api_key = ?'); vals.push(openai_api_key);
      }
      // Blank means "keep the stored key", matching the other two -- the form
      // never receives the saved value back, so an empty field is the normal
      // state when changing any other setting.
      if (anthropic_api_key !== undefined && anthropic_api_key !== '') {
        updates.push('anthropic_api_key = ?'); vals.push(anthropic_api_key);
      }
      vals.push(existing.id);
      await db.run(`UPDATE ai_settings SET ${updates.join(', ')} WHERE id = ?`, vals);
    } else {
      await db.run(
        'INSERT INTO ai_settings (provider, gemini_api_key, openai_api_key, anthropic_api_key) VALUES (?, ?, ?, ?)',
        [provider, gemini_api_key || null, openai_api_key || null, anthropic_api_key || null]
      );
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Speaking Prompts — List
// Read-only and unscoped for teachers too, same reasoning as /api/admin/tests
// -- speaking prompts are shared content, authored by admin.
app.get('/api/admin/speaking/prompts', requireRole('teacher', 'admin'), async (req, res) => {
  try {
    const prompts = await db.all('SELECT * FROM speaking_prompts ORDER BY created_at DESC');
    res.json(prompts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Speaking Prompts — Create
app.post('/api/admin/speaking/prompts', requireRole('admin'), async (req, res) => {
  const { title, part1Questions, part2CueCard, part3Questions } = req.body;
  if (!title || !part1Questions || !part2CueCard || !part3Questions) {
    return res.status(400).json({ error: 'All prompt fields are required' });
  }
  try {
    await db.run(
      'INSERT INTO speaking_prompts (title, part1_questions, part2_cue_card, part3_questions) VALUES (?, ?, ?, ?)',
      [title, JSON.stringify(part1Questions), part2CueCard, JSON.stringify(part3Questions)]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Speaking Prompts — Delete
app.delete('/api/admin/speaking/prompts/:id', requireRole('admin'), async (req, res) => {
  try {
    await db.run('DELETE FROM speaking_prompts WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Speaking Assign — Assign prompt to students
app.post('/api/admin/speaking/assign', requireRole('teacher', 'admin'), async (req, res) => {
  const { studentIds, promptId } = req.body;
  if (!Array.isArray(studentIds) || !promptId) {
    return res.status(400).json({ error: 'studentIds array and promptId required' });
  }
  if (req.authUser.role === 'teacher') {
    for (const sId of studentIds) {
      if (!(await canAccessStudent(req.authUser, sId))) {
        return res.status(403).json({ error: `Student ${sId} is not one of your students` });
      }
    }
  }
  try {
    for (const sId of studentIds) {
      const exists = await db.get('SELECT 1 FROM speaking_assignments WHERE student_id = ? AND prompt_id = ? AND status = ?', [sId, promptId, 'assigned']);
      if (!exists) {
        await db.run("INSERT INTO speaking_assignments (student_id, prompt_id) VALUES (?, ?)", [sId, promptId]);
      }
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Student — Get speaking assignments
app.get('/api/speaking/assignments/:studentId', requireAuth, async (req, res) => {
  if (!(await canAccessStudent(req.authUser, req.params.studentId))) return res.status(403).json({ error: 'Not permitted for this student' });
  try {
    const assignments = await db.all(`
      SELECT sa.id, sa.status, sa.assigned_at,
             sp.id as prompt_id, sp.title, sp.part1_questions, sp.part2_cue_card, sp.part3_questions
      FROM speaking_assignments sa
      JOIN speaking_prompts sp ON sa.prompt_id = sp.id
      WHERE sa.student_id = ?
      ORDER BY sa.assigned_at DESC
    `, [req.params.studentId]);
    res.json(assignments);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Student — Get their own speaking results
app.get('/api/speaking/results/:studentId', requireAuth, async (req, res) => {
  if (!(await canAccessStudent(req.authUser, req.params.studentId))) return res.status(403).json({ error: 'Not permitted for this student' });
  try {
    const results = await db.all(`
      SELECT ss.*, sp.title as prompt_title
      FROM speaking_submissions ss
      JOIN speaking_prompts sp ON ss.prompt_id = sp.id
      WHERE ss.student_id = ? AND ss.is_revealed = 1
      ORDER BY ss.submitted_at DESC
    `, [req.params.studentId]);
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Student — Submit speaking test (transcripts only — audio recorded in browser)
app.post('/api/speaking/submit', requireAuth, async (req, res) => {
  const { studentId, promptId, assignmentId, part1Transcript, part2Transcript, part3Transcript } = req.body;
  if (!studentId || !promptId) {
    return res.status(400).json({ error: 'studentId and promptId required' });
  }
  if (!(await canAccessStudent(req.authUser, studentId))) return res.status(403).json({ error: 'Not permitted for this student' });
  try {
    // Get AI settings
    const aiSettings = await db.get('SELECT * FROM ai_settings LIMIT 1');
    if (!aiSettings) return res.status(500).json({ error: 'AI settings not configured' });

    // Auto-restore natural punctuation, commas, full stops & capitalization using AI
    const cleanPart1 = await punctuateTranscriptWithAI(part1Transcript, aiSettings);
    const cleanPart2 = await punctuateTranscriptWithAI(part2Transcript, aiSettings);
    const cleanPart3 = await punctuateTranscriptWithAI(part3Transcript, aiSettings);

    // Evaluate with AI
    const { result, provider } = await evaluateSpeaking(
      { part1: cleanPart1, part2: cleanPart2, part3: cleanPart3 },
      aiSettings
    );

    // Save submission (is_revealed defaults to 0 until teacher sends to student)
    await db.run(`
      INSERT INTO speaking_submissions 
        (student_id, prompt_id, part1_transcript, part2_transcript, part3_transcript,
         fluency_score, lexical_score, grammar_score, pronunciation_score, overall_score, ai_feedback, ai_provider, is_revealed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `, [
      studentId, promptId,
      cleanPart1 || '', cleanPart2 || '', cleanPart3 || '',
      result.fluency, result.lexical, result.grammar, result.pronunciation, result.overall,
      JSON.stringify(result.feedback), provider
    ]);

    // Mark assignment as submitted
    if (assignmentId) {
      await db.run("UPDATE speaking_assignments SET status = 'submitted' WHERE id = ?", [assignmentId]);
    }

    res.json({ success: true, message: 'Submitted for teacher review' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper: Transcribe recorded audio file using OpenAI Whisper API
async function transcribeAudioWithWhisper(audioBuffer, ext, aiSettings) {
  if (!audioBuffer || audioBuffer.length < 100) return { text: '', publicUrl: null };
  
  const uploadsDir = path.join(__dirname, 'public', 'uploads', 'audio');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

  const tempFileName = `speaking_${Date.now()}_${Math.random().toString(36).substring(7)}.${ext || 'webm'}`;
  const tempFilePath = path.join(uploadsDir, tempFileName);
  fs.writeFileSync(tempFilePath, audioBuffer);

  const publicUrl = `/uploads/audio/${tempFileName}`;

  let text = '';
  try {
    if (aiSettings.openai_api_key) {
      const openai = new OpenAI({ apiKey: aiSettings.openai_api_key });
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tempFilePath),
        model: 'whisper-1',
        language: 'en'
      });
      text = transcription.text ? transcription.text.trim() : '';
    }
  } catch (err) {
    console.error('Whisper transcription error:', err.message);
  }

  return { text, publicUrl };
}

function bufferFromBase64Audio(base64) {
  if (!base64) return null;
  return Buffer.from(base64.replace(/^data:audio\/\w+;base64,/, ''), 'base64');
}

// Student — Submit speaking test WITH RECORDED AUDIO blobs (OpenAI Whisper pipeline)
//
// Saving the submission happens BEFORE AI scoring, and the two are independent:
// transcription/punctuation/scoring calls run in parallel where possible, and if
// AI scoring fails after a successful save, the submission still exists with
// scores left null ("pending grading") instead of being silently discarded --
// a teacher can grade it manually via the existing Grade/Edit flow. Previously
// a single failed AI call anywhere in this chain (rate limit, malformed JSON,
// network blip) meant the whole submission -- audio and all -- was lost.
app.post('/api/speaking/submit-audio', requireAuth, async (req, res) => {
  const { studentId, promptId, assignmentId, part1AudioBase64, part2AudioBase64, part3AudioBase64, part1Transcript, part2Transcript, part3Transcript } = req.body;

  if (!studentId || !promptId) {
    return res.status(400).json({ error: 'studentId and promptId required' });
  }
  if (!(await canAccessStudent(req.authUser, studentId))) return res.status(403).json({ error: 'Not permitted for this student' });

  try {
    const aiSettings = await db.get('SELECT * FROM ai_settings LIMIT 1');
    if (!aiSettings) return res.status(500).json({ error: 'AI settings not configured' });

    // Transcribe all three parts in parallel -- they're independent of each other.
    const emptyTranscription = { text: '', publicUrl: null };
    const [t1, t2, t3] = await Promise.all([
      part1AudioBase64 ? transcribeAudioWithWhisper(bufferFromBase64Audio(part1AudioBase64), 'webm', aiSettings) : Promise.resolve(emptyTranscription),
      part2AudioBase64 ? transcribeAudioWithWhisper(bufferFromBase64Audio(part2AudioBase64), 'webm', aiSettings) : Promise.resolve(emptyTranscription),
      part3AudioBase64 ? transcribeAudioWithWhisper(bufferFromBase64Audio(part3AudioBase64), 'webm', aiSettings) : Promise.resolve(emptyTranscription)
    ]);

    // Punctuate all three in parallel, same reasoning.
    const [finalPart1Text, finalPart2Text, finalPart3Text] = await Promise.all([
      punctuateTranscriptWithAI(t1.text || part1Transcript || '', aiSettings),
      punctuateTranscriptWithAI(t2.text || part2Transcript || '', aiSettings),
      punctuateTranscriptWithAI(t3.text || part3Transcript || '', aiSettings)
    ]);

    // Save the submission now -- guaranteed, no dependency on AI scoring succeeding.
    const insertResult = await db.run(`
      INSERT INTO speaking_submissions
        (student_id, prompt_id, part1_transcript, part2_transcript, part3_transcript, is_revealed,
         part1_audio, part2_audio, part3_audio)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
    `, [
      studentId, promptId,
      finalPart1Text || '', finalPart2Text || '', finalPart3Text || '',
      t1.publicUrl, t2.publicUrl, t3.publicUrl
    ]);
    const submissionId = insertResult.lastID;

    if (assignmentId) {
      await db.run("UPDATE speaking_assignments SET status = 'submitted' WHERE id = ?", [assignmentId]);
    }

    // Attempt AI scoring as a best-effort second step. The submission above is
    // already safe regardless of what happens here.
    let scores = null;
    try {
      const { result, provider } = await evaluateSpeaking(
        { part1: finalPart1Text, part2: finalPart2Text, part3: finalPart3Text },
        aiSettings
      );
      await db.run(`
        UPDATE speaking_submissions
        SET fluency_score = ?, lexical_score = ?, grammar_score = ?, pronunciation_score = ?, overall_score = ?, ai_feedback = ?, ai_provider = ?
        WHERE id = ?
      `, [result.fluency, result.lexical, result.grammar, result.pronunciation, result.overall, JSON.stringify(result.feedback), provider, submissionId]);
      scores = result;
    } catch (scoringError) {
      console.error(`Speaking submission ${submissionId} saved, but AI scoring failed:`, scoringError.message);
    }

    res.json({
      success: true,
      submissionId,
      scores,
      gradingPending: !scores,
      message: scores
        ? 'Submitted and evaluated successfully'
        : 'Submitted successfully. AI grading is temporarily unavailable, so your teacher will grade this one manually.'
    });
  } catch (error) {
    console.error('Submit audio error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Teacher — List all speaking submissions (pending reveal)
app.get('/api/teacher/speaking', requireRole('teacher', 'admin'), async (req, res) => {
  try {
    const scoped = req.authUser.role === 'admin' ? '' : 'WHERE u.owner_teacher_id = ?';
    const params = req.authUser.role === 'admin' ? [] : [req.authUser.id];
    const submissions = await db.all(`
      SELECT ss.*, u.name as student_name, sp.title as prompt_title
      FROM speaking_submissions ss
      JOIN users u ON ss.student_id = u.id
      JOIN speaking_prompts sp ON ss.prompt_id = sp.id
      ${scoped}
      ORDER BY ss.submitted_at DESC
    `, params);
    res.json(submissions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Teacher — Send/reveal score to student
app.post('/api/teacher/speaking/:id/send', requireRole('teacher', 'admin'), async (req, res) => {
  if (!(await canAccessSpeakingSubmission(req.authUser, req.params.id))) return res.status(403).json({ error: 'Not permitted for this submission' });
  try {
    await db.run('UPDATE speaking_submissions SET is_revealed = 1 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Teacher — Edit/Override speaking scores & feedback
app.post('/api/teacher/speaking/:id/update', requireRole('teacher', 'admin'), async (req, res) => {
  if (!(await canAccessSpeakingSubmission(req.authUser, req.params.id))) return res.status(403).json({ error: 'Not permitted for this submission' });
  const { fluency, lexical, grammar, pronunciation, overall, feedback } = req.body;
  try {
    await db.run(`
      UPDATE speaking_submissions
      SET fluency_score = ?, lexical_score = ?, grammar_score = ?, pronunciation_score = ?, overall_score = ?, ai_feedback = ?
      WHERE id = ?
    `, [
      roundIelts(fluency), roundIelts(lexical), roundIelts(grammar), roundIelts(pronunciation), roundIelts(overall),
      typeof feedback === 'string' ? feedback : JSON.stringify(feedback),
      req.params.id
    ]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin / Teacher — Reset student speaking test assignment for re-take
app.post('/api/admin/speaking/reset/:studentId', requireRole('teacher', 'admin'), async (req, res) => {
  const { studentId } = req.params;
  if (!(await canAccessStudent(req.authUser, studentId))) return res.status(403).json({ error: 'Not permitted for this student' });
  try {
    await db.run('DELETE FROM speaking_submissions WHERE student_id = ?', [studentId]);
    await db.run('UPDATE speaking_assignments SET status = "assigned" WHERE student_id = ?', [studentId]);
    res.json({ success: true, message: `Speaking assignment reset for ${studentId}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

app.use((error, req, res, next) => {
  console.error('Unhandled request error:', error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Unexpected server error' });
});

// Serve built static React client files in production
const distPath = path.join(__dirname, '../client/dist');
app.use(express.static(distPath));

// Fallback to React router for all other client requests
app.get('*', (req, res, next) => {
  // If requesting api, public tests, or uploads, let it go through
  if (req.url.startsWith('/api') || req.url.startsWith('/tests') || req.url.startsWith('/uploads')) {
    return next();
  }
  res.sendFile(path.join(distPath, 'index.html'));
});

const server = app.listen(port, () => {
  console.log(`Backend server running on port ${port}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; shutting down cleanly.`);

  const forceExitTimer = setTimeout(() => process.exit(1), 10_000);
  forceExitTimer.unref();

  server.close(async () => {
    try {
      await db.close?.();
      clearTimeout(forceExitTimer);
      process.exit(0);
    } catch (error) {
      console.error('Database shutdown failed:', error);
      process.exit(1);
    }
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

export { app, server, db };
