import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const lPath = 'C:\\Users\\user\\Desktop\\New listening predictions\\Listening Test 23 (HARD).html';
const rPath = 'C:\\Users\\user\\Desktop\\New reading predictions\\Reading Test 29 [HARD] - Early Printing Press Metallurgy.html';

console.log('Compiling IELTS Hard Prediction Mock Test 10...');

const lContent = fs.readFileSync(lPath, 'utf8');
const rContent = fs.readFileSync(rPath, 'utf8');

// 1. Extract Listening Answers & Audio
function parseListening(content) {
  const answerMap = {};
  const answersMatch = content.match(/ANSWERS\s*=\s*(\{[\s\S]*?\});/) ||
                       content.match(/listeningAnswerKey\s*=\s*(\{[\s\S]*?\});/);

  if (answersMatch) {
    try {
      const evalAns = new Function(`return ${answersMatch[1]}`)();
      for (const [k, v] of Object.entries(evalAns)) {
        const qNum = parseInt(k.replace(/^[lr]/, ''), 10);
        if (!isNaN(qNum)) {
          answerMap[qNum] = Array.isArray(v) ? v[0] : String(v);
        }
      }
    } catch (e) {
      console.warn('Fallback answer regex matching for listening:', e.message);
    }
  }

  // Extract base64 audio or src if present
  let audioUrl = '';
  const audioSrcMatch = content.match(/<audio[^>]*src=["']([^"']+)["']/i);
  if (audioSrcMatch) {
    audioUrl = audioSrcMatch[1];
  }

  return {
    isIframe: false,
    audioUrl,
    answerKey: answerMap,
    htmlContent: content
  };
}

// 2. Extract Reading Passages, Questions, Answers
function parseReading(content) {
  const answerMap = {};
  const answersMatch = content.match(/ANSWERS\s*=\s*(\{[\s\S]*?\});/) ||
                       content.match(/readingAnswerKey\s*=\s*(\{[\s\S]*?\});/);

  if (answersMatch) {
    try {
      const evalAns = new Function(`return ${answersMatch[1]}`)();
      for (const [k, v] of Object.entries(evalAns)) {
        const qNum = parseInt(k.replace(/^[lr]/, ''), 10);
        if (!isNaN(qNum)) {
          answerMap[qNum] = Array.isArray(v) ? v[0] : String(v);
        }
      }
    } catch (e) {
      console.warn('Fallback answer regex matching for reading:', e.message);
    }
  }

  const passages = [];
  const passageMatches = [...content.matchAll(/<div[^>]*class="[^"]*passage[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)];
  passageMatches.forEach((m, idx) => {
    passages.push({
      id: `passage_${idx + 1}`,
      title: `Reading Passage ${idx + 1}: Early Printing Press Metallurgy`,
      text: m[1]
    });
  });

  return {
    isIframe: false,
    passages: passages.length > 0 ? passages : [
      { id: 'passage_1', title: 'Passage 1: Early Printing Press Metallurgy', text: 'Reading Passage 1 content.' },
      { id: 'passage_2', title: 'Passage 2: Printing Innovation & Typesetting', text: 'Reading Passage 2 content.' },
      { id: 'passage_3', title: 'Passage 3: Historical Metallurgy Analysis', text: 'Reading Passage 3 content.' }
    ],
    answerKey: answerMap,
    htmlContent: content
  };
}

const listeningData = parseListening(lContent);
const readingData = parseReading(rContent);

const writingData = {
  task1: {
    prompt: "The chart below shows the percentage of a drug company's total sales, by region, from 2002 to 2006. Summarise the information by selecting and reporting the main features, and make comparisons where relevant.",
    image: "/uploads/drug_company_sales_chart.png"
  },
  task2: {
    prompt: "Some students take a gap year after graduating high school to work and/or travel. Discuss the advantages and disadvantages of this."
  }
};

const fullMock = {
  title: "IELTS Hard Prediction Mock Test 10",
  listening_data: listeningData,
  reading_data: readingData,
  writing_data: writingData
};

const outputDir = path.join(__dirname, '../server/data/mocks');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

fs.writeFileSync(path.join(outputDir, 'mock10.json'), JSON.stringify(fullMock, null, 2), 'utf8');
console.log('Saved server/data/mocks/mock10.json successfully!');
