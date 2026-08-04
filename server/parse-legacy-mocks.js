import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testsDir = path.join(__dirname, 'public', 'tests');
const outputDir = path.join(__dirname, 'data', 'mocks');

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

console.log('Starting extraction of legacy mock tests...');

function extractAnswersFromJS(content, prefix = 'l') {
  const answerMap = {};
  // Match patterns like ANSWERS = { l1: ['A'], ... } or listeningAnswerKey = { 1: "A", ... }
  const answersBlockMatch = content.match(/ANSWERS\s*=\s*(\{[\s\S]*?\});/) ||
                            content.match(/listeningAnswerKey\s*=\s*(\{[\s\S]*?\});/) ||
                            content.match(/readingAnswerKey\s*=\s*(\{[\s\S]*?\});/);

  if (answersBlockMatch) {
    const raw = answersBlockMatch[1];
    // Find all key value pairs like "1": "A" or l1: ["A"]
    const pairs = [...raw.matchAll(/(?:['"]?([lr]?\d+)['"]?\s*:\s*(?:\[([^\]]+)\]|['"]([^'"]+)['"]|([a-zA-Z0-9_\-\.]+)))/g)];
    for (const match of pairs) {
      let qNumStr = match[1].replace(/^[lr]/, '');
      const num = parseInt(qNumStr, 10);
      if (!isNaN(num)) {
        let val = match[2] || match[3] || match[4] || '';
        val = val.replace(/['"]/g, '').trim();
        answerMap[num] = val;
      }
    }
  }
  return answerMap;
}

function extractPassages(content) {
  const passages = [];
  // Style A passage extraction: different mock files name this array differently
  // (e.g. `const passages = [...]` vs `const READING_PASSAGES = [...]`)
  const passagesMatch = content.match(/const\s+passages\s*=\s*(\[[\s\S]*?\]);/)
    || content.match(/const\s+READING_PASSAGES\s*=\s*(\[[\s\S]*?\]);/);
  if (passagesMatch) {
    try {
      const rawCode = passagesMatch[1];
      const evaluated = new Function(`return ${rawCode}`)();
      if (Array.isArray(evaluated)) {
        evaluated.forEach((htmlText, idx) => {
          const titleMatch = htmlText.match(/<h2>(.*?)<\/h2>/i) || htmlText.match(/<h3>(.*?)<\/h3>/i);
          const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : `Reading Passage ${idx + 1}`;
          const cleanText = htmlText.replace(/<h2>.*?<\/h2>/gi, '').replace(/<h3>.*?<\/h3>/gi, '').trim();
          passages.push({
            id: `passage_${idx + 1}`,
            title,
            text: cleanText
          });
        });
      }
    } catch (e) {
      console.warn('Could not eval passages array directly:', e.message);
    }
  }

  if (passages.length === 0) {
    const passageBlocks = [...content.matchAll(/<div[^>]*class="[^"]*passage-text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)];
    passageBlocks.forEach((match, idx) => {
      const htmlText = match[1];
      const titleMatch = htmlText.match(/<h2>(.*?)<\/h2>/i) || htmlText.match(/<h3>(.*?)<\/h3>/i);
      const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : `Reading Passage ${idx + 1}`;
      passages.push({
        id: `passage_${idx + 1}`,
        title,
        text: htmlText
      });
    });
  }

  if (passages.length === 0) {
    for (let i = 1; i <= 3; i++) {
      passages.push({
        id: `passage_${i}`,
        title: `Academic Reading Passage ${i}`,
        text: `Reading passage ${i} content for IELTS Academic Exam. Read carefully and answer questions 1 to 40.`
      });
    }
  }

  return passages;
}

function extractWritingPrompts(content) {
  let task1Prompt = 'The charts and tables show data regarding international trends. Summarize the information by selecting and reporting the main features and making comparisons where relevant.';
  let task2Prompt = 'Some people believe that modern technology has made life easier, while others argue it creates more problems. Discuss both views and give your own opinion.';
  let task1Img = null;

  const t1Match = content.match(/Writing Task 1<\/b>[\s\S]*?<\/div>[\s\S]*?<div[^>]*class="w-prompt"[^>]*>([\s\S]*?)<\/div>/i) ||
                  content.match(/Task 1: (.*?)(?=\n|<|"|Candidate)/i);
  if (t1Match) {
    task1Prompt = t1Match[1].replace(/<[^>]+>/g, '').trim();
  }

  const imgMatch = content.match(/<img[^>]*class="[^"]*w-task-img[^"]*"[^>]*src="([^"]+)"/i);
  if (imgMatch) {
    task1Img = imgMatch[1];
  }

  const t2Match = content.match(/Writing Task 2<\/b>[\s\S]*?<\/div>[\s\S]*?<div[^>]*class="w-prompt"[^>]*>([\s\S]*?)<\/div>/i) ||
                  content.match(/Task 2: (.*?)(?=\n|<|"|Candidate)/i);
  if (t2Match) {
    task2Prompt = t2Match[1].replace(/<[^>]+>/g, '').trim();
  }

  return {
    task1: { prompt: task1Prompt, imageUrl: task1Img, minWords: 150 },
    task2: { prompt: task2Prompt, minWords: 250 }
  };
}

function buildNativeTestObject(mockNum, content) {
  let audioUrl = `/audio/mock${mockNum}.mp3`;
  const audioMatch = content.match(/<audio[^>]*src="([^"]+)"/i);
  if (audioMatch) {
    audioUrl = audioMatch[1];
  }

  const listeningAnswers = extractAnswersFromJS(content, 'l');
  const readingAnswers = extractAnswersFromJS(content, 'r');

  const listeningSections = [];
  const partRanges = [
    { part: 1, start: 1, end: 10, title: 'Listening Part 1: Social Context' },
    { part: 2, start: 11, end: 20, title: 'Listening Part 2: Monologue / Guide' },
    { part: 3, start: 21, end: 30, title: 'Listening Part 3: Academic Discussion' },
    { part: 4, start: 31, end: 40, title: 'Listening Part 4: Academic Lecture' }
  ];

  partRanges.forEach(p => {
    const questions = [];
    for (let q = p.start; q <= p.end; q++) {
      const correct = listeningAnswers[q] || 'A';
      const isMcq = (q >= 11 && q <= 14) || (q >= 21 && q <= 25);
      questions.push({
        id: q,
        label: `Question ${q}`,
        type: isMcq ? 'multiple-choice' : 'fill-in-the-blank',
        placeholder: `Answer for Q${q}`,
        text: isMcq ? `Select the correct option for question ${q}:` : `Question ${q}`,
        options: isMcq ? ['A', 'B', 'C', 'D'] : [],
        answer: correct
      });
    }
    listeningSections.push({
      title: p.title,
      instructions: `Listen carefully and answer questions ${p.start} to ${p.end}. Write NO MORE THAN TWO WORDS AND/OR A NUMBER for each answer.`,
      questions
    });
  });

  const extractedPassages = extractPassages(content);
  const readingPassages = [];
  const passageRanges = [
    { start: 1, end: 13 },
    { start: 14, end: 26 },
    { start: 27, end: 40 }
  ];

  extractedPassages.forEach((pObj, idx) => {
    const range = passageRanges[idx] || { start: 1, end: 13 };
    const questions = [];

    for (let q = range.start; q <= range.end; q++) {
      const correct = readingAnswers[q] || 'TRUE';
      const isTfng = q % 3 === 0;
      const isMcq = q % 3 === 1;

      questions.push({
        id: q,
        label: `Question ${q}`,
        type: isTfng ? 'true-false-notgiven' : isMcq ? 'multiple-choice' : 'fill-in-the-blank',
        placeholder: `Answer for Q${q}`,
        text: `Question ${q} regarding ${pObj.title}`,
        options: isTfng ? ['TRUE', 'FALSE', 'NOT GIVEN'] : isMcq ? ['A', 'B', 'C', 'D'] : [],
        answer: correct
      });
    }

    readingPassages.push({
      title: pObj.title,
      text: pObj.text,
      questions
    });
  });

  const writingData = extractWritingPrompts(content);

  return {
    id: mockNum,
    title: `IELTS Academic Mock Test ${mockNum}`,
    listening_data: {
      isIframe: false,
      audioUrl,
      sections: listeningSections
    },
    reading_data: {
      passages: readingPassages
    },
    writing_data: writingData
  };
}

for (let i = 1; i <= 9; i++) {
  const htmlFile = path.join(testsDir, `mock${i}.html`);
  if (fs.existsSync(htmlFile)) {
    const content = fs.readFileSync(htmlFile, 'utf8');
    const mockData = buildNativeTestObject(i, content);
    const jsonPath = path.join(outputDir, `mock${i}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(mockData, null, 2), 'utf8');
    console.log(`Successfully extracted and created ${jsonPath}`);
  } else {
    console.warn(`File ${htmlFile} not found, generating default native JSON mock...`);
    const defaultData = buildNativeTestObject(i, '');
    const jsonPath = path.join(outputDir, `mock${i}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(defaultData, null, 2), 'utf8');
  }
}

console.log('Legacy mock extraction completed successfully!');
