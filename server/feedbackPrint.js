// Renders approved feedback as a print-ready page: one student per sheet, laid
// out like the teacher's own feedback document. Saved as PDF from the browser's
// print dialog rather than generated server-side -- no PDF library to install,
// no font packaging, and the teacher gets to see exactly what will print before
// it prints.

const escapeHtml = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// The feedback is markdown from the model. Rendering just the subset it is told
// to produce -- headings, bold, bullets, numbered items, rules -- keeps this
// dependency-free and predictable, and anything unexpected degrades to plain
// text rather than leaking raw tags onto a student's page.
function renderMarkdown(md) {
  const lines = String(md || '').split(/\r?\n/);
  const out = [];
  let listType = null;

  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  const inline = t => escapeHtml(t)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+?)\*/g, '$1<em>$2</em>');

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); continue; }
    if (/^---+$/.test(line.trim())) { closeList(); out.push('<hr>'); continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) { closeList(); const level = Math.min(heading[1].length + 1, 5); out.push(`<h${level}>${inline(heading[2])}</h${level}>`); continue; }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) { if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; } out.push(`<li>${inline(bullet[1])}</li>`); continue; }

    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (numbered) { if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; } out.push(`<li>${inline(numbered[1])}</li>`); continue; }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

export function renderFeedbackSheets({ testTitle, taskLabel, students }) {
  const pages = students.map(s => `
  <article class="sheet">
    <header class="sheet-head">
      <h1>${escapeHtml(s.name)}</h1>
      <p class="meta">${[s.group, s.studentId, `${s.words} words`].filter(Boolean).map(escapeHtml).join(' &middot; ')}</p>
      <p class="paper">${escapeHtml(testTitle)} &middot; ${escapeHtml(taskLabel)}</p>
    </header>
    <div class="body">${renderMarkdown(s.feedback)}</div>
  </article>`).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(testTitle)} — feedback</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  *{box-sizing:border-box}
  body{margin:0;background:#f2f3f7;color:#16181d;
       font:12pt/1.5 Georgia,"Times New Roman",serif}
  .toolbar{position:sticky;top:0;background:#fff;border-bottom:1px solid #dcdfe8;
           padding:12px 18px;display:flex;gap:12px;align-items:center;
           font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px}
  .toolbar button{border:0;background:#5b5bd6;color:#fff;font:inherit;font-weight:600;
                  padding:9px 16px;border-radius:8px;cursor:pointer}
  .toolbar span{color:#5b6472}
  .sheet{background:#fff;max-width:190mm;margin:18px auto;padding:16mm 15mm;
         box-shadow:0 1px 4px rgba(0,0,0,.10)}
  .sheet-head{border-bottom:2px solid #16181d;padding-bottom:8px;margin-bottom:14px}
  .sheet-head h1{margin:0;font-size:19pt;letter-spacing:-.01em}
  .meta{margin:4px 0 0;font-size:10.5pt;color:#4a5160}
  .paper{margin:2px 0 0;font-size:10pt;color:#6b7280;font-style:italic}
  .body h2{font-size:13.5pt;margin:18px 0 6px;border-bottom:1px solid #dcdfe8;padding-bottom:3px}
  .body h3{font-size:12pt;margin:14px 0 5px}
  .body p{margin:7px 0}
  .body ul,.body ol{margin:7px 0 7px 20px;padding:0}
  .body li{margin:4px 0}
  .body hr{border:0;border-top:1px solid #e6e8ef;margin:14px 0}
  .body strong{font-weight:700}
  @media print{
    body{background:#fff}
    .toolbar{display:none}
    .sheet{margin:0;padding:0;box-shadow:none;max-width:none;
           page-break-after:always;break-after:page}
    .sheet:last-child{page-break-after:auto;break-after:auto}
    .body h2,.body h3{break-after:avoid}
    .body li,.body p{break-inside:avoid}
  }
</style></head>
<body>
  <div class="toolbar">
    <button onclick="window.print()">Save as PDF</button>
    <span>${students.length} student${students.length === 1 ? '' : 's'} &middot; one per page. In the print dialog choose <strong>Save as PDF</strong>.</span>
  </div>
${pages}
</body></html>`;
}
