import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import pg from 'pg';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'database.sqlite');

function translateSql(sql) {
  let index = 1;
  let translated = sql.replace(/\?/g, () => `$${index++}`);
  translated = translated.replace(/datetime\('now',\s*'-2 hours'\)/gi, "CURRENT_TIMESTAMP - INTERVAL '2 hours'");
  translated = translated.replace(/datetime\('now',\s*'-3 days',\s*'\+2 hours'\)/gi, "CURRENT_TIMESTAMP - INTERVAL '3 days' + INTERVAL '2 hours'");
  translated = translated.replace(/datetime\('now',\s*'-3 days'\)/gi, "CURRENT_TIMESTAMP - INTERVAL '3 days'");
  translated = translated.replace(/datetime\('now',\s*'-1 days',\s*'\+2 hours'\)/gi, "CURRENT_TIMESTAMP - INTERVAL '1 day' + INTERVAL '2 hours'");
  translated = translated.replace(/datetime\('now',\s*'-1 days'\)/gi, "CURRENT_TIMESTAMP - INTERVAL '1 day'");
  translated = translated.replace(/datetime\('now',\s*'-2 days'\)/gi, "CURRENT_TIMESTAMP - INTERVAL '2 days'");
  translated = translated.replace(/datetime\('now',\s*'-4 days'\)/gi, "CURRENT_TIMESTAMP - INTERVAL '4 days'");
  translated = translated.replace(/datetime\('now'\)/gi, 'CURRENT_TIMESTAMP');
  return translated;
}

class PostgresDatabaseWrapper {
  constructor(pool) {
    this.pool = pool;
  }

  async get(sql, ...params) {
    const finalParams = (params.length === 1 && Array.isArray(params[0])) ? params[0] : params;
    const translated = translateSql(sql);
    const result = await this.pool.query(translated, finalParams);
    return result.rows[0] || null;
  }

  async all(sql, ...params) {
    const finalParams = (params.length === 1 && Array.isArray(params[0])) ? params[0] : params;
    const translated = translateSql(sql);
    const result = await this.pool.query(translated, finalParams);
    return result.rows;
  }

  async run(sql, ...params) {
    const finalParams = (params.length === 1 && Array.isArray(params[0])) ? params[0] : params;
    const translated = translateSql(sql);
    let finalSql = translated;
    if (finalSql.trim().toUpperCase().startsWith('INSERT INTO')) {
      if (!finalSql.toUpperCase().includes('RETURNING')) {
        finalSql += ' RETURNING id';
      }
    }
    const result = await this.pool.query(finalSql, finalParams);
    const lastID = result.rows && result.rows[0] ? result.rows[0].id : null;
    return {
      lastID,
      changes: result.rowCount || 0
    };
  }

  async exec(sql) {
    let translated = translateSql(sql);
    translated = translated.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY');
    translated = translated.replace(/REAL/gi, 'DOUBLE PRECISION');
    translated = translated.replace(/DEFAULT\s+datetime\('now'\)/gi, 'DEFAULT CURRENT_TIMESTAMP');
    await this.pool.query(translated);
  }

  async prepare(sql) {
    const translated = translateSql(sql);
    return {
      run: async (...params) => {
        const finalParams = (params.length === 1 && Array.isArray(params[0])) ? params[0] : params;
        await this.pool.query(translated, finalParams);
      },
      finalize: async () => {}
    };
  }
}

export async function initDb() {
  if (process.env.DATABASE_URL) {
    console.log('Connecting to cloud PostgreSQL database...');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      }
    });

    const db = new PostgresDatabaseWrapper(pool);

    // Create Tables
    await db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        password_hash TEXT,
        role TEXT CHECK(role IN ('student', 'teacher', 'admin')) NOT NULL,
        group_name TEXT
      )
    `);

    // Dynamically alter table for existing installations
    await db.exec('ALTER TABLE users ADD COLUMN group_name TEXT').catch(() => {});

    await db.exec(`
      CREATE TABLE IF NOT EXISTS tests (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        listening_data TEXT NOT NULL,
        reading_data TEXT NOT NULL,
        writing_data TEXT NOT NULL,
        created_by TEXT REFERENCES users(id)
      )
    `);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS assignments (
        id SERIAL PRIMARY KEY,
        student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
        assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status TEXT CHECK(status IN ('assigned', 'started', 'completed')) DEFAULT 'assigned'
      )
    `);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS submissions (
        id SERIAL PRIMARY KEY,
        student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
        started_at TIMESTAMP,
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        listening_answers TEXT,
        reading_answers TEXT,
        writing_answers TEXT,
        listening_score REAL,
        reading_score REAL,
        writing_scores TEXT,
        writing_score REAL,
        teacher_feedback TEXT,
        graded_by TEXT REFERENCES users(id),
        is_revealed INTEGER DEFAULT 0,
        violations_count INTEGER DEFAULT 0
      )
    `);

    // Dynamically alter table for existing installations
    await db.exec('ALTER TABLE submissions ADD COLUMN violations_count INTEGER DEFAULT 0').catch(() => {});

    // Speaking module tables
    await db.exec(`
      CREATE TABLE IF NOT EXISTS speaking_prompts (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        part1_questions TEXT NOT NULL,
        part2_cue_card TEXT NOT NULL,
        part3_questions TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS speaking_assignments (
        id SERIAL PRIMARY KEY,
        student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        prompt_id INTEGER NOT NULL REFERENCES speaking_prompts(id) ON DELETE CASCADE,
        assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status TEXT CHECK(status IN ('assigned', 'submitted')) DEFAULT 'assigned'
      )
    `);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS speaking_submissions (
        id SERIAL PRIMARY KEY,
        student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        prompt_id INTEGER NOT NULL REFERENCES speaking_prompts(id) ON DELETE CASCADE,
        part1_transcript TEXT,
        part2_transcript TEXT,
        part3_transcript TEXT,
        fluency_score DOUBLE PRECISION,
        lexical_score DOUBLE PRECISION,
        grammar_score DOUBLE PRECISION,
        pronunciation_score DOUBLE PRECISION,
        overall_score DOUBLE PRECISION,
        ai_feedback TEXT,
        ai_provider TEXT,
        is_revealed INTEGER DEFAULT 0,
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS ai_settings (
        id SERIAL PRIMARY KEY,
        provider TEXT DEFAULT 'gemini',
        gemini_api_key TEXT,
        openai_api_key TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Seed default AI settings row
    await db.exec(`INSERT INTO ai_settings (provider) SELECT 'gemini' WHERE NOT EXISTS (SELECT 1 FROM ai_settings)`);

    // Seed if empty
    const userCount = await db.get('SELECT COUNT(*) as count FROM users');
    if (parseInt(userCount.count) === 0) {
      console.log('Seeding cloud database initial tables...');
      await db.run(`INSERT INTO users (id, name, password_hash, role) VALUES 
        ('admin', 'Head Administrator', 'admin123', 'admin'),
        ('teacher', 'Dr. Sarah Jenkins', 'teacher123', 'teacher'),
        ('UNI2026A', 'Aria Thorne', 'student123', 'student'),
        ('UNI2026B', 'Brandon Lee', 'student123', 'student'),
        ('UNI2026C', 'Chloe Varma', 'student123', 'student'),
        ('UNI2026D', 'Dante Alighieri', 'student123', 'student'),
        ('UNI2026E', 'Elena Rostova', 'student123', 'student')
      `);

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

      await db.run(`INSERT INTO assignments (student_id, test_id, assigned_at, status) VALUES 
        ('UNI2026A', ?, CURRENT_TIMESTAMP - INTERVAL '2 days', 'assigned'),
        ('UNI2026B', ?, CURRENT_TIMESTAMP - INTERVAL '1 day', 'started'),
        ('UNI2026C', ?, CURRENT_TIMESTAMP - INTERVAL '3 days', 'completed'),
        ('UNI2026D', ?, CURRENT_TIMESTAMP - INTERVAL '4 days', 'completed')
      `, firstTestId, firstTestId, firstTestId, firstTestId);

      for (let t = firstTestId + 1; t < firstTestId + 9; t++) {
        await db.run(`INSERT INTO assignments (student_id, test_id, assigned_at, status) VALUES 
          ('UNI2026A', ?, CURRENT_TIMESTAMP, 'assigned'),
          ('UNI2026B', ?, CURRENT_TIMESTAMP, 'assigned')
        `, t, t);
      }

      await db.run(`
        INSERT INTO submissions (
          student_id, test_id, started_at, submitted_at, 
          listening_answers, reading_answers, writing_answers, 
          listening_score, reading_score, writing_scores, writing_score, 
          teacher_feedback, graded_by, is_revealed
        ) VALUES (
          'UNI2026C', ?, CURRENT_TIMESTAMP - INTERVAL '3 days', CURRENT_TIMESTAMP - INTERVAL '3 days' + INTERVAL '2 hours',
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
      );

      await db.run(`
        INSERT INTO submissions (
          student_id, test_id, started_at, submitted_at, 
          listening_answers, reading_answers, writing_answers, 
          listening_score, reading_score, is_revealed
        ) VALUES (
          'UNI2026B', ?, CURRENT_TIMESTAMP - INTERVAL '1 day', CURRENT_TIMESTAMP - INTERVAL '1 day' + INTERVAL '2 hours',
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
      console.log('Cloud database seeding completed successfully!');
    }

    return db;
  }

  // SQLite Fallback
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  await db.get('PRAGMA foreign_keys = ON');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      password_hash TEXT,
      role TEXT CHECK(role IN ('student', 'teacher', 'admin')) NOT NULL,
      group_name TEXT
    )
  `);

  // Dynamically alter table for existing installations
  await db.exec('ALTER TABLE users ADD COLUMN group_name TEXT').catch(() => {});

  await db.exec(`
    CREATE TABLE IF NOT EXISTS tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      listening_data TEXT NOT NULL,
      reading_data TEXT NOT NULL,
      writing_data TEXT NOT NULL,
      created_by TEXT,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

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
  await db.exec(`
    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      test_id INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      submitted_at TEXT,
      listening_answers TEXT,
      reading_answers TEXT,
      writing_answers TEXT,
      listening_score REAL,
      reading_score REAL,
      writing_scores TEXT,
      writing_score REAL,
      teacher_feedback TEXT,
      graded_by TEXT,
      is_revealed INTEGER DEFAULT 0,
      violations_count INTEGER DEFAULT 0,
      FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE,
      FOREIGN KEY (graded_by) REFERENCES users(id)
    )
  `);

  // Dynamically alter table for existing installations
  await db.exec('ALTER TABLE submissions ADD COLUMN violations_count INTEGER DEFAULT 0').catch(() => {});

  // Speaking module tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS speaking_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      part1_questions TEXT NOT NULL,
      part2_cue_card TEXT NOT NULL,
      part3_questions TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS speaking_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      prompt_id INTEGER NOT NULL,
      assigned_at TEXT DEFAULT (datetime('now')),
      status TEXT CHECK(status IN ('assigned','submitted')) DEFAULT 'assigned',
      FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (prompt_id) REFERENCES speaking_prompts(id) ON DELETE CASCADE
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS speaking_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      prompt_id INTEGER NOT NULL,
      part1_transcript TEXT,
      part2_transcript TEXT,
      part3_transcript TEXT,
      fluency_score REAL,
      lexical_score REAL,
      grammar_score REAL,
      pronunciation_score REAL,
      overall_score REAL,
      ai_feedback TEXT,
      ai_provider TEXT,
      is_revealed INTEGER DEFAULT 0,
      submitted_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (prompt_id) REFERENCES speaking_prompts(id) ON DELETE CASCADE
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS ai_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT DEFAULT 'gemini',
      gemini_api_key TEXT,
      openai_api_key TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Seed default AI settings
  const aiRow = await db.get('SELECT id FROM ai_settings LIMIT 1');
  if (!aiRow) {
    await db.run("INSERT INTO ai_settings (provider) VALUES ('gemini')");
  }

  const userCount = await db.get('SELECT COUNT(*) as count FROM users');
  if (userCount.count === 0) {
    console.log('Seeding initial database tables...');

    await db.run(`INSERT INTO users (id, name, password_hash, role) VALUES 
      ('admin', 'Head Administrator', 'admin123', 'admin'),
      ('teacher', 'Dr. Sarah Jenkins', 'teacher123', 'teacher'),
      ('UNI2026A', 'Aria Thorne', 'student123', 'student'),
      ('UNI2026B', 'Brandon Lee', 'student123', 'student'),
      ('UNI2026C', 'Chloe Varma', 'student123', 'student'),
      ('UNI2026D', 'Dante Alighieri', 'student123', 'student'),
      ('UNI2026E', 'Elena Rostova', 'student123', 'student')
    `);

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

    await db.run(`INSERT INTO assignments (student_id, test_id, assigned_at, status) VALUES 
      ('UNI2026A', ?, datetime('now', '-2 days'), 'assigned'),
      ('UNI2026B', ?, datetime('now', '-1 days'), 'started'),
      ('UNI2026C', ?, datetime('now', '-3 days'), 'completed'),
      ('UNI2026D', ?, datetime('now', '-4 days'), 'completed')
    `, firstTestId, firstTestId, firstTestId, firstTestId);

    for (let t = firstTestId + 1; t < firstTestId + 9; t++) {
      await db.run(`INSERT INTO assignments (student_id, test_id, assigned_at, status) VALUES 
        ('UNI2026A', ?, datetime('now'), 'assigned'),
        ('UNI2026B', ?, datetime('now'), 'assigned')
      `, t, t);
    }

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
    );

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
