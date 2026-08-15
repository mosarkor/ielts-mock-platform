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
        window.addEventListener('message', (event) => {
          if (event.data && event.data.type === 'FORCE_SUBMIT') {
            if (typeof finishTest === 'function') {
              finishTest();
            }
          }
        });
        if (document.readyState !== 'loading') {
          runAutoLogin();
        } else {
          document.addEventListener('DOMContentLoaded', runAutoLogin);
        }
        `;

        // Inject auto-login snippet before closing body tag
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
            // Official IELTS raw-score conversion. Every band below 4.5 used to
            // collapse to a flat 4.0, so a blank paper and 12/40 scored the same.
            var t = [[39,9],[37,8.5],[35,8],[32,7.5],[30,7],[26,6.5],[23,6],[18,5.5],[16,5],[13,4.5],[10,4],[6,3.5],[4,3],[0,2.5]];
            for (var i = 0; i < t.length; i++) { if (correct >= t[i][0]) return t[i][1]; }
            return 2.5;
          };

          const params = new URLSearchParams(window.location.search);
          const sId = params.get('studentId') || candidate;
          const tId = params.get('testId') || '${mockNumber}';

          fetch(window.location.origin + '/api/student/submit/' + tId, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              studentId: sId,
              listeningAnswers,
              readingAnswers,
              writingAnswers,
              listeningScore: getIeltsBand(lScore),
              readingScore: getIeltsBand(rScore),
              violationsCount: parseInt(sessionStorage.getItem('violations_' + tId) || '0')
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
        window.addEventListener('message', (event) => {
          if (event.data && event.data.type === 'FORCE_SUBMIT') {
            if (typeof finishWriting === 'function') {
              finishWriting();
            }
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
            // Official IELTS raw-score conversion. Every band below 4.5 used to
            // collapse to a flat 4.0, so a blank paper and 12/40 scored the same.
            var t = [[39,9],[37,8.5],[35,8],[32,7.5],[30,7],[26,6.5],[23,6],[18,5.5],[16,5],[13,4.5],[10,4],[6,3.5],[4,3],[0,2.5]];
            for (var i = 0; i < t.length; i++) { if (correct >= t[i][0]) return t[i][1]; }
            return 2.5;
          };

          fetch(window.location.origin + '/api/student/submit/' + tId, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              studentId: sId,
              listeningAnswers,
              readingAnswers,
              writingAnswers,
              listeningScore: getIeltsBand(lRes.correctCount),
              readingScore: getIeltsBand(rRes.correctCount),
              violationsCount: parseInt(sessionStorage.getItem('violations_' + tId) || '0')
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

      fs.writeFileSync(destPath, content, 'utf8');
    }

    console.log('All mock test HTML files successfully processed, cleaned, and written to public folder!');
  } catch (error) {
    console.error('Error during file processing:', error);
  }
}

processMockFiles();
