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
        part1_audio TEXT,
        part2_audio TEXT,
        part3_audio TEXT,
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    try { await db.exec(`ALTER TABLE speaking_submissions ADD COLUMN part1_audio TEXT;`); } catch(e){}
    try { await db.exec(`ALTER TABLE speaking_submissions ADD COLUMN part2_audio TEXT;`); } catch(e){}
    try { await db.exec(`ALTER TABLE speaking_submissions ADD COLUMN part3_audio TEXT;`); } catch(e){}

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

    await ensureCustomDataSeeded(db);
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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS speaking_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      prompt_id INTEGER NOT NULL,
      assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
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
      submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
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
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

  await ensureCustomDataSeeded(db);
  return db;
}

async function ensureCustomDataSeeded(db) {
  const students = [
    ['G1-01', 'Aydemi Kamalova', 'RQLD2E', 'Group 1'],
    ['G1-02', 'Aydemir Akmatov', 'NRP7EX', 'Group 1'],
    ['G1-03', 'Myktybek Anarbaev', 'W9P547', 'Group 1'],
    ['G1-04', 'Nursaid Asanov', 'HQJ7Z5', 'Group 1'],
    ['G1-05', 'Belek Tazhibaev', 'H63J5C', 'Group 1'],
    ['G1-06', 'Daniel Abdilakimov', 'VLQY8S', 'Group 1'],
    ['G1-07', 'Nurtilek Kozhomzharov', 'QSRSYE', 'Group 1'],
    ['G1-08', 'Muhammad Saparbaev', '2PCAC2', 'Group 1'],
    ['G1-09', 'Eldar Akzholov', 'PYMQUU', 'Group 1'],
    ['G1-10', 'Mukhammed Choenbaev', 'AHSPZC', 'Group 1'],
    ['G1-11', 'Daniel Abdamitov', 'MHNY58', 'Group 1'],
    ['G1-12', 'Mukhammedali Parmanov', 'TZWR5V', 'Group 1'],
    ['G1-13', 'Kayrat Mamadaliev', '8GDGR7', 'Group 1'],
    ['G1-14', 'Abdumitalipov Zaphar', 'ZP3KWN', 'Group 1'],

    ['G2-01', 'Iskender Abdinabiev', '5XYWCD', 'Group 2'],
    ['G2-02', 'Fatima Kasymbekova', 'TX8R83', 'Group 2'],
    ['G2-03', 'Zalkarbek Ergeshbaev', 'DKH8T9', 'Group 2'],
    ['G2-04', 'Nurtilek Musaev', 'UMLUK4', 'Group 2'],
    ['G2-05', 'Saule Abdisalamova', 'WGZBUQ', 'Group 2'],
    ['G2-06', 'Aruuzhan Askarbekova', 'JE37FQ', 'Group 2'],
    ['G2-07', 'Teyitbek Yunusov', 'XY4L8G', 'Group 2'],
    ['G2-08', 'Bektemir Saypillaev', '9RAFDL', 'Group 2'],
    ['G2-09', 'Beyshegul Samatova', 'DDASST', 'Group 2'],
    ['G2-10', 'Akmarzhan Abdygaparova', 'LL24HR', 'Group 2'],
    ['G2-11', 'Gulazema Suyunbaeva', 'BHU9CR', 'Group 2'],
    ['G2-12', 'Aruuke Begalieva', 'Y5Q2H5', 'Group 2'],
    ['G2-13', 'Azatbek Kadyrov', 'ED3RYG', 'Group 2'],
    ['G2-14', 'Fatima Barakova', 'QR6C26', 'Group 2'],
    ['G2-15', 'Abdurakhim Tanikulov', 'UHX86R', 'Group 2'],

    ['G3-01', 'Bayel Shamshiev', 'Y8LUD9', 'Group 3'],
    ['G3-02', 'Timur Taabaldiev', '5RGJUG', 'Group 3'],
    ['G3-03', 'Zeynep Sagynbaeva', 'UYLQP3', 'Group 3'],
    ['G3-04', 'Abbos Khomitkhonov', 'YQ9EJS', 'Group 3'],
    ['G3-05', 'Zalkarbek Salibaev', 'Y7JGBV', 'Group 3'],
    ['G3-06', 'Daniel Karimberdiev', 'TRKT8G', 'Group 3'],
    ['G3-07', 'Abdullo Abdullaev', 'QDVMWG', 'Group 3'],
    ['G3-08', 'Aiganysh Abdukarova', 'YCM3QA', 'Group 3'],
    ['G3-09', 'Zhanysh Anarbaev', 'LJS2HF', 'Group 3'],
    ['G3-10', 'Aelita Abdykaparova', 'UG3NFK', 'Group 3'],
    ['G3-11', 'Mukhammadyunus Abduzhabbarov', 'GKRT64', 'Group 3'],
    ['G3-12', 'Salokhidin Umarov', 'SLF4MU', 'Group 3'],

    ['G4-01', 'Aibiyke Aitieva', 'KS5KAT', 'Group 4'],
    ['G4-02', 'Rayana Askatbekova', 'T5ZX2Q', 'Group 4'],
    ['G4-03', 'Baykhan Medetbekov', 'S9NTDL', 'Group 4'],
    ['G4-04', 'Akylay Berkoshova', '9QFFNU', 'Group 4'],
    ['G4-05', 'Reykhana Turgunbaeva', 'CGMTCA', 'Group 4'],
    ['G4-06', 'Artur Madymarov', 'ZBLQ5Q', 'Group 4'],
    ['G4-07', 'Nurbakyt Akylbekov', 'JM9LH6', 'Group 4'],
    ['G4-08', 'Eldar Akynbaev', 'ZKWLNT', 'Group 4'],
    ['G4-09', 'Muktarbek Nasirdinov', 'DPTZB3', 'Group 4'],
    ['G4-10', 'Kanatbek Taychikov', 'ZWT6PB', 'Group 4'],
    ['G4-11', 'Saykal Saynazarova', '32NQBC', 'Group 4'],
    ['G4-12', 'Dariga Zhanyshbekova', '7P8AKS', 'Group 4'],
    ['G4-13', 'Elvira Mederbekova', '3YC2SU', 'Group 4'],
    ['G4-14', 'Nurel Koldoshbaev', 'HMV4JY', 'Group 4']
  ];

  for (const s of students) {
    try {
      const exists = await db.get('SELECT 1 FROM users WHERE id = ?', [s[0]]);
      if (!exists) {
        await db.run(
          `INSERT INTO users (id, name, password_hash, role, group_name) VALUES (?, ?, ?, 'student', ?)`,
          [s[0], s[1], s[2], s[3]]
        );
      }
    } catch (e) {}
  }

  // Speaking Prompts
  try {
    const promptCheck = await db.get('SELECT COUNT(*) as count FROM speaking_prompts');
    const count = parseInt(promptCheck?.count || promptCheck?.cnt || 0);
    if (count === 0) {
      const prompts = [
        {
          title: 'Speaking Test 1 — Architecture & Tall Buildings',
          part1: ['Where do you study or work?', 'Are you a student or are you currently working?', 'What do you like most about your field of study or job?', 'Do you think artificial intelligence is helpful for learning?'],
          part2: `Describe a tall building you like or dislike.\n\nYou should say:\n• Where the building is\n• What the building looks like (height, design, function)\n• Whether you like it or dislike it (and why)\n• And explain how living or working in such a building might affect people`,
          part3: ['What are the advantages and disadvantages of living in tall buildings?', 'Do you think cities should build more tall buildings in the future?', 'Why do many large companies build skyscrapers as their main offices?']
        },
        {
          title: 'Speaking Test 2 — Travel & Beautiful Cities',
          part1: ['Do you often look out of the window when you travel?', 'What kind of natural views do you enjoy best?', 'Do you like the view from your window at home?', 'Would you like to live somewhere with a beautiful view in the future?'],
          part2: `Describe a city that you have been to and would like to visit again.\n\nYou should say:\n• When you visited it\n• What you did while you were there\n• What made the city memorable\n• And explain why you would like to visit it again`,
          part3: ['What elements make a city attractive to international visitors?', 'How are cities in your country different from those in other countries?', 'Why do many people prefer living in or visiting big cities?']
        },
        {
          title: 'Speaking Test 3 — Sports & Live Events',
          part1: ['What do you usually do in your spare time?', 'Has the way you spend your free time changed compared to the past?', 'Do you prefer spending your free time alone or with others?', 'Have you ever been a member of a sports team?'],
          part2: `Describe a live sports event you watched and liked.\n\nYou should say:\n• When and where you watched it\n• Who you watched it with\n• What happened during the event\n• And explain why you enjoyed watching this sports event`,
          part3: ['Why do people enjoy watching sports events live in a stadium?', 'Is watching sports live better than watching them on television?', 'Should governments invest public funds into hosting major international sports events?']
        },
        {
          title: 'Speaking Test 4 — Holidays & Vacations',
          part1: ['Do you live in a noisy or a quiet neighborhood?', 'Is the area where you live crowded or peaceful?', 'Where do you usually like to go when you have free time in your area?', 'Do you know many people who live near your home?'],
          part2: `Describe a place where you had a memorable holiday or vacation.\n\nYou should say:\n• Where it was located\n• When you went there\n• What activities you did during the holiday\n• And explain why you would recommend this place to others`,
          part3: ['Where do people in your country usually go for their annual holidays?', 'What kinds of places do people enjoy visiting on holiday?', 'Why do some holiday destinations become significantly more popular than others?']
        },
        {
          title: 'Speaking Test 5 — Food & Special Celebrations',
          part1: ['How often do you eat meals out at restaurants?', 'Do you eat different kinds of food at different times of the year?', 'Is it important for family members to have meals together regularly?', 'What is your favorite dish to eat during celebrations?'],
          part2: `Describe a kind of food people eat during a special event or festival.\n\nYou should say:\n• What the food is\n• Which special occasion(s) people prepare and eat it on\n• How it is made or where people buy it\n• And explain why this food is special to you or to people in your culture`,
          part3: ['Have festival and celebration foods changed over time in your country?', 'What is the most popular traditional festival food in your country?', 'Why do people consider special foods an important part of cultural celebrations?']
        },
        {
          title: 'Speaking Test 6 — Entertainment & Movies',
          part1: ['Do you think laughing and humor are important in daily life?', 'Are you good at telling jokes to your friends or family?', 'Do your friends enjoy telling jokes or funny stories?', 'Why do people enjoy watching comedies or humorous things?'],
          part2: `Describe a movie you watched and enjoyed recently.\n\nYou should say:\n• When and where you watched it\n• Who you watched it with\n• What the storyline of the movie was about\n• And explain why you enjoyed watching this movie`,
          part3: ['What essential qualities make a great actor or actress?', 'Is self-confidence the most important factor for success in acting?', 'What factors make a movie successful globally?']
        },
        {
          title: 'Speaking Test 7 — Language Learning & Communication',
          part1: ['What kinds of things do you usually type on a daily basis?', 'Do you type on a computer or phone keyboard more often?', 'Do you think touch typing is an essential skill for work or study?', 'How do you practice or improve your typing speed and accuracy?'],
          part2: `Describe a person who is very good at learning foreign languages.\n\nYou should say:\n• Who this person is\n• How you know this person\n• What languages he or she can speak or learn\n• And explain why you think this person is so effective at learning languages`,
          part3: ['How do young children naturally learn new languages compared to adults?', 'What are the main personal and professional benefits of learning a foreign language?', 'What major obstacles do people encounter when trying to master a new language?']
        },
        {
          title: 'Speaking Test 8 — Technology & Gadgets',
          part1: ['Do you frequently use headphones or earphones?', 'In what situations do you prefer using headphones?', 'What type of headphones do you currently use?', 'Under what conditions or circumstances would you avoid using headphones?'],
          part2: `Describe a piece of technology (other than a smartphone) that you would like to own.\n\nYou should say:\n• What technological device it is\n• How much it costs\n• What you would use it for in your daily life or work\n• And explain why you would like to own this device`,
          part3: ['How has modern technology transformed the way people work and study?', 'Do you think people today rely excessively on technological devices?', 'Which modern technological gadgets are most indispensable in your country?']
        },
        {
          title: 'Speaking Test 9 — Career & Future Ambitions',
          part1: ['What do you usually do first when you get up in the morning?', 'Do you spend your morning routine the same on weekends as on weekdays?', 'Do you consider breakfast an essential meal of the day?', 'Do you prefer waking up early in the morning or staying up late at night?'],
          part2: `Describe your ideal or perfect job.\n\nYou should say:\n• What job or career it is\n• Where or how you first learned about this career\n• What skills or qualifications you need to acquire to get this job\n• And explain why you think this would be your perfect job`,
          part3: ['Are salary and personal interest equally important when choosing a career?', 'Do the majority of people in your country genuinely enjoy their jobs?', 'What key factors should people consider before deciding on a career path?']
        },
        {
          title: 'Speaking Test 10 — Personal Growth & Wise Advice',
          part1: ['Have you ever forgotten an important appointment or task?', 'Do you find it easy or difficult to remember people’s names?', 'What specific things do you need to remember in your daily routine?', 'Would you consider yourself good at memorizing information?'],
          part2: `Describe a person who gave you clever or smart advice.\n\nYou should say:\n• Who this person is\n• What situation or problem you were facing\n• What advice or solution he or she provided\n• And explain why you think this was clever or helpful advice`,
          part3: ['Are highly intelligent children naturally happier in life?', 'Are people born with intelligence or do they develop it through effort and education?', 'How crucial is the role of schools and teachers in helping students become smart and critical thinkers?']
        }
      ];

      for (const p of prompts) {
        await db.run(
          `INSERT INTO speaking_prompts (title, part1_questions, part2_cue_card, part3_questions) VALUES (?, ?, ?, ?)`,
          [p.title, JSON.stringify(p.part1), p.part2, JSON.stringify(p.part3)]
        );
      }
    }
  } catch (e) {}

  // Ensure Reading Tests 11-20 exist in tests table
  for (let i = 11; i <= 20; i++) {
    const title = `IELTS Reading Test ${i}`;
    const mockFileName = `mock${i}.html`;
    const mockListening = { isIframe: true, iframeUrl: `/tests/${mockFileName}` };
    
    try {
      const exists = await db.get('SELECT id FROM tests WHERE title LIKE ?', [`%Reading Test ${i}%`]);
      if (!exists) {
        await db.run(
          `INSERT INTO tests (title, listening_data, reading_data, writing_data, created_by) VALUES (?, ?, ?, ?, ?)`,
          [title, JSON.stringify(mockListening), JSON.stringify({}), JSON.stringify({}), 'admin']
        );
      }
    } catch (e) {
      console.error(`Error seeding ${title}:`, e.message);
    }
  }

  // Ensure Full Mock Test 21 & 22 exist in tests table
  try {
    const title21 = 'IELTS Full CDI Mock Test 11';
    const exists21 = await db.get('SELECT id FROM tests WHERE id = 21 OR title = ?', [title21]);
    if (!exists21) {
      await db.run(
        `INSERT INTO tests (id, title, listening_data, reading_data, writing_data, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
        [21, title21, JSON.stringify({ isIframe: true, iframeUrl: '/tests/mock21.html' }), JSON.stringify({}), JSON.stringify({}), 'admin']
      );
    }
    const title22 = 'IELTS Full CDI Mock Test 10';
    const exists22 = await db.get('SELECT id FROM tests WHERE id = 22 OR title = ?', [title22]);
    if (!exists22) {
      await db.run(
        `INSERT INTO tests (id, title, listening_data, reading_data, writing_data, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
        [22, title22, JSON.stringify({ isIframe: true, iframeUrl: '/tests/mock22.html' }), JSON.stringify({}), JSON.stringify({}), 'admin']
      );
    }

    const extraTests = [
      { id: 23, title: 'IELTS Listening Test 1', file: 'mock23.html' },
      { id: 24, title: 'IELTS Listening Test 2', file: 'mock24.html' },
      { id: 25, title: 'IELTS Listening Test 3', file: 'mock25.html' },
      { id: 26, title: 'IELTS Reading Test 21', file: 'mock26.html' },
      { id: 27, title: 'IELTS Reading Test 22', file: 'mock27.html' }
    ];
    for (const et of extraTests) {
      const exists = await db.get('SELECT id FROM tests WHERE id = ? OR title = ?', [et.id, et.title]);
      if (!exists) {
        await db.run(
          `INSERT INTO tests (id, title, listening_data, reading_data, writing_data, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
          [et.id, et.title, JSON.stringify({ isIframe: true, iframeUrl: `/tests/${et.file}` }), JSON.stringify({}), JSON.stringify({}), 'admin']
        );
      }
    }
  } catch (e) {}

  // ── Auto-assign Mock Test 9 to every real student on every startup ──────────
  // Render's free tier wipes the SQLite file on redeploy, so we must re-seed
  // assignments every time the server boots.
  try {
    const mock9 = await db.get(`SELECT id FROM tests WHERE id = 9 OR title LIKE '%Mock Test 9%' OR title LIKE '%Mock Test%9%' LIMIT 1`);
    if (mock9) {
      const realStudents = await db.all(`SELECT id FROM users WHERE role = 'student' AND id LIKE 'G%'`);
      for (const s of realStudents) {
        const exists = await db.get(
          `SELECT 1 FROM assignments WHERE student_id = ? AND test_id = ?`,
          [s.id, mock9.id]
        );
        if (!exists) {
          await db.run(
            `INSERT INTO assignments (student_id, test_id, assigned_at, status) VALUES (?, ?, datetime('now'), 'assigned')`,
            [s.id, mock9.id]
          );
        }
      }
      console.log(`Auto-assigned Mock Test 9 (id=${mock9.id}) to ${realStudents.length} students.`);
    }
  } catch (e) {
    console.error('Auto-assign Mock Test 9 failed:', e.message);
  }

  // Seeding finished
}

export { ensureCustomDataSeeded };

