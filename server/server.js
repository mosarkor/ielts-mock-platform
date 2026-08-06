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
    const submissions = await db.all(`
      SELECT s.*, t.title
      FROM submissions s
      JOIN tests t ON s.test_id = t.id
      WHERE s.student_id = ? AND s.is_revealed = 1
      ORDER BY s.submitted_at DESC
    `, [studentId]);

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
      writing_data: JSON.parse(test.writing_data)
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
    const isIframeTest = listeningData?.isIframe === true;

    const validBand = (value) => {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0 || number > 9) return undefined;
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
    const listeningScore = isIframeTest
      ? validBand(req.body.listeningScore)
      : scoreQuestions(listeningData.sections, listeningAnswers);
    const readingScore = isIframeTest
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
        listening_score, reading_score, is_revealed, violations_count
      ) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?)
    `,
      studentId,
      testId,
      JSON.stringify(listeningAnswers),
      JSON.stringify(readingAnswers),
      JSON.stringify(writingAnswers),
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

  const roundIelts = (avg) => {
    const decimal = avg - Math.floor(avg);
    if (decimal < 0.25) return Math.floor(avg);
    if (decimal < 0.75) return Math.floor(avg) + 0.5;
    return Math.ceil(avg);
  };

  const calculateOverallWritingBand = (scores) => {
    if (!scores) return 6.0;
    // Support dual task scoring: { task1: { ta, cc, lr, gra }, task2: { tr, cc, lr, gra } }
    if (scores.task1 && scores.task2) {
      const t1Vals = Object.values(scores.task1).map(Number);
      const t2Vals = Object.values(scores.task2).map(Number);
      const t1Avg = t1Vals.reduce((a, b) => a + b, 0) / (t1Vals.length || 4);
      const t2Avg = t2Vals.reduce((a, b) => a + b, 0) / (t2Vals.length || 4);
      const t1Band = roundIelts(t1Avg);
      const t2Band = roundIelts(t2Avg);
      // Official IELTS weighting: Task 1 is 1/3, Task 2 is 2/3
      const weightedAvg = (t1Band * 1 + t2Band * 2) / 3;
      return roundIelts(weightedAvg);
    }
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
    } else if (content.includes('function checkAnswers(') && content.includes('function showResultsModal(')) {
      // "Prediction" template family (New listening/reading predictions folders): a
      // self-scoring client-side quiz with no backend submission of its own, and one
      // that reveals correct/incorrect marks and a results modal the moment the student
      // checks their answers. Full mock tests must never show scores until the teacher
      // releases them, so the original "Check Answers" button is completely replaced
      // (not just wrapped) with a silent harvester that never runs the original
      // checkAnswers()/showResultsModal() reveal logic at all.
      usedHarvestBridge = true;
      const harvestBridgeSnippet = `
      (function() {
        var params = new URLSearchParams(window.location.search);
        var __bridgeTestId = params.get('testId') || '${testId}';
        var __bridgeModuleType = params.get('moduleType') || '${moduleType}';

        function __harvestAnswer(n) {
          try {
            if (typeof getUserAnswer === 'function') return getUserAnswer(n) || '';
            if (typeof getQuestionAnswer === 'function') return getQuestionAnswer(n) || '';
          } catch (e) {}
          return '';
        }

        function __normalize(v) {
          return String(v == null ? '' : v).trim().toLowerCase();
        }

        function __silentCheckAndReport() {
          var answers = {};
          var correctCount = 0;
          for (var n = 1; n <= 40; n++) {
            var userAns = __harvestAnswer(n);
            answers[n] = userAns;
            try {
              if (typeof correctAnswers === 'object' && correctAnswers && correctAnswers[n] !== undefined) {
                var correct = correctAnswers[n];
                var isMatch = Array.isArray(correct)
                  ? correct.some(function(c) { return __normalize(c) === __normalize(userAns); })
                  : __normalize(correct) === __normalize(userAns);
                if (isMatch) correctCount++;
              }
            } catch (e) {}
          }
          var band = 0;
          try {
            if (typeof calculateBandScore === 'function') {
              band = parseFloat(calculateBandScore(correctCount)) || 0;
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
              correctCount: correctCount,
              band: band
            }, window.location.origin);
          }
        }

        function __installBridge() {
          var btn = document.getElementById('checkBtn');
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
        }

        if (document.readyState !== 'loading') {
          __installBridge();
        } else {
          document.addEventListener('DOMContentLoaded', __installBridge);
        }
      })();
      `;
      content = content.replace('</body>', `<script>${harvestBridgeSnippet}</script>\n</body>`);
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
      fluency, lexical, grammar, pronunciation, overall,
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
