// Builds the same per-question Listening/Reading review shown in
// renderReviewColumn (TeacherDashboard.jsx and StudentDashboard.jsx both have
// their own copy of that table) as a downloadable PDF, so a student can keep
// their detailed review offline instead of only ever seeing it on-screen.
// Takes a normalized options object rather than a raw submission row, since
// the teacher and student dashboards fetch differently-shaped data for the
// same submission (e.g. test_title vs title).
export function generateDetailedReviewPdf({
  studentName,
  studentId,
  testTitle,
  submittedAt,
  listeningScore,
  readingScore,
  listeningDetail,
  readingDetail,
  listeningAnswers,
  readingAnswers,
  answerKey,
}) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const M = 14, W = 182;
  let y = 20;

  doc.setFillColor(99, 102, 241);
  doc.rect(0, 0, 210, 20, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('IELTS DETAILED LISTENING & READING REVIEW', M, 13);

  doc.setTextColor(20, 20, 20);
  doc.setFontSize(16);
  doc.text(testTitle || 'IELTS Mock Test', M, 35);
  doc.setDrawColor(226, 232, 240);
  doc.line(M, 38, 210 - M, 38);

  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('Candidate Name:', M, 48);
  doc.setFont('helvetica', 'normal');
  doc.text(studentName || '-', M + 40, 48);

  doc.setFont('helvetica', 'bold');
  doc.text('Candidate ID:', M, 55);
  doc.setFont('helvetica', 'normal');
  doc.text(studentId || '-', M + 40, 55);

  doc.setFont('helvetica', 'bold');
  doc.text('Date of Submission:', M, 62);
  doc.setFont('helvetica', 'normal');
  doc.text(submittedAt ? new Date(submittedAt).toLocaleString() : '-', M + 40, 62);

  y = 75;

  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

  function drawSection(title, bandScore, detail, prefix, rawAnswers) {
    if (!detail && !answerKey) return;

    if (y > 255) { doc.addPage(); y = 20; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(20, 20, 20);
    doc.text(`${title} -- Band ${bandScore !== null && bandScore !== undefined ? Number(bandScore).toFixed(1) : '-'}`, M, y);
    y += 7;

    doc.setFillColor(241, 245, 249);
    doc.rect(M, y - 4, W, 6, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(71, 85, 105);
    doc.text('Q', M + 2, y);
    doc.text('Student Answer', M + 16, y);
    doc.text('Correct Key', M + 90, y);
    doc.text('Status', M + 150, y);
    y += 6;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    for (let qNum = 1; qNum <= 40; qNum++) {
      let studentAns, correctAns, isOk;
      if (detail) {
        const d = detail[qNum];
        if (!d) continue;
        studentAns = d.userAnswer || '';
        correctAns = d.correctAnswer ?? '-';
        isOk = !!d.isCorrect;
      } else {
        studentAns = rawAnswers?.[qNum] || '';
        const correctArr = answerKey.answers[prefix + qNum] || [];
        correctAns = answerKey.display[prefix + qNum] || correctArr.join(' / ') || '-';
        isOk = correctArr.some((a) => norm(a) === norm(studentAns));
      }

      if (y > 280) { doc.addPage(); y = 20; }

      doc.setTextColor(20, 20, 20);
      doc.text(String(qNum), M + 2, y);
      doc.text(doc.splitTextToSize(studentAns || '-', 70)[0] || '-', M + 16, y);
      doc.text(doc.splitTextToSize(String(correctAns), 55)[0] || '-', M + 90, y);
      if (isOk) doc.setTextColor(16, 185, 129);
      else if (studentAns) doc.setTextColor(220, 38, 38);
      else doc.setTextColor(148, 163, 184);
      doc.text(isOk ? 'Correct' : (studentAns ? 'Wrong' : 'Empty'), M + 150, y);
      y += 5.5;
    }
    y += 6;
  }

  drawSection('Listening', listeningScore, listeningDetail, 'l', listeningAnswers);
  drawSection('Reading', readingScore, readingDetail, 'r', readingAnswers);

  const totalPages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text(`Page ${p} of ${totalPages}`, 210 - M, 290, { align: 'right' });
  }

  const safeName = (studentName || 'Student').replace(/[^a-zA-Z0-9]/g, '_');
  doc.save(`IELTS_Detailed_Review_${safeName}.pdf`);
}
