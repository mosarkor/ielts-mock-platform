// Live-browser smoke test for the harvest-bridge standalone test templates
// (server/public/tests/*.html). Run this after uploading or reprocessing a
// test, before releasing it to students -- it walks through the exact
// failure modes that have actually broken real students' exams:
//   - Part/passage switching showing the same content for every part
//   - Answer inputs (radio/text) not registering a selection
//   - A module's countdown timer being frozen
//
// Requires the local dev server running at http://localhost:5000 (or set
// SMOKE_BASE_URL). Usage:
//   node scripts/smoke-test-templates.mjs            # tests every bridged template
//   node scripts/smoke-test-templates.mjs mock38.html # tests just one file
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = path.join(repoRoot, 'server', 'public', 'tests');
const baseUrl = process.env.SMOKE_BASE_URL || 'http://localhost:5000';

function isHarvestBridgeTemplate(html) {
  // Mirrors the exact signature server.js's /api/admin/upload-test uses to
  // decide whether to inject the harvest bridge -- keep these in sync.
  return html.includes('function checkAnswers(')
    && html.includes('correctAnswers');
}

async function isServerUp() {
  try {
    const res = await fetch(`${baseUrl}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function smokeTestFile(browser, filename) {
  const url = `${baseUrl}/tests/${encodeURIComponent(filename)}`;
  const page = await browser.newPage();
  const failures = [];
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 15000 });

    // Listening templates gate everything behind a "click to start" overlay
    // (real IELTS audio plays exactly once) -- dismiss it first so the checks
    // below can reach the actual page instead of failing on a covered element.
    const startOverlayButton = page.locator('#start-listening-exam-btn').first();
    if (await startOverlayButton.count()) {
      await startOverlayButton.click();
      await page.waitForTimeout(300);
    }

    // Part/passage switching: click through each Part tab and confirm the
    // visible content actually changes. This is exactly what broke when the
    // Part-banner repositioning logic raced the template's own part-switch
    // rendering (real incident, commit 74c4e07).
    const partTabCount = await page.locator('.part-tab[data-part]').count();
    if (partTabCount > 1) {
      let previousText = null;
      for (let i = 0; i < Math.min(partTabCount, 4); i += 1) {
        await page.locator('.part-tab[data-part]').nth(i).click();
        await page.waitForTimeout(300);
        const text = await page.evaluate(() => document.body.innerText.slice(0, 3000));
        if (previousText !== null && text === previousText) {
          failures.push(`Part ${i + 1} shows identical content to the previous part -- passage/question switching is broken`);
        }
        previousText = text;
      }
      // Leave it on Part 1 so the answer-selection check below has a clean
      // set of inputs to work with.
      await page.locator('.part-tab[data-part]').nth(0).click();
      await page.waitForTimeout(300);
    }

    // Answer selection: a click on a radio option must register as checked.
    // Only consider inputs that are actually visible -- these templates keep
    // every section's markup in the DOM at once and hide the inactive ones,
    // so an unfiltered "first radio in the document" can land on one that's
    // legitimately hidden behind another section, which isn't a real bug.
    const firstRadio = page.locator('input[type="radio"]:visible').first();
    if (await firstRadio.count()) {
      await firstRadio.click();
      const checked = await firstRadio.evaluate((el) => el.checked);
      if (!checked) failures.push('Clicking an answer radio button did not register as checked -- answer selection is broken');
    }

    // Fill-in-the-blank inputs must accept typed text.
    const firstTextInput = page.locator('input[type="text"]:visible').first();
    if (await firstTextInput.count()) {
      await firstTextInput.fill('smoketest');
      const value = await firstTextInput.evaluate((el) => el.value);
      if (value !== 'smoketest') failures.push('Typing into a text-answer input did not register -- answer entry is broken');
    }

    // Timer sanity: only meaningful for Reading-type templates, whose clock
    // is a plain wall-clock running from page load. Listening templates tie
    // their internal clock to actual audio playback, which headless Chromium
    // can't reliably exercise, so checking it here would be noise, not signal.
    const hasAudio = (await page.locator('audio').count()) > 0;
    const timerEl = page.locator('#timerDisplay').first();
    if (!hasAudio && (await timerEl.count())) {
      const before = (await timerEl.textContent()).trim();
      await page.waitForTimeout(2500);
      const after = (await timerEl.textContent()).trim();
      if (before === after) {
        failures.push(`Timer display did not change after 2.5s (stuck at "${before}") -- timer may be frozen`);
      }
    }
  } catch (error) {
    failures.push(`Unexpected error while testing: ${error.message}`);
  } finally {
    await page.close();
  }
  return failures;
}

async function main() {
  const targetArg = process.argv[2];
  const allFiles = fs.readdirSync(testsDir).filter((f) => f.endsWith('.html'));
  const candidates = targetArg ? [targetArg] : allFiles;

  const files = candidates.filter((name) => {
    const filePath = path.join(testsDir, name);
    if (!fs.existsSync(filePath)) {
      console.error(`No such file: ${filePath}`);
      return false;
    }
    return isHarvestBridgeTemplate(fs.readFileSync(filePath, 'utf8'));
  });

  if (files.length === 0) {
    console.log('No harvest-bridge templates found to test.');
    return;
  }

  if (!(await isServerUp())) {
    console.error(`Local server is not reachable at ${baseUrl}. Start it first: node server/server.js`);
    process.exitCode = 1;
    return;
  }

  const browser = await chromium.launch();
  let anyFailed = false;

  for (const name of files) {
    process.stdout.write(`Testing ${name} ... `);
    const failures = await smokeTestFile(browser, name);
    if (failures.length === 0) {
      console.log('OK');
    } else {
      anyFailed = true;
      console.log('FAILED');
      failures.forEach((f) => console.log(`  - ${f}`));
    }
  }

  await browser.close();

  if (anyFailed) {
    console.error('\nSmoke test failed -- do not release the affected test(s) to students until this is fixed.');
    process.exitCode = 1;
  } else {
    console.log('\nAll templates passed the smoke test.');
  }
}

main();
