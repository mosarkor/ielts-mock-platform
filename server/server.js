import express from 'express';
import cors from 'cors';
import { initDb } from './database.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import { sanitizeTestHtml } from './contentSanitizer.js';
import { hashPassword, verifyPassword } from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const configuredPort = Number.parseInt(process.env.PORT, 10);
const port = Number.isInteger(configuredPort) && configuredPort >= 0 ? configuredPort : 5000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Database connection
let db;
try {
  db = await initDb();
  console.log('Database initialized successfully.');
} catch (error) {
  console.error('Failed to initialize database:', error);
  process.exitCode = 1;
  throw error;
}

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
    res.set('Cache-Control', 'no-store');
    res.type('html').send(test.html_content);
  } catch (error) {
    next(error);
  }
});

// Serves listening audio that was extracted out of an uploaded test's HTML
// (see the harvest-bridge upload path below) -- stored in the database, same
// as the test HTML itself, so it survives an ephemeral deploy filesystem.
// Supports Range requests, since <audio> relies on them for real streaming
// and seeking rather than blocking on the whole file up front.
app.get('/tests-audio/:id', async (req, res, next) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return next();

  try {
    const asset = await db.get('SELECT mime_type, data_base64 FROM test_audio_assets WHERE id = ?', [id]);
    if (!asset) return next();

    const buffer = Buffer.from(asset.data_base64, 'base64');
    const total = buffer.length;
    res.set('Accept-Ranges', 'bytes');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(asset.mime_type);

    const range = req.headers.range;
    if (!range) {
      res.set('Content-Length', total);
      res.status(200).send(buffer);
      return;
    }

    const match2 = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match2) {
      res.status(416).set('Content-Range', `bytes */${total}`).end();
      return;
    }
    let start = match2[1] ? Number.parseInt(match2[1], 10) : 0;
    let end = match2[2] ? Number.parseInt(match2[2], 10) : total - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= total) {
      res.status(416).set('Content-Range', `bytes */${total}`).end();
      return;
    }
    res.status(206);
    res.set('Content-Range', `bytes ${start}-${end}/${total}`);
    res.set('Content-Length', end - start + 1);
    res.send(buffer.subarray(start, end + 1));
  } catch (error) {
    next(error);
  }
});

// ----------------------------------------
// AUTHENTICATION
// ----------------------------------------
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

    return res.json({ id: user.id, name: user.name, role: user.role });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Change Password API
app.post('/api/user/change-password', async (req, res) => {
  const { userId, currentPassword, newPassword } = req.body;
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

// ----------------------------------------
// STUDENT APIS
// ----------------------------------------

// Get Student Dashboard Info
app.get('/api/student/dashboard/:studentId', async (req, res) => {
  const { studentId } = req.params;

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
    const submissions = submissionRows.map((sub) => ({
      ...sub,
      listening_answers: parseJson(sub.listening_answers, {}),
      reading_answers: parseJson(sub.reading_answers, {}),
      writing_answers: parseJson(sub.writing_answers, {}),
      listening_detail: parseJson(sub.listening_detail, null),
      reading_detail: parseJson(sub.reading_detail, null),
      writing_scores: parseJson(sub.writing_scores, null)
    }));

    res.json({ assignments, submissions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get detailed test data (questions only, omit answer keys if needed, but for simplicity we send full content)
app.get('/api/student/test/:testId', async (req, res) => {
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
      sequentialLock: !!Number(test.sequential_lock)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Submit Test Answers
app.post('/api/student/submit/:testId', async (req, res) => {
  const { testId } = req.params;
  const studentId = typeof req.body.studentId === 'string' ? req.body.studentId.trim() : '';
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
    const student = await db.get("SELECT id FROM users WHERE id = ? AND role = 'student'", [studentId]);
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
      if (ratio >= 0.95) return 9.0;
      if (ratio >= 0.85) return 8.0;
      if (ratio >= 0.75) return 7.5;
      if (ratio >= 0.65) return 7.0;
      if (ratio >= 0.55) return 6.0;
      if (ratio >= 0.45) return 5.5;
      if (ratio >= 0.35) return 5.0;
      if (ratio >= 0.25) return 4.5;
      if (ratio >= 0.15) return 4.0;
      return 3.0;
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
    const listeningScore = isListeningIframe
      ? validBand(req.body.listeningScore)
      : scoreQuestions(listeningData.sections, listeningAnswers);
    const readingScore = isReadingIframe
      ? validBand(req.body.readingScore)
      : scoreQuestions(readingData.passages, readingAnswers);

    // Every submission -- full mock or standalone listening/reading -- stays
    // hidden from the student until the teacher explicitly releases it via
    // /api/teacher/reveal. (Previously, tests whose title contained the word
    // "listening" or "reading" bypassed this and auto-revealed instantly.)
    const defaultIsRevealed = 0;

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

app.get('/api/student/submission-status/:studentId/:testId', async (req, res) => {
  const { studentId, testId } = req.params;
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
app.post('/api/student/assignment/start', async (req, res) => {
  const { studentId, testId } = req.body;
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
app.get('/api/teacher/submissions', async (req, res) => {
  try {
    const submissions = await db.all(`
      SELECT s.*, u.name as student_name, u.group_name as student_group, t.title as test_title, t.listening_data, t.reading_data, t.writing_data
      FROM submissions s
      JOIN users u ON s.student_id = u.id
      JOIN tests t ON s.test_id = t.id
      ORDER BY s.submitted_at DESC
    `);
    res.json(submissions.map(sub => ({
      ...sub,
      listening_answers: JSON.parse(sub.listening_answers || '{}'),
      reading_answers: JSON.parse(sub.reading_answers || '{}'),
      writing_answers: JSON.parse(sub.writing_answers || '{}'),
      writing_scores: JSON.parse(sub.writing_scores || 'null'),
      // Per-question {userAnswer, correctAnswer, isCorrect, explanationHtml},
      // harvested from standalone iframe modules that support it -- the
      // student dashboard already reads these; the teacher dashboard never
      // did, so the only per-question review it could show was for the old
      // single-file mock1-9 templates, nothing for any harvest-bridge test.
      listening_detail: parseJson(sub.listening_detail, null),
      reading_detail: parseJson(sub.reading_detail, null),
      test_writing_data: JSON.parse(sub.writing_data || '{}')
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Grade writing submission
app.post('/api/teacher/grade/:submissionId', async (req, res) => {
  const { submissionId } = req.params;
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

  try {
    const writingScore = calculateOverallWritingBand(writingScores);

    await db.run(`
      UPDATE submissions
      SET writing_scores = ?,
          writing_score = ?,
          teacher_feedback = ?,
          graded_by = ?
      WHERE id = ?
    `, [JSON.stringify(writingScores), writingScore, teacherFeedback, gradedBy, submissionId]);

    res.json({ success: true, writingScore });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reveal score
app.post('/api/teacher/reveal/:submissionId', async (req, res) => {
  const { submissionId } = req.params;
  const { isRevealed } = req.body; // 1 or 0
  try {
    await db.run('UPDATE submissions SET is_revealed = ? WHERE id = ?', [isRevealed ? 1 : 0, submissionId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------
// ADMIN APIS
// ----------------------------------------

// Admin Overview Metrics
app.get('/api/admin/overview', async (req, res) => {
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
app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await db.all('SELECT id, name, role, group_name as groupName FROM users');
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reset user password
app.post('/api/admin/users/reset-password', async (req, res) => {
  const { userId, newPassword } = req.body;
  try {
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(newPassword), userId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add user
app.post('/api/admin/users', async (req, res) => {
  const { id, name, role, password, groupName } = req.body;
  try {
    const hashedPassword = await hashPassword(password || 'student123');
    await db.run('INSERT INTO users (id, name, password_hash, role, group_name) VALUES (?, ?, ?, ?, ?)', [id, name, hashedPassword, role, groupName || null]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'User ID already exists or invalid data' });
  }
});

// Delete user
app.delete('/api/admin/users/:id', async (req, res) => {
  const { id } = req.params;
  try {
    if (id === 'admin') {
      return res.status(400).json({ error: 'Cannot delete primary administrator account' });
    }
    await db.run('DELETE FROM users WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get tests list
app.get('/api/admin/tests', async (req, res) => {
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
app.all('/api/admin/sync-mock10', async (req, res) => {
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
app.post('/api/admin/tests', async (req, res) => {
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
app.post('/api/admin/upload-test', async (req, res) => {
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
        const assetResult = await db.run(
          'INSERT INTO test_audio_assets (mime_type, data_base64) VALUES (?, ?)',
          [mimeType, base64Data]
        );
        content = content.replace(fullMatch, `src="/tests-audio/${assetResult.lastID}"`);
      }
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
          if (correct >= 39) return 9.0;
          if (correct >= 37) return 8.5;
          if (correct >= 35) return 8.0;
          if (correct >= 32) return 7.5;
          if (correct >= 30) return 7.0;
          if (correct >= 27) return 6.5;
          if (correct >= 23) return 6.0;
          if (correct >= 20) return 5.5;
          if (correct >= 16) return 5.0;
          if (correct >= 13) return 4.5;
          return 4.0;
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
           const finishWritingTarget = /function finishWriting\(\)\{\s*clearInterval\(state\.wTimerInterval\);\s*hide\(\$\("screen-test"\)\);\s*hide\(\$\("screen-transition"\)\);\s*buildFinalReport\(\);\s*show\(\$\("screen-results"\)\);\s*\}/;
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
          if (correct >= 39) return 9.0;
          if (correct >= 37) return 8.5;
          if (correct >= 35) return 8.0;
          if (correct >= 32) return 7.5;
          if (correct >= 30) return 7.0;
          if (correct >= 27) return 6.5;
          if (correct >= 23) return 6.0;
          if (correct >= 20) return 5.5;
          if (correct >= 16) return 5.0;
          if (correct >= 13) return 4.5;
          return 4.0;
        };

        fetch('/api/student/submit/' + tId, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            studentId: sId,
            listeningAnswers,
            readingAnswers,
            writingAnswers,
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
      content = content.replace(finishWritingTarget, finishWritingReplacement);
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
        function __getCorrectAnswers() {
          return (typeof correctAnswers !== 'undefined') ? correctAnswers : window.correctAnswers;
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
              var parts = groupName.slice(1).split('_').map(Number);
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
                correctSet = parts
                  .map(function (p) { return __ca[String(p)]; })
                  .filter(function (v) { return typeof v === 'string' && v; });
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

        function __silentCheckAndReport() {
          var answers = {};
          var detail = {};
          var correctCount = 0;
          // Safe to look up (and cache for this whole run) only now -- this only
          // ever runs once the student clicks the button, long after the
          // template's own DOMContentLoaded handler has had every chance to run.
          var __correctAnswers = __getCorrectAnswers();
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
            if (correct >= 39) return 9.0;
            if (correct >= 37) return 8.5;
            if (correct >= 35) return 8.0;
            if (correct >= 32) return 7.5;
            if (correct >= 30) return 7.0;
            if (correct >= 26) return 6.5;
            if (correct >= 23) return 6.0;
            if (correct >= 18) return 5.5;
            if (correct >= 16) return 5.0;
            if (correct >= 13) return 4.5;
            return 4.0;
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
          try { if (typeof timerInterval !== 'undefined' && timerInterval) clearInterval(timerInterval); } catch (e) {}
          try { if (typeof timerRunning !== 'undefined') timerRunning = false; } catch (e) {}
          document.querySelectorAll('audio').forEach(function(a) { try { a.pause(); } catch (e) {} });
          document.querySelectorAll('input, select, textarea').forEach(function(el) { el.disabled = true; });

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

        function __installBridge() {
          __enforceNoAudioPause();
          __reclaimHeaderSpace();
          // __shrinkPartBanner() disabled: real students reported broken passage
          // switching (stuck on the same question across all passages) and answers
          // that couldn't be selected, both on Reading-27-family tests shortly after
          // this shipped. It repositions the passage/questions container every time
          // the banner's own content changes -- which is exactly what happens when a
          // student switches Part 1/2/3 -- so it's the leading suspect for interfering
          // with the template's own passage-switch rendering. It only ever saved a
          // modest amount of vertical space; not worth the risk until it's been
          // isolated and fixed with a live repro, not just re-shipped on a guess.
          // __shrinkPartBanner();
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
          freshBtn.onclick = function() {
            if (freshBtn.dataset.bridgeSubmitted === '1') return;
            freshBtn.dataset.bridgeSubmitted = '1';
            __silentCheckAndReport();
            freshBtn.textContent = '✓ Section Completed';
            freshBtn.disabled = true;
            freshBtn.style.opacity = '0.6';
            freshBtn.style.cursor = 'default';
            alert('This section is marked complete and saved. You can switch tabs or submit the whole test when ready.');
          };
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
          window.__ieltsBridgeComplete = freshBtn.onclick;
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

        function __installDayFamilyBridge() {
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
        }

        if (document.readyState !== 'loading') {
          __installDayFamilyBridge();
        } else {
          document.addEventListener('DOMContentLoaded', __installDayFamilyBridge);
        }
      })();
      `;
      content = content.replace('</body>', `<script>${dayFamilyBridgeSnippet}</script>\n</body>`);
    }

    // 2b. Safety net on top of the branch-specific handling above: fix any
    // mojibake from the source file's original encoding, and guarantee the
    // password/Test-Taker-ID gate is neutralized even if this file's function
    // names didn't match either branch above.
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
app.post('/api/admin/tests/:id/link-modules', async (req, res) => {
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
app.post('/api/admin/tests/:id/writing-data', async (req, res) => {
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
app.post('/api/admin/regrade-checkbox-pairs', async (req, res) => {
  const dryRun = req.query.dryRun === 'true';
  // Same table the injected bridge uses (and identical to the templates' own
  // calculateBandScore), so bands only move because marks moved.
  const bandFor = (correct) => {
    if (correct >= 39) return 9.0;
    if (correct >= 37) return 8.5;
    if (correct >= 35) return 8.0;
    if (correct >= 32) return 7.5;
    if (correct >= 30) return 7.0;
    if (correct >= 26) return 6.5;
    if (correct >= 23) return 6.0;
    if (correct >= 18) return 5.5;
    if (correct >= 16) return 5.0;
    if (correct >= 13) return 4.5;
    return 4.0;
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

app.post('/api/admin/fix-phantom-module-scores', async (req, res) => {
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
app.post('/api/admin/tests/:id/settings', async (req, res) => {
  const targetId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'Invalid test id' });
  try {
    const target = await db.get('SELECT id FROM tests WHERE id = ?', [targetId]);
    if (!target) return res.status(404).json({ error: `Test ${targetId} not found` });
    if (typeof req.body.sequentialLock === 'boolean') {
      await db.run('UPDATE tests SET sequential_lock = ? WHERE id = ?', [req.body.sequentialLock ? 1 : 0, targetId]);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Assignments list
app.get('/api/admin/assignments', async (req, res) => {
  try {
    const assignments = await db.all(`
      SELECT a.id, a.status, a.assigned_at, u.name as student_name, u.id as student_id, t.title as test_title, t.id as test_id
      FROM assignments a
      JOIN users u ON a.student_id = u.id
      JOIN tests t ON a.test_id = t.id
      ORDER BY a.assigned_at DESC
    `);
    res.json(assignments);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Assign Test
app.post('/api/admin/assign', async (req, res) => {
  const { studentIds, testId, testIds } = req.body; // studentIds and testIds are arrays
  const targetTestIds = Array.isArray(testIds) ? testIds : (testId ? [testId] : []);
  try {
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
app.post('/api/admin/users/bulk-import', async (req, res) => {
  const { students } = req.body; // Array of { id, name, password, groupName }
  if (!Array.isArray(students) || students.length === 0) {
    return res.status(400).json({ error: 'No students provided' });
  }
  const results = [];
  for (const s of students) {
    try {
      const hashedPassword = await hashPassword(s.password);
      await db.run(
        'INSERT INTO users (id, name, password_hash, role, group_name) VALUES (?, ?, ?, ?, ?)',
        [s.id, s.name, hashedPassword, 'student', s.groupName || null]
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
app.delete('/api/admin/assignments/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.run('DELETE FROM assignments WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reset Assignment (set back to assigned so student can retake)
app.post('/api/admin/assignments/:id/reset', async (req, res) => {
  const { id } = req.params;
  try {
    const asg = await db.get('SELECT * FROM assignments WHERE id = ?', [id]);
    if (!asg) return res.status(404).json({ error: 'Assignment not found' });
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
app.post('/api/admin/assignments/clear-pending', async (req, res) => {
  try {
    await db.run("DELETE FROM assignments WHERE status != 'completed'");
    await db.run("DELETE FROM speaking_assignments WHERE status != 'completed'");
    res.json({ success: true, message: 'Pending assignments cleared. Student completed submissions remain safe.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clear All Assignments & Submissions (Purge History)
app.all('/api/admin/assignments/clear-all', async (req, res) => {
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
app.post('/api/admin/reassign-default-tests', async (req, res) => {
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
app.post('/api/admin/reseed-demo-submissions', async (req, res) => {
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
    if (aiSettings.provider === 'openai' && aiSettings.openai_api_key) {
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
    if (aiSettings.provider === 'openai' && aiSettings.openai_api_key) {
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
app.get('/api/admin/settings', async (req, res) => {
  try {
    const settings = await db.get('SELECT * FROM ai_settings LIMIT 1');
    // Don't expose full keys — mask them
    if (settings) {
      settings.gemini_api_key_set = !!(settings.gemini_api_key);
      settings.openai_api_key_set = !!(settings.openai_api_key);
      delete settings.gemini_api_key;
      delete settings.openai_api_key;
    }
    res.json(settings || { provider: 'gemini', gemini_api_key_set: false, openai_api_key_set: false });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin Settings — Update
app.post('/api/admin/settings', async (req, res) => {
  const { provider, gemini_api_key, openai_api_key } = req.body;
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
      vals.push(existing.id);
      await db.run(`UPDATE ai_settings SET ${updates.join(', ')} WHERE id = ?`, vals);
    } else {
      await db.run('INSERT INTO ai_settings (provider, gemini_api_key, openai_api_key) VALUES (?, ?, ?)', [provider, gemini_api_key || null, openai_api_key || null]);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Speaking Prompts — List
app.get('/api/admin/speaking/prompts', async (req, res) => {
  try {
    const prompts = await db.all('SELECT * FROM speaking_prompts ORDER BY created_at DESC');
    res.json(prompts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Speaking Prompts — Create
app.post('/api/admin/speaking/prompts', async (req, res) => {
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
app.delete('/api/admin/speaking/prompts/:id', async (req, res) => {
  try {
    await db.run('DELETE FROM speaking_prompts WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Speaking Assign — Assign prompt to students
app.post('/api/admin/speaking/assign', async (req, res) => {
  const { studentIds, promptId } = req.body;
  if (!Array.isArray(studentIds) || !promptId) {
    return res.status(400).json({ error: 'studentIds array and promptId required' });
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
app.get('/api/speaking/assignments/:studentId', async (req, res) => {
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
app.get('/api/speaking/results/:studentId', async (req, res) => {
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
app.post('/api/speaking/submit', async (req, res) => {
  const { studentId, promptId, assignmentId, part1Transcript, part2Transcript, part3Transcript } = req.body;
  if (!studentId || !promptId) {
    return res.status(400).json({ error: 'studentId and promptId required' });
  }
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
app.post('/api/speaking/submit-audio', async (req, res) => {
  const { studentId, promptId, assignmentId, part1AudioBase64, part2AudioBase64, part3AudioBase64, part1Transcript, part2Transcript, part3Transcript } = req.body;

  if (!studentId || !promptId) {
    return res.status(400).json({ error: 'studentId and promptId required' });
  }

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
app.get('/api/teacher/speaking', async (req, res) => {
  try {
    const submissions = await db.all(`
      SELECT ss.*, u.name as student_name, sp.title as prompt_title
      FROM speaking_submissions ss
      JOIN users u ON ss.student_id = u.id
      JOIN speaking_prompts sp ON ss.prompt_id = sp.id
      ORDER BY ss.submitted_at DESC
    `);
    res.json(submissions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Teacher — Send/reveal score to student
app.post('/api/teacher/speaking/:id/send', async (req, res) => {
  try {
    await db.run('UPDATE speaking_submissions SET is_revealed = 1 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Teacher — Edit/Override speaking scores & feedback
app.post('/api/teacher/speaking/:id/update', async (req, res) => {
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
app.post('/api/admin/speaking/reset/:studentId', async (req, res) => {
  const { studentId } = req.params;
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
