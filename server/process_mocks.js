import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = 'C:\\Users\\user\\Desktop\\Full MOcks';
const destDir = path.join(__dirname, 'public', 'tests');

// Ensure destination directory exists
if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
}

async function processMockFiles() {
  try {
    const files = fs.readdirSync(srcDir);
    const htmlFiles = files.filter(f => f.toLowerCase().endsWith('.html')).sort();

    console.log(`Found ${htmlFiles.length} HTML files to process.`);

    for (let idx = 0; idx < htmlFiles.length; idx++) {
      const fileName = htmlFiles[idx];
      const srcPath = path.join(srcDir, fileName);
      let content = fs.readFileSync(srcPath, 'utf8');

      const mockNumber = idx + 1;
      const targetFileName = `mock${mockNumber}.html`;
      const destPath = path.join(destDir, targetFileName);

      console.log(`Processing "${fileName}" -> "${targetFileName}"...`);

      // 1. Inject Style to hide all branding and telegram visual markers
      const cssOverride = `
      <style>
        .brand-badge, 
        .brand, 
        .gate-footer, 
        .tg-circle, 
        [title*="Telegram"], 
        [title*="blog"], 
        [alt*="Jasurbek"], 
        a[href*="t.me"] {
          display: none !important;
          opacity: 0 !important;
          visibility: hidden !important;
          pointer-events: none !important;
        }
      </style>
      </head>
      `;
      content = content.replace('</head>', cssOverride);

      // 2. Perform Javascript/text replacements for personal tags & links
      content = content.replace(/@jasurbekisaev/gi, 'IELTS_Mock_Platform');
      content = content.replace(/Jasurbek's Blog/gi, 'IELTS Mock Test Center');
      content = content.replace(/Jasurbek's blog/gi, 'IELTS Mock Test Center');
      content = content.replace(/Jasurbek/gi, 'IELTS Mock Team');
      content = content.replace(/https:\/\/t\.me\/[a-zA-Z0-9_\+\-]+/gi, '#');
      content = content.replace(/t\.me\/[a-zA-Z0-9_\+\-]+/gi, '#');

      // Replace JS constants for Mocks 4-9
      content = content.replace(/const\s+TELEGRAM_LINK\s*=\s*[^;]+;/g, 'const TELEGRAM_LINK = "";');
      content = content.replace(/const\s+TELEGRAM_NAME\s*=\s*[^;]+;/g, 'const TELEGRAM_NAME = "IELTS Mock Test Center";');
      content = content.replace(/"Full Mock Test\s*—\s*"\s*\+\s*TELEGRAM_NAME\s*\+\s*"\s*\(Telegram\):\s*"\s*\+\s*TELEGRAM_LINK/g, '"IELTS Academic Mock Test Report"');

      // 3. Determine template style (Mocks 1-3 vs Mocks 4-9)
      const hasFinishTest = content.includes('function finishTest()');
      const hasFinishWriting = content.includes('function finishWriting()');

      if (hasFinishTest) {
        // --- STYLE 1: Mocks 1-3 ---
        console.log(`  Identified Style A (Mock 1-3)`);

        // Bypass login and auto-fill student ID
        const autoLoginSnippet = `
        // Auto-login extension injected by IELTS Mock Platform
        function runAutoLogin() {
          const params = new URLSearchParams(window.location.search);
          const sId = params.get('studentId') || 'STUDENT';
          const tId = params.get('testId') || '${mockNumber}';
          
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

        // Inject auto-login snippet before closing body tag
        content = content.replace('</body>', `<script>${autoLoginSnippet}</script>\n</body>`);

        // Modify finishTest function to post data back to our Express API
        const finishTestTarget = `function finishTest(){`;
        const finishTestReplacement = `function finishTest(){
          clearInterval(timerInt);
          document.getElementById('exam').classList.add('hidden');
          document.getElementById('result').classList.remove('hidden');
          const lAnswered = countAnswered('l',40);
          const rAnswered = countAnswered('r',40);
          const w1 = wordCount(document.getElementById('wText1').value);
          const w2 = wordCount(document.getElementById('wText2').value);
          document.getElementById('resultMeta').textContent = \`Candidate ID: \${candidate} | Listening answered: \${lAnswered}/40 | Reading answered: \${rAnswered}/40 | Writing words: Task 1 — \${w1}, Task 2 — \${w2}\`;
          buildReview();

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
          const tId = params.get('testId') || '${mockNumber}';

          fetch('http://localhost:5000/api/student/submit/' + tId, {
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

          setTimeout(()=>downloadPDF(true), 500);
          return;
        `;

        content = content.replace(finishTestTarget, finishTestReplacement);

      } else if (hasFinishWriting) {
        // --- STYLE 2: Mocks 4-9 ---
        console.log(`  Identified Style B (Mock 4-9)`);

        // Bypass password and ID screens, jump directly to Sound Check
        const autoLoginSnippetB = `
        // Auto-login extension injected by IELTS Mock Platform
        window.addEventListener('DOMContentLoaded', () => {
          const params = new URLSearchParams(window.location.search);
          const sId = params.get('studentId');
          const tId = params.get('testId') || '${mockNumber}';
          
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

        // Modify finishWriting function to post data back to our Express API
        const finishWritingTarget = `  function finishWriting(){`;
        const finishWritingReplacement = `  function finishWriting(){
          clearInterval(state.wTimerInterval);
          hide($("screen-test")); hide($("screen-transition"));
          buildFinalReport();
          show($("screen-results"));

          const params = new URLSearchParams(window.location.search);
          const sId = params.get('studentId') || state.takerId || 'STUDENT';
          const tId = params.get('testId') || '${mockNumber}';

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

          fetch('http://localhost:5000/api/student/submit/' + tId, {
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
        `;

        content = content.replace(finishWritingTarget, finishWritingReplacement);
      }

      fs.writeFileSync(destPath, content, 'utf8');
    }

    console.log('All mock test HTML files successfully processed, cleaned, and written to public folder!');
  } catch (error) {
    console.error('Error during file processing:', error);
  }
}

processMockFiles();
