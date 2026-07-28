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

    // Sample Test Data
    const sampleListening = {
      audioUrl: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
      sections: [
        {
          title: "Section 1: Library Membership Form",
          instructions: "Complete the form below. Write NO MORE THAN TWO WORDS AND/OR A NUMBER for each answer.",
          questions: [
            { id: 1, type: "fill-in-the-blank", label: "First name:", placeholder: "e.g. John", answer: "Aria" },
            { id: 2, type: "fill-in-the-blank", label: "Surname:", placeholder: "e.g. Smith", answer: "Thorne" },
            { id: 3, type: "fill-in-the-blank", label: "Postcode:", placeholder: "e.g. CB2 1LQ", answer: "CB21LQ" },
            { id: 4, type: "fill-in-the-blank", label: "Membership type:", placeholder: "e.g. Adult", answer: "Student" },
            { id: 5, type: "fill-in-the-blank", label: "Annual fee paid:", placeholder: "e.g. £25", answer: "15" }
          ]
        },
        {
          title: "Section 2: Campus Tour",
          instructions: "Choose the correct letter, A, B or C.",
          questions: [
            {
              id: 6,
              type: "multiple-choice",
              text: "Where is the new Science Center located?",
              options: ["A. Behind the library", "B. Opposite the cafeteria", "C. Next to the gym"],
              answer: "B"
            },
            {
              id: 7,
              type: "multiple-choice",
              text: "The student lounge is open until:",
              options: ["A. 8:00 PM", "B. 10:00 PM", "C. Midnight"],
              answer: "C"
            }
          ]
        }
      ]
    };

    const sampleReading = {
      passages: [
        {
          title: "Passage 1: The Rise of Vertical Farming",
          text: `Vertical farming is the practice of growing crops in vertically stacked layers. It often incorporates controlled-environment agriculture, which aims to optimize plant growth, and soilless farming techniques such as hydroponics, aquaponics, and aeroponics. Some common choices of structures to house vertical farming systems include buildings, shipping containers, tunnels, and abandoned mine shafts.\n\nThe modern concept of vertical farming was proposed in 1999 by Dickson Despommier, a professor of Public and Environmental Health at Columbia University. Despommier and his students designed a layout of a skyscraper farm that could feed 50,000 people. Although the skyscraper has not yet been built, it popularized the idea of vertical farming.\n\nThe primary advantage of using vertical farming technologies is the increased crop yield that comes with a smaller unit area of land requirement. The increased ability to cultivate a larger variety of crops at once because crops do not share the same plots of land while being grown is another sought-after advantage. Additionally, crops are resistant to weather disruptions because of their placement indoors, reducing crop lost to extreme or unexpected weather occurrences.`,
          questions: [
            {
              id: 11,
              type: "multiple-choice",
              text: "Dickson Despommier is a professor at which university?",
              options: ["A. Harvard University", "B. Columbia University", "C. Stanford University", "D. Oxford University"],
              answer: "B"
            },
            {
              id: 12,
              type: "true-false-notgiven",
              text: "Dickson Despommier's vertical farming skyscraper has already been constructed.",
              options: ["TRUE", "FALSE", "NOT GIVEN"],
              answer: "FALSE"
            },
            {
              id: 13,
              type: "true-false-notgiven",
              text: "Vertical farming crops are highly vulnerable to outdoor weather patterns.",
              options: ["TRUE", "FALSE", "NOT GIVEN"],
              answer: "FALSE"
            },
            {
              id: 14,
              type: "fill-in-the-blank",
              label: "The modern concept of vertical farming was proposed in the year:",
              placeholder: "e.g. 1990",
              answer: "1999"
            }
          ]
        }
      ]
    };

    const sampleWriting = {
      task1: {
        prompt: "The chart below shows the number of students enrolled in various language courses at a university between 2020 and 2024. Summarize the information by selecting and reporting the main features, and make comparisons where relevant.",
        minWords: 150
      },
      task2: {
        prompt: "Some people believe that reading books is the best way to gain knowledge, while others argue that practical experience is more valuable. Discuss both views and give your opinion.",
        minWords: 250
      }
    };

    // Insert Sample Test
    const result = await db.run(`
      INSERT INTO tests (title, listening_data, reading_data, writing_data, created_by)
      VALUES (?, ?, ?, ?, ?)
    `, 
      "IELTS Academic Mock Test 1", 
      JSON.stringify(sampleListening), 
      JSON.stringify(sampleReading), 
      JSON.stringify(sampleWriting), 
      'admin'
    );
    const testId = result.lastID;

    // Seed the 9 HTML Mock Tests
    for (let i = 1; i <= 9; i++) {
      const mockListening = {
        isIframe: true,
        iframeUrl: `/tests/mock${i}.html`
      };
      await db.run(`
        INSERT INTO tests (title, listening_data, reading_data, writing_data, created_by)
        VALUES (?, ?, ?, ?, ?)
      `, 
        `IELTS Full Academic Mock Test ${i}`, 
        JSON.stringify(mockListening), 
        JSON.stringify({}), 
        JSON.stringify({}), 
        'admin'
      );
    }

    // Seed assignments
    await db.run(`INSERT INTO assignments (student_id, test_id, assigned_at, status) VALUES 
      ('UNI2026A', ?, datetime('now', '-2 days'), 'assigned'),
      ('UNI2026B', ?, datetime('now', '-1 days'), 'started'),
      ('UNI2026C', ?, datetime('now', '-3 days'), 'completed'),
      ('UNI2026D', ?, datetime('now', '-4 days'), 'completed')
    `, testId, testId, testId, testId);

    // Assign the new 9 mock tests to UNI2026A and UNI2026B too so they show up immediately
    for (let t = 2; t <= 10; t++) {
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
      testId,
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
      testId,
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
