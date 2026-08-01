import express from 'express';
import cors from 'cors';
import { initDb } from './database.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 5000;

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
}

// ----------------------------------------
// AUTHENTICATION
// ----------------------------------------
app.post('/api/auth/login', async (req, res) => {
  const { id, passcode } = req.body;

  try {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!user) {
      return res.status(401).json({ error: 'User ID not found' });
    }

    if (user.role === 'student') {
      // Students log in with passcode "student123" by default
      if (passcode !== user.password_hash) {
        return res.status(401).json({ error: 'Invalid student passcode' });
      }
      return res.json({ id: user.id, name: user.name, role: user.role });
    } else {
      // Teachers and Admins have customized passcodes
      if (passcode !== user.password_hash) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      return res.json({ id: user.id, name: user.name, role: user.role });
    }
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
    if (user.password_hash !== currentPassword) {
      return res.status(400).json({ error: 'Incorrect current password' });
    }
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [newPassword, userId]);
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
    const { studentId, listeningAnswers, readingAnswers, writingAnswers, violationsCount = 0 } = req.body;

    try {
      const test = await db.get('SELECT * FROM tests WHERE id = ?', [testId]);
      if (!test) {
        return res.status(404).json({ error: 'Test not found' });
      }

      const listeningData = JSON.parse(test.listening_data);
      let listeningScore = req.body.listeningScore;
      let readingScore = req.body.readingScore;

      if (listeningScore === undefined || readingScore === undefined) {
        const listeningData = JSON.parse(test.listening_data || '{"sections":[]}');
        const readingData = JSON.parse(test.reading_data || '{"passages":[]}');

        // Simple IELTS band scale out of 9
        const getIeltsBand = (correct, total) => {
          if (total === 0) return 0;
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

        if (listeningScore === undefined) {
          let listeningCorrect = 0;
          let totalListening = 0;
          if (listeningData && listeningData.sections) {
            listeningData.sections.forEach(sec => {
              sec.questions.forEach(q => {
                totalListening++;
                const studentAns = (listeningAnswers[q.id] || '').trim().toLowerCase();
                const correctAns = q.answer.trim().toLowerCase();
                if (studentAns === correctAns) {
                  listeningCorrect++;
                }
              });
            });
          }
          listeningScore = getIeltsBand(listeningCorrect, totalListening);
        }

        if (readingScore === undefined) {
          let readingCorrect = 0;
          let totalReading = 0;
          if (readingData && readingData.passages) {
            readingData.passages.forEach(pass => {
              pass.questions.forEach(q => {
                totalReading++;
                const studentAns = (readingAnswers[q.id] || '').trim().toLowerCase();
                const correctAns = q.answer.trim().toLowerCase();
                if (studentAns === correctAns) {
                  readingCorrect++;
                }
              });
            });
          }
          readingScore = getIeltsBand(readingCorrect, totalReading);
        }
      }

      // Check if test is a separate Reading/Listening practice test
      const testRecord = await db.get('SELECT title FROM tests WHERE id = ?', [testId]);
      const isSeparatePracticeTest = testRecord && (
        testRecord.title.toLowerCase().includes('reading') || 
        testRecord.title.toLowerCase().includes('listening')
      );
      const defaultIsRevealed = isSeparatePracticeTest ? 1 : 0;

      // Write to Submissions
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

    // Update assignment status
    await db.run(`
      UPDATE assignments 
      SET status = 'completed' 
      WHERE student_id = ? AND test_id = ?
    `, [studentId, testId]);

    res.json({ 
      success: true, 
      message: 'Test submitted successfully! Your essays are now pending review.',
      listeningScore,
      readingScore
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Assignment status (e.g. starting a test)
app.post('/api/student/assignment/start', async (req, res) => {
  const { studentId, testId } = req.body;
  try {
    await db.run(`
      UPDATE assignments 
      SET status = 'started' 
      WHERE student_id = ? AND test_id = ? AND status = 'assigned'
    `, [studentId, testId]);
    res.json({ success: true });
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
      SELECT s.*, u.name as student_name, u.group_name as student_group, t.title as test_title, t.listening_data
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
      writing_scores: JSON.parse(sub.writing_scores || 'null')
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Grade writing submission
app.post('/api/teacher/grade/:submissionId', async (req, res) => {
  const { submissionId } = req.params;
  const { writingScores, teacherFeedback, gradedBy } = req.body;
  // writingScores is an object: { ta: number, cc: number, lr: number, gra: number }

  const calculateOverallWritingBand = (scores) => {
    const avg = (scores.ta + scores.cc + scores.lr + scores.gra) / 4;
    // IELTS rounds to the nearest 0.5.
    // e.g. 6.25 -> 6.5, 6.125 -> 6.0, 6.75 -> 7.0
    const decimal = avg - Math.floor(avg);
    if (decimal < 0.25) return Math.floor(avg);
    if (decimal < 0.75) return Math.floor(avg) + 0.5;
    return Math.ceil(avg);
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
    const users = await db.all('SELECT id, name, role, password_hash as passcode, group_name as groupName FROM users');
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reset user password
app.post('/api/admin/users/reset-password', async (req, res) => {
  const { userId, newPassword } = req.body;
  try {
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [newPassword, userId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add user
app.post('/api/admin/users', async (req, res) => {
  const { id, name, role, password, groupName } = req.body;
  try {
    await db.run('INSERT INTO users (id, name, password_hash, role, group_name) VALUES (?, ?, ?, ?, ?)', [id, name, password || 'student123', role, groupName || null]);
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
  if (!title || !htmlContent) {
    return res.status(400).json({ error: 'Title and htmlContent are required' });
  }
  try {
    // 1. Insert into tests table to get the next ID
    const result = await db.run(`
      INSERT INTO tests (title, listening_data, reading_data, writing_data, created_by)
      VALUES (?, ?, ?, ?, ?)
    `, [title, '{}', '{}', '{}', 'admin']);
    const testId = result.lastID;
    
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
        .then(res => res.json())
        .then(data => {
          console.log('Submission synced to backend successfully:', data);
          if (window.parent) {
            window.parent.postMessage({ type: 'IELTS_TEST_SUBMITTED', testId: tId }, '*');
          }
        })
        .catch(err => console.error('Failed to submit to database backend:', err));
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
        .then(res => res.json())
        .then(data => {
          console.log('Submission synced to backend successfully:', data);
          if (window.parent) {
            window.parent.postMessage({ type: 'IELTS_TEST_SUBMITTED', testId: tId }, '*');
          }
        })
        .catch(err => console.error('Failed to submit to database backend:', err));
        return;
      }
      `;
      content = content.replace(finishWritingTarget, finishWritingReplacement);
    }
    
    // Save file
    fs.writeFileSync(filePath, content, 'utf8');
    
    // 3. Update tests record with iframe details
    const mockListening = {
      isIframe: true,
      iframeUrl: `/tests/${fileName}`
    };
    await db.run(`
      UPDATE tests 
      SET listening_data = ? 
      WHERE id = ?
    `, [JSON.stringify(mockListening), testId]);
    
    res.json({ success: true, testId });
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
      await db.run(
        'INSERT INTO users (id, name, password_hash, role, group_name) VALUES (?, ?, ?, ?, ?)',
        [s.id, s.name, s.password, 'student', s.groupName || null]
      );
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
    // Also clear the related submission if present
    const asg = await db.get('SELECT * FROM assignments WHERE id = ?', [id]);
    if (asg && asg.submission_id) {
      await db.run('DELETE FROM submissions WHERE id = ?', [asg.submission_id]);
    }
    await db.run("UPDATE assignments SET status = 'assigned', submission_id = NULL WHERE id = ?", [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clear All Assignments (Mock Exams + Speaking + Submissions) - Support both POST and GET
app.all('/api/admin/assignments/clear-all', async (req, res) => {
  try {
    await db.run('DELETE FROM assignments');
    await db.run('DELETE FROM speaking_assignments');
    await db.run('DELETE FROM submissions');
    await db.run('DELETE FROM speaking_submissions');
    res.json({ success: true, message: 'All test assignments and submissions cleared successfully' });
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
      return { result: JSON.parse(response.choices[0].message.content), provider: 'openai' };
    } else if (aiSettings.gemini_api_key) {
      const genAI = new GoogleGenerativeAI(aiSettings.gemini_api_key);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      const result = await model.generateContent(`${systemPrompt}\n\n${userMessage}`);
      const text = result.response.text().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      return { result: JSON.parse(text), provider: 'gemini' };
    } else {
      throw new Error('No AI API key configured. Please add your Gemini or OpenAI key in Admin Settings.');
    }
  } catch (err) {
    throw new Error(`AI evaluation failed: ${err.message}`);
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

// Student — Submit speaking test WITH RECORDED AUDIO blobs (OpenAI Whisper pipeline)
app.post('/api/speaking/submit-audio', async (req, res) => {
  const { studentId, promptId, assignmentId, part1AudioBase64, part2AudioBase64, part3AudioBase64, part1Transcript, part2Transcript, part3Transcript } = req.body;
  
  if (!studentId || !promptId) {
    return res.status(400).json({ error: 'studentId and promptId required' });
  }

  try {
    const aiSettings = await db.get('SELECT * FROM ai_settings LIMIT 1');
    if (!aiSettings) return res.status(500).json({ error: 'AI settings not configured' });

    let finalPart1Text = part1Transcript || '';
    let finalPart2Text = part2Transcript || '';
    let finalPart3Text = part3Transcript || '';

    let part1AudioUrl = null;
    let part2AudioUrl = null;
    let part3AudioUrl = null;

    // Transcribe Part 1 Audio with Whisper if provided
    if (part1AudioBase64) {
      const buffer = Buffer.from(part1AudioBase64.replace(/^data:audio\/\w+;base64,/, ''), 'base64');
      const resWhisper = await transcribeAudioWithWhisper(buffer, 'webm', aiSettings);
      if (resWhisper.text) finalPart1Text = resWhisper.text;
      part1AudioUrl = resWhisper.publicUrl;
    }

    // Transcribe Part 2 Audio with Whisper if provided
    if (part2AudioBase64) {
      const buffer = Buffer.from(part2AudioBase64.replace(/^data:audio\/\w+;base64,/, ''), 'base64');
      const resWhisper = await transcribeAudioWithWhisper(buffer, 'webm', aiSettings);
      if (resWhisper.text) finalPart2Text = resWhisper.text;
      part2AudioUrl = resWhisper.publicUrl;
    }

    // Transcribe Part 3 Audio with Whisper if provided
    if (part3AudioBase64) {
      const buffer = Buffer.from(part3AudioBase64.replace(/^data:audio\/\w+;base64,/, ''), 'base64');
      const resWhisper = await transcribeAudioWithWhisper(buffer, 'webm', aiSettings);
      if (resWhisper.text) finalPart3Text = resWhisper.text;
      part3AudioUrl = resWhisper.publicUrl;
    }

    // Restore punctuation
    finalPart1Text = await punctuateTranscriptWithAI(finalPart1Text, aiSettings);
    finalPart2Text = await punctuateTranscriptWithAI(finalPart2Text, aiSettings);
    finalPart3Text = await punctuateTranscriptWithAI(finalPart3Text, aiSettings);

    // Evaluate with AI (GPT-4o or Gemini)
    const { result, provider } = await evaluateSpeaking(
      { part1: finalPart1Text, part2: finalPart2Text, part3: finalPart3Text },
      aiSettings
    );

    // Save submission with audio URLs and Whispered transcripts
    await db.run(`
      INSERT INTO speaking_submissions 
        (student_id, prompt_id, part1_transcript, part2_transcript, part3_transcript,
         fluency_score, lexical_score, grammar_score, pronunciation_score, overall_score, ai_feedback, ai_provider, is_revealed,
         part1_audio, part2_audio, part3_audio)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `, [
      studentId, promptId,
      finalPart1Text || '', finalPart2Text || '', finalPart3Text || '',
      result.fluency, result.lexical, result.grammar, result.pronunciation, result.overall,
      JSON.stringify(result.feedback), provider,
      part1AudioUrl, part2AudioUrl, part3AudioUrl
    ]);

    // Mark assignment as submitted
    if (assignmentId) {
      await db.run("UPDATE speaking_assignments SET status = 'submitted' WHERE id = ?", [assignmentId]);
    }

    res.json({ success: true, message: 'Submitted and transcribed with OpenAI Whisper' });
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

app.listen(port, () => {
  console.log(`Backend server running on port ${port}`);
});
