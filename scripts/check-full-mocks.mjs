import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientTests = path.join(repoRoot, 'client', 'public', 'tests');
const serverTests = path.join(repoRoot, 'server', 'public', 'tests');
const legacyMocks = [1, 2, 3];
const modernMocks = [4, 5, 6, 7, 8, 9, 21, 22];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function count(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function checkSyntax(name, html) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(match => !/\bsrc\s*=/.test(match[1]));
  scripts.forEach((match, index) => {
    new vm.Script(match[2], { filename: `${name}:script${index + 1}` });
  });
}

for (const number of [...legacyMocks, ...modernMocks]) {
  const name = `mock${number}.html`;
  const html = fs.readFileSync(path.join(clientTests, name), 'utf8');
  checkSyntax(name, html);
  assert(html.includes('/api/student/submit/'), `${name} has no backend submission`);
  assert(html.includes('IELTS_TEST_SUBMITTED'), `${name} has no completion message`);

  if (legacyMocks.includes(number)) {
    assert(!html.includes('getIeltsBand(lRes?.correctCount'), `${name} still uses undefined lRes`);
    assert(!html.includes('getIeltsBand(rRes?.correctCount'), `${name} still uses undefined rRes`);
    assert(html.includes('listeningScore: getIeltsBand(lScore)'), `${name} does not submit its listening score`);
    assert(html.includes('readingScore: getIeltsBand(rScore)'), `${name} does not submit its reading score`);
  } else {
    assert(count(html, /function\s+saveProgressToStorage\s*\(/g) === 1, `${name} needs exactly one save function`);
    assert(count(html, /function\s+restoreProgressFromStorage\s*\(/g) === 1, `${name} needs exactly one restore function`);
    assert(!html.includes('// LocalStorage Progress Auto-Save & Recovery'), `${name} still has the misplaced progress block`);
    assert(html.includes('restoreProgressFromStorage(); startRestoredStage();'), `${name} does not restore its saved stage`);
  }
}

for (let number = 1; number <= 9; number += 1) {
  const name = `mock${number}.html`;
  const client = fs.readFileSync(path.join(clientTests, name));
  const server = fs.readFileSync(path.join(serverTests, name));
  assert(client.equals(server), `${name} differs between client and deployed server copies`);
}

console.log('Full mock reliability checks passed for all 11 full tests.');
