import iconv from 'iconv-lite';

// Detects text that was double-encoded through the CP866 (DOS/Windows Cyrillic
// OEM) codepage -- the classic symptom of a Windows tool reading UTF-8 emoji
// bytes as CP866 and re-saving them, producing garbage like "ЁЯУЭ" for "📝".
// Real, already-correct text (including genuine Cyrillic) round-trips losslessly
// through this check and is left untouched.
function tryFixMojibakeSpan(span) {
  const buf = iconv.encode(span, 'cp866');
  const back = iconv.decode(buf, 'cp866');
  if (back !== span) return null;
  const utf8Str = buf.toString('utf8');
  if (utf8Str.includes('�')) return null;
  return utf8Str;
}

export function fixMojibake(text) {
  let fixedCount = 0;
  // Uploaded files can be tens of megabytes (embedded base64 audio), almost
  // entirely plain ASCII. Only scan for runs of non-ASCII characters via regex
  // (native, efficient) rather than rebuilding the whole string one character
  // at a time -- the latter is slow/memory-heavy enough on a large file to hang
  // the process.
  const result = text.replace(/[^\x00-\x7f]+/gu, (span) => {
    const fixed = tryFixMojibakeSpan(span);
    if (fixed) {
      fixedCount += 1;
      return fixed;
    }
    return span;
  });
  return { html: result, fixedCount };
}

const BYPASS_MARKER = 'IELTS-PLATFORM-GATE-BYPASS';

// Some uploaded mock tests carry their own password / Test-Taker-ID "gate"
// screens, left over from being distributed as standalone files before they
// were part of this platform. Students are already authenticated here, so the
// gate is pure friction. This removes any existing (and possibly broken or
// iframe-only) bypass attempt and replaces it with one canonical, always-run
// version that works whether the file is opened standalone or embedded.
function stripExistingBypassScripts(html) {
  return html.replace(
    /<script>\s*\/\/ Auto-bypass password\/ID gate[\s\S]*?<\/script>\s*/gi,
    ''
  );
}

export function removeAccessGate(html) {
  const gateFound = /id=["']screen-password["']/.test(html) || /REQUIRED_PASSWORD/.test(html);
  if (!gateFound) {
    return { html, gateFound: false, changed: false };
  }
  if (html.includes(BYPASS_MARKER)) {
    return { html, gateFound: true, changed: false };
  }

  const cleaned = stripExistingBypassScripts(html);
  const bypassScript = `
<script>
// ${BYPASS_MARKER}
// Auto-bypass password/Test-Taker-ID gate: students are already authenticated
// on the platform, so this legacy per-file gate is redundant. Runs whether the
// test is opened standalone or embedded in an iframe.
(function() {
  function bypassGate() {
    var params = new URLSearchParams(window.location.search);
    var studentId = params.get('studentId') || 'STUDENT';

    var pwdScreen = document.getElementById('screen-password');
    if (pwdScreen) pwdScreen.style.display = 'none';

    var idScreen = document.getElementById('screen-id');
    if (idScreen) idScreen.style.display = 'none';

    var idInput = document.getElementById('id-input');
    if (idInput) { idInput.value = studentId; }

    var testScreen = document.getElementById('screen-test');
    if (testScreen) testScreen.style.display = 'flex';

    var idSubmit = document.getElementById('id-submit');
    if (idSubmit) {
      setTimeout(function() { idSubmit.click(); }, 50);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bypassGate);
  } else {
    bypassGate();
  }
})();
</script>
`;

  const injected = cleaned.includes('</head>')
    ? cleaned.replace('</head>', `${bypassScript}</head>`)
    : `${cleaned}${bypassScript}`;

  return { html: injected, gateFound: true, changed: true };
}

// Some passages ship a vocabulary study aid: selected words are wrapped in
// <span class="vocab-word"> so they appear underlined, and clicking one pops up
// its pronunciation, definition and translation. That belongs in a study copy,
// not an exam -- it draws the eye to particular words and hands over meanings a
// candidate is supposed to work out from context.
//
// The wrapper is unwrapped and the word inside is kept: those words are part of
// the passage, so deleting the element would silently cut text out of the
// reading. The stylesheet and lookup table are left alone -- with no wrappers
// left they match nothing, and removing a table other code may still reference
// risks a script error mid-exam for no visible gain.
export function removeVocabularyHelpers(html) {
  if (!html || !html.includes('vocab-word')) return { html, removedCount: 0 };
  let removedCount = 0;
  const unwrapped = html.replace(
    /<span\b[^>]*class="[^"]*\bvocab-word\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi,
    (match, inner) => { removedCount++; return inner; }
  );
  return { html: unwrapped, removedCount };
}

export function sanitizeTestHtml(html) {
  const mojibake = fixMojibake(html);
  const gate = removeAccessGate(mojibake.html);
  const vocab = removeVocabularyHelpers(gate.html);
  return {
    html: vocab.html,
    mojibakeFixedCount: mojibake.fixedCount,
    gateRemoved: gate.changed,
    vocabHelpersRemoved: vocab.removedCount
  };
}
