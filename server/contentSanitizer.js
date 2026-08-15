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
  // The welcome-modal generation is a gate too: its Start button is inert until
  // a name is typed, so without the bypass the test never begins.
  const gateFound = /id=["']screen-password["']/.test(html)
    || /REQUIRED_PASSWORD/.test(html)
    || /id=["']studentNameInput["']/.test(html);
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

    // Newer generations use a welcome modal asking for a name and group instead
    // of the password/ID screens above. Its Start button does nothing while the
    // name is blank -- and says nothing either, so the test simply never begins
    // and the student is left staring at a modal that looks ready.
    //
    // The name is prefilled from the session the platform already authenticated.
    // The button is deliberately NOT clicked: the audio starts on Start and
    // cannot be replayed, so beginning it before the student is ready would cost
    // them the opening of Section 1.
    var nameInput = document.getElementById('studentNameInput');
    if (nameInput && !nameInput.value) {
      nameInput.value = studentId;
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      nameInput.dispatchEvent(new Event('change', { bubbles: true }));
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

// Uploaded papers carry the source channel's branding -- handles in the title
// bar, "join the channel" pills, t.me links. Students sit these as the school's
// own mock, so the other channel's name has no business on the page.
//
// Only the markup outside <script> is touched. Script bodies are left exactly as
// they are: these files use the channel name inside localStorage keys and
// element ids, and rewriting those would break note-saving and question wiring
// to remove text nobody ever sees.
export function removeSourceBranding(html) {
  if (!html) return { html, removedCount: 0 };
  // Longest forms first, so "CDIELTSsources" is not left as a stray "sources".
  const HANDLE = /@?\s*(CD\s*IELTS\s*sources|cdieltssources|ieltsxuz|ieltsx\.com|Fozilbek[^<|,]*|IELTS Mock Team|CD\s*IELTS|CDIELTS)/gi;
  let removedCount = 0;

  // Split on script/style so their contents are never rewritten.
  const parts = html.split(/(<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>)/i);
  const cleaned = parts.map((part, i) => {
    if (i % 2 === 1) return part;               // odd indexes are the script/style blocks
    return part
      // Anchors to the source channel, link and label together.
      .replace(/<a\b[^>]*href=["'][^"']*t\.me\/[^"']*["'][^>]*>[\s\S]*?<\/a>/gi, () => { removedCount++; return ''; })
      .replace(HANDLE, () => { removedCount++; return ''; })
      // Tidy separators left stranded once a handle between them is gone.
      .replace(/(\s*[|·—–-]\s*)+(?=<\/(title|h1|h2|h3|p|span|div)>)/gi, '')
      .replace(/<title>\s*[|·—–-]?\s*/i, '<title>');
  }).join('');

  return { html: cleaned, removedCount };
}

export function sanitizeTestHtml(html) {
  const mojibake = fixMojibake(html);
  const gate = removeAccessGate(mojibake.html);
  const vocab = removeVocabularyHelpers(gate.html);
  const branding = removeSourceBranding(vocab.html);
  return {
    html: branding.html,
    mojibakeFixedCount: mojibake.fixedCount,
    gateRemoved: gate.changed,
    vocabHelpersRemoved: vocab.removedCount,
    brandingRemoved: branding.removedCount
  };
}
