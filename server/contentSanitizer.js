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

    // Prefilling the name was not enough -- the modal still would not clear.
    // So the window goes entirely: the platform already knows who the student
    // is, and it only ever stood between them and the test.
    //
    // Its Start button is still what begins the audio, and browsers only allow
    // playback to begin from a real user gesture (which is why a scripted click
    // could never open this). So the button is pressed on the student's first
    // real click or keypress anywhere on the page -- inside that gesture, so
    // playback is permitted -- and only once.
    var startModal = document.getElementById('startModal');
    var startBtn = document.getElementById('startTestBtn');
    if (startModal) {
      startModal.style.setProperty('display', 'none', 'important');
      if (startBtn) {
        var started = false;
        var beginOnFirstGesture = function () {
          if (started) return;
          started = true;
          document.removeEventListener('click', beginOnFirstGesture, true);
          document.removeEventListener('keydown', beginOnFirstGesture, true);
          // Start the audio directly. Clicking the template's Start button was
          // the wrong lever -- in this generation it carries no handler at all,
          // so nothing happened. The player's own play control does the work,
          // and its icon renders as a broken glyph here, so a student cannot
          // reliably find it either. Playback is allowed because this runs
          // inside the student's own click or keypress.
          try {
            var track = document.querySelector('audio');
            if (track && track.paused) track.play();
          } catch (e) {}
          try { startBtn.click(); } catch (e) {}
          try { startModal.style.setProperty('display', 'none', 'important'); } catch (e) {}
        };
        document.addEventListener('click', beginOnFirstGesture, true);
        document.addEventListener('keydown', beginOnFirstGesture, true);
      }
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

// Newer generations of the template tile the source's handle across every page
// as a CSS background: an inline SVG data URI holding the text, set on body or a
// .watermark layer. removeSourceBranding cannot reach it -- that function skips
// <style> blocks on purpose, because these files keep the channel name inside
// localStorage keys and element ids where rewriting it breaks the page.
//
// So this handles the one case inside <style> that is genuinely visible to a
// student: a background-image whose SVG payload contains the handle. The URL is
// dropped rather than the whole rule, which leaves the layer's sizing and
// opacity intact and simply gives it nothing to paint.
export function removeWatermarks(html) {
  if (!html) return { html, removedCount: 0 };
  let removedCount = 0;

  const cleaned = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, block =>
    block
      // The payload is quoted, which is the only way to write a data URI that
      // contains parentheses -- and these do: the text is rotated with
      // transform='rotate(-22 210 110)'. Matching to the closing quote rather
      // than the closing paren is therefore required, not merely tidier.
      .replace(
        /background-image\s*:\s*url\(\s*(["'])data:image\/svg\+xml[\s\S]*?\1\s*\)\s*;?/gi,
        match => {
          // Only the ones actually carrying branding text. An inline SVG
          // background is also a legitimate way to draw a tick or a chevron,
          // and those must survive.
          const branded = /CD\s*IELTS|cdieltssources|ieltsx/i.test(match);
          // By the time this runs in the upload pipeline the handle has usually
          // already been stripped, leaving <text ...></text> -- a rule that
          // paints nothing but is still a watermark layer sized and tiled across
          // every page. An empty <text> in a background SVG has no other purpose,
          // so treat it as the same leftover rather than leaving dead CSS behind.
          const emptyText = /<text\b[^>]*>\s*<\/text>/i.test(match);
          if (!branded && !emptyText) return match;
          removedCount++;
          return 'background-image: none;';
        }
      )
      // The handle also sits in the section comment above the rule. Invisible to
      // a student, but it is the label that makes the leftover rule obvious to
      // anyone reading the file, so it goes with it.
      .replace(/\/\*[^*]*?(CD\s*IELTS\s*sources|cdieltssources|@CDIELTS)[\s\S]*?\*\//gi,
        () => '/* ---- Watermark layer (removed) ---- */')
  );

  return { html: cleaned, removedCount };
}

export function sanitizeTestHtml(html) {
  const mojibake = fixMojibake(html);
  const gate = removeAccessGate(mojibake.html);
  const vocab = removeVocabularyHelpers(gate.html);
  const branding = removeSourceBranding(vocab.html);
  const watermarks = removeWatermarks(branding.html);
  return {
    html: watermarks.html,
    mojibakeFixedCount: mojibake.fixedCount,
    gateRemoved: gate.changed,
    vocabHelpersRemoved: vocab.removedCount,
    brandingRemoved: branding.removedCount,
    watermarksRemoved: watermarks.removedCount
  };
}
