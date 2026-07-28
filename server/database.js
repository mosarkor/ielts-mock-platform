import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'database.sqlite');

// Ensure database parent directory exists (especially for Render persistent disks)
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export async function initDb() {
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  // Enable foreign keys
  await db.get('PRAGMA foreign_keys = ON');

  // Create Users Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      password_hash TEXT,
      role TEXT CHECK(role IN ('student', 'teacher', 'admin')) NOT NULL
    )
  `);

  // Create Tests Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      listening_data TEXT NOT NULL, -- JSON string
      reading_data TEXT NOT NULL,    -- JSON string
      writing_data TEXT NOT NULL,    -- JSON string
      created_by TEXT,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

  // Create Assignments Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      test_id INTEGER NOT NULL,
      assigned_at TEXT NOT NULL,
      status TEXT CHECK(status IN ('assigned', 'started', 'completed')) DEFAULT 'assigned',
      FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE
    )
  `);

  // Create Submissions Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      test_id INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      submitted_at TEXT,
      listening_answers TEXT,      -- JSON string
      reading_answers TEXT,        -- JSON string
      writing_answers TEXT,        -- JSON string
      listening_score REAL,
      reading_score REAL,
      writing_scores TEXT,         -- JSON string: { ta, cc, lr, gra }
      writing_score REAL,          -- overall writing band
      teacher_feedback TEXT,
      graded_by TEXT,
      is_revealed INTEGER DEFAULT 0, -- 0 = Hidden, 1 = Revealed
      FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE,
      FOREIGN KEY (graded_by) REFERENCES users(id)
    )
  `);

  // Seed initial data if database is empty
  const userCount = await db.get('SELECT COUNT(*) as count FROM users');
  if (userCount.count === 0) {
    console.log('Seeding initial database tables...');

    // Seed Users (passwords are stored as plain text for simple development authentication)
    await db.run(`INSERT INTO users (id, name, password_hash, role) VALUES 
      ('admin', 'Head Administrator', 'admin123', 'admin'),
      ('teacher', 'Dr. Sarah Jenkins', 'teacher123', 'teacher'),
      ('UNI2026A', 'Aria Thorne', 'student123', 'student'),
      ('UNI2026B', 'Brandon Lee', 'student123', 'student'),
      ('UNI2026C', 'Chloe Varma', 'student123', 'student'),
      ('UNI2026D', 'Dante Alighieri', 'student123', 'student'),
      ('UNI2026E', 'Elena Rostova', 'student123', 'student')
    `);

    // Seed the 9 HTML Mock Tests directly
    let firstTestId = null;
    for (let i = 1; i <= 9; i++) {
      const mockListening = {
        isIframe: true,
        iframeUrl: `/tests/mock${i}.html`
      };
      const result = await db.run(`
        INSERT INTO tests (title, listening_data, reading_data, writing_data, created_by)
        VALUES (?, ?, ?, ?, ?)
      `, 
        `IELTS Academic Mock Test ${i}`, 
        JSON.stringify(mockListening), 
        JSON.stringify({}), 
        JSON.stringify({}), 
        'admin'
      );
      if (i === 1) {
        firstTestId = result.lastID;
      }
    }

    // Seed assignments
    await db.run(`INSERT INTO assignments (student_id, test_id, assigned_at, status) VALUES 
      ('UNI2026A', ?, datetime('now', '-2 days'), 'assigned'),
      ('UNI2026B', ?, datetime('now', '-1 days'), 'started'),
      ('UNI2026C', ?, datetime('now', '-3 days'), 'completed'),
      ('UNI2026D', ?, datetime('now', '-4 days'), 'completed')
    `, firstTestId, firstTestId, firstTestId, firstTestId);

    // Assign the remaining mock tests to UNI2026A and UNI2026B too so they show up immediately
    for (let t = firstTestId + 1; t < firstTestId + 9; t++) {
      await db.run(`INSERT INTO assignments (student_id, test_id, assigned_at, status) VALUES 
        ('UNI2026A', ?, datetime('now'), 'assigned'),
        ('UNI2026B', ?, datetime('now'), 'assigned')
      `, t, t);
    }

    // Seed submissions
    // UNI2026C Submission (Fully Graded and Revealed)
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
      JSON.stringify({ 1: "Aria", 2: "Thorne", 3: "CB21LQ", 4: "Student", 5: "15", 6: "B", 7: "A" }), // 6 out of 7 right = 7.5 (scaled)
      JSON.stringify({ 11: "B", 12: "FALSE", 13: "FALSE", 14: "1999" }), // 4 out of 4 right = 8.0 (scaled)
      JSON.stringify({
        task1: "The bar chart illustrates the count of students signing up for different language programs at a university from 2020 to 2024. Overall, Spanish remained the most popular subject throughout the timeframe, whereas German recorded the lowest enrollment rate...",
        task2: "Gaining knowledge is a multifaceted process. While academic books provide a structured foundation of theories, practical experience offers hands-on application. In my opinion, a balanced combination of both is the most effective approach..."
      }),
      JSON.stringify({ ta: 7.5, cc: 8.0, lr: 7.0, gra: 7.5 })
    );

    // UNI2026B Submission (Pending Grading)
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
    );

    console.log('Seeding completed successfully!');
  }

  return db;
}
