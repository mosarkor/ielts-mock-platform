import React, { useState, useEffect } from 'react';
import ChangePasswordModal from '../components/ChangePasswordModal';

export default function TeacherDashboard({ user, onLogout, theme, toggleTheme }) {
  const [showPwdModal, setShowPwdModal] = useState(false);
  const [submissions, setSubmissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Selected submission for grading
  const [selectedSub, setSelectedSub] = useState(null);
  const [viewMode, setViewMode] = useState('grading'); // 'grading' or 'detailed_review'
  const [answerKey, setAnswerKey] = useState(null);
  const [loadingKey, setLoadingKey] = useState(false);

  // Rubric scores state
  const [rubric, setRubric] = useState({ ta: 6.0, cc: 6.0, lr: 6.0, gra: 6.0 });
  const [feedbackText, setFeedbackText] = useState('');
  const [releaseImmediately, setReleaseImmediately] = useState(true);

  // Search & Filter States
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [integrityFilter, setIntegrityFilter] = useState('all');
  const [groupFilter, setGroupFilter] = useState('all');

  // IELTS Band Descriptor guide lookup
  const descriptors = {
    ta: {
      9: "Fully addresses all parts of the task. Presents a fully developed response.",
      8.5: "Fully addresses task requirements with natural, well-supported progression.",
      8: "Sufficiently addresses all parts of the task. Presents a well-developed response with relevant details.",
      7.5: "Addresses all parts of the task with clear details and strong supporting evidence.",
      7: "Addresses all parts of the task. Clear overview and well-selected details.",
      6.5: "Addresses the requirements, with a clear focus, though some aspects are more fully covered than others.",
      6: "Addresses the requirements of the task, though some details may be irrelevant or incorrect.",
      5.5: "Partially addresses task requirements, but lacks detail or focus in certain parts.",
      5: "Only partially addresses the requirements. Key features may be missing or inadequately covered.",
      4.5: "Attempts to address the task but key features are highly unclear or repetitive.",
      4: "Attempts to address the task but fails to provide a clear overview or relevant details.",
      3.5: "Extremely limited response. Major task elements are completely unaddressed.",
      3: "Response is barely relevant, mostly off-topic or extremely short.",
      2.5: "Extremely minimal or disjointed response.",
      2: "Barely attempts the task. Content is unrelated.",
      1.5: "Extremely fragmented words.",
      1: "Answer is completely irrelevant or copy-pasted prompt.",
      0: "No task response provided."
    },
    cc: {
      9: "Uses cohesion in such a way that it attracts no attention. Skillfully manages paragraphing.",
      8.5: "Exceptional cohesion, natural structure, seamless paragraph transitions.",
      8: "Sequences information and ideas logically. Uses a wide range of cohesive devices appropriately.",
      7.5: "Logical progression throughout, clear paragraphing with minor errors in cohesive devices.",
      7: "Logically organizes information and ideas. Clear progression throughout.",
      6.5: "Clear progression, although cohesion and reference devices may occasionally be repetitive.",
      6: "Arranges information and ideas coherently. Paragraphing may not be logical.",
      5.5: "Coherence is present but relationships between ideas are sometimes disjointed.",
      5: "Presents information with some organization but lacks overall progression.",
      4.5: "Frequent mistakes in paragraphing, progression is difficult to follow.",
      4: "Presents information without logical organization. Paragraphing is absent or confusing.",
      3.5: "Lack of paragraphing, highly disorganized ideas.",
      3: "Extremely hard to follow, ideas are mostly disconnected.",
      2.5: "Coherence is completely absent.",
      2: "Extremely disjointed words.",
      1.5: "Fails to communicate a cohesive message.",
      1: "Fails to organize any coherent sentences.",
      0: "No coherent structure."
    },
    lr: {
      9: "Uses a wide range of vocabulary with natural and sophisticated control. Rare minor slips.",
      8.5: "Very broad lexical resource, natural collocation, extremely rare slips.",
      8: "Uses a wide range of vocabulary. Uses uncommon lexical items fluently with occasional errors.",
      7.5: "Sufficiently wide vocabulary with clear flexibility and precise word choices.",
      7: "Uses a sufficient range of vocabulary to allow flexibility. Uses some less common lexical items.",
      6.5: "Adequate vocabulary with some attempts at advanced style and minor errors.",
      6: "Uses an adequate range of vocabulary. Makes some errors in spelling and/or word formation.",
      5.5: "Vocabulary is limited but sufficient to express basic ideas. Frequent errors.",
      5: "Uses a limited range of vocabulary. Spelling/word formation errors may cause some difficulty.",
      4.5: "Limited vocabulary causes regular communication difficulties.",
      4: "Uses only basic vocabulary. Frequent errors cause major communication barriers.",
      3.5: "Vocabulary is highly insufficient, severe spelling errors.",
      3: "Extremely limited words.",
      2.5: "Only isolated words.",
      2: "Extremely poor word choice.",
      1.5: "Fails to demonstrate basic vocabulary.",
      1: "Barely writes single words.",
      0: "No vocabulary resource demonstrated."
    },
    gra: {
      9: "Uses a wide range of structures with full flexibility and accuracy. Rare minor slips.",
      8.5: "Excellent sentence variety, flawless grammar with extremely minor slips.",
      8: "Uses a wide range of structures. Most sentences are error-free.",
      7.5: "Produces frequent error-free sentences with diverse complex structures.",
      7: "Uses a variety of complex structures. Produces frequent error-free sentences.",
      6.5: "Good mix of complex sentences with minor errors that do not affect communication.",
      6: "Uses a mix of simple and complex sentence forms. Some grammatical errors occur.",
      5.5: "Frequent grammatical mistakes, complex structures often result in errors.",
      5: "Uses only a limited range of structures. Grammatical errors are frequent.",
      4.5: "Errors predominate, making comprehension difficult in most sentences.",
      4: "Uses basic structures. Errors predominate and grammar causes difficulty.",
      3.5: "Frequent errors block communication completely.",
      3: "Extremely basic or broken structures.",
      2.5: "Fails to construct simple sentences.",
      2: "Only a few basic words.",
      1.5: "No sentence grammar.",
      1: "Extremely fragmented structure.",
      0: "No grammatical range demonstrated."
    }
  };

  useEffect(() => {
    fetchSubmissions();
  }, []);

  useEffect(() => {
    if (selectedSub) {
      loadAnswerKey(selectedSub);
    } else {
      setAnswerKey(null);
    }
  }, [selectedSub]);

  const loadAnswerKey = async (sub) => {
    setLoadingKey(true);
    try {
      let iframeUrl = `/tests/mock${sub.test_id}.html`;
      if (sub.listening_data) {
        try {
          const lData = JSON.parse(sub.listening_data);
          if (lData.iframeUrl) {
            iframeUrl = lData.iframeUrl;
          }
        } catch(e) {}
      }
      
      const res = await fetch(iframeUrl);
      if (!res.ok) throw new Error('Answer key not found');
      const html = await res.text();
      
      const answersMatch = html.match(/const\s+ANSWERS\s*=\s*({[^;]+});/);
      const displayAnswersMatch = html.match(/const\s+DISPLAY_ANSWERS\s*=\s*({[^;]+});/);
      
      if (answersMatch) {
        const answersObj = JSON.parse(answersMatch[1]);
        const displayObj = displayAnswersMatch ? JSON.parse(displayAnswersMatch[1]) : {};
        setAnswerKey({ answers: answersObj, display: displayObj });
      }
    } catch (err) {
      console.error('Failed to load answer key:', err);
    } finally {
      setLoadingKey(false);
    }
  };

  const fetchSubmissions = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/teacher/submissions');
      if (!res.ok) throw new Error('Failed to fetch submissions list');
      const data = await res.json();
      setSubmissions(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectSubmission = (sub) => {
    setSelectedSub(sub);
    setViewMode('grading');
    if (sub.writing_scores) {
      setRubric(sub.writing_scores);
    } else {
      setRubric({ ta: 6.0, cc: 6.0, lr: 6.0, gra: 6.0 });
    }
    setFeedbackText(sub.teacher_feedback || '');
    setReleaseImmediately(sub.is_revealed === 1);
  };

  const handleRubricChange = (key, value) => {
    setRubric(prev => ({
      ...prev,
      [key]: parseFloat(value)
    }));
  };

  const calculateLiveOverall = () => {
    const avg = (rubric.ta + rubric.cc + rubric.lr + rubric.gra) / 4;
    const decimal = avg - Math.floor(avg);
    if (decimal < 0.25) return Math.floor(avg);
    if (decimal < 0.75) return Math.floor(avg) + 0.5;
    return Math.ceil(avg);
  };

  const handleSaveGrade = async (e) => {
    e.preventDefault();
    if (!selectedSub) return;

    try {
      // 1. Submit the scores & feedback
      const gradeRes = await fetch(`/api/teacher/grade/${selectedSub.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          writingScores: rubric,
          teacherFeedback: feedbackText,
          gradedBy: user.id
        })
      });

      if (!gradeRes.ok) throw new Error('Failed to save rubric scores');
      const gradeData = await gradeRes.json();

      // 2. Submit the reveal toggle status
      const revealRes = await fetch(`/api/teacher/reveal/${selectedSub.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isRevealed: releaseImmediately })
      });
      if (!revealRes.ok) throw new Error('Failed to set score visibility status');

      alert(`Submission successfully graded! Overall Writing Band: ${gradeData.writingScore.toFixed(1)}`);
      setSelectedSub(null);
      fetchSubmissions();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleCopyReport = () => {
    if (!selectedSub || !answerKey) return;
    
    const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const isCorrect = (studentAns, correctAnswersArr) => {
      if (!correctAnswersArr || !correctAnswersArr.length) return false;
      const sNorm = norm(studentAns);
      return correctAnswersArr.some(ans => norm(ans) === sNorm);
    };

    let report = `IELTS Mock Test Center — Performance Report\n`;
    report += `==================================================\n`;
    report += `Candidate ID: ${selectedSub.student_id}\n`;
    report += `Candidate Name: ${selectedSub.student_name}\n`;
    report += `Test Title: ${selectedSub.test_title}\n\n`;
    
    report += `BAND SCORES OVERVIEW:\n`;
    report += `- Listening Score: Band ${selectedSub.listening_score.toFixed(1)}\n`;
    report += `- Reading Score: Band ${selectedSub.reading_score.toFixed(1)}\n`;
    if (selectedSub.writing_score !== null) {
      report += `- Writing Score: Band ${selectedSub.writing_score.toFixed(1)}\n`;
    }
    report += `- Exam Integrity: ${selectedSub.violations_count || 0} Tab switches / Fullscreen exits detected\n`;
    report += `\nINCORRECT & MISSED ANSWERS FEEDBACK:\n\n`;
    
    report += `[🎧 LISTENING SECTION ERRORS]\n`;
    let lErrors = 0;
    for (let i = 1; i <= 40; i++) {
      const studentAns = selectedSub.listening_answers[i] || '';
      const correctArr = answerKey.answers['l' + i] || [];
      const correctText = answerKey.display['l' + i] || correctArr.join(' / ') || '—';
      if (!isCorrect(studentAns, correctArr)) {
        lErrors++;
        report += `Q${i}: Student: "${studentAns || '—'}" | Correct: "${correctText}"\n`;
      }
    }
    if (lErrors === 0) report += `Perfect score in Listening section!\n`;
    report += `\n`;

    report += `[📖 READING SECTION ERRORS]\n`;
    let rErrors = 0;
    for (let i = 1; i <= 40; i++) {
      const studentAns = selectedSub.reading_answers[i] || '';
      const correctArr = answerKey.answers['r' + i] || [];
      const correctText = answerKey.display['r' + i] || correctArr.join(' / ') || '—';
      if (!isCorrect(studentAns, correctArr)) {
        rErrors++;
        report += `Q${i}: Student: "${studentAns || '—'}" | Correct: "${correctText}"\n`;
      }
    }
    if (rErrors === 0) report += `Perfect score in Reading section!\n`;
    
    navigator.clipboard.writeText(report);
    alert('Detailed performance report successfully copied to clipboard!');
  };

  const toggleRevealStatus = async (subId, currentStatus) => {
    try {
      const res = await fetch(`/api/teacher/reveal/${subId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isRevealed: !currentStatus })
      });
      if (!res.ok) throw new Error('Failed to toggle score reveal state');
      fetchSubmissions();
    } catch (err) {
      alert(err.message);
    }
  };

  const calculateAverageClassBand = () => {
    const graded = submissions.filter(s => s.writing_score !== null);
    if (graded.length === 0) return 'N/A';
    const sum = graded.reduce((acc, s) => {
      const overallVal = (s.listening_score + s.reading_score + s.writing_score) / 3;
      const decimal = overallVal - Math.floor(overallVal);
      let roundedOverall = Math.floor(overallVal);
      if (decimal >= 0.25 && decimal < 0.75) roundedOverall += 0.5;
      else if (decimal >= 0.75) roundedOverall += 1.0;
      return acc + roundedOverall;
    }, 0);
    return (sum / graded.length).toFixed(1);
  };

  const downloadPdfReport = (sub) => {
    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const M = 14, W = 182;
      const now = new Date(sub.submitted_at);

      // Title header band
      doc.setFillColor(99, 102, 241); // indigo
      doc.rect(0, 0, 210, 20, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(14);
      doc.text('IELTS MOCK EXAM ASSESSMENT REPORT', M, 13);

      doc.setTextColor(20, 20, 20);
      doc.setFontSize(16);
      doc.text(sub.test_title || 'IELTS Mock Test', M, 35);
      doc.setDrawColor(226, 232, 240);
      doc.line(M, 38, 210 - M, 38);

      // Student info table
      doc.setFontSize(10);
      doc.setFont('helvetica', 'bold');
      doc.text('Candidate Name:', M, 48);
      doc.setFont('helvetica', 'normal');
      doc.text(sub.student_name, M + 40, 48);

      doc.setFont('helvetica', 'bold');
      doc.text('Candidate ID:', M, 55);
      doc.setFont('helvetica', 'normal');
      doc.text(sub.student_id, M + 40, 55);

      doc.setFont('helvetica', 'bold');
      doc.text('Date of Submission:', M, 62);
      doc.setFont('helvetica', 'normal');
      doc.text(now.toLocaleString(), M + 40, 62);

      doc.setFont('helvetica', 'bold');
      doc.text('Proctoring Log:', M, 69);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(sub.violations_count > 0 ? 239 : 16, sub.violations_count > 0 ? 68 : 185, sub.violations_count > 0 ? 68 : 129);
      doc.text(sub.violations_count > 0 ? `${sub.violations_count} Tab switches/focus losses detected` : 'Clean session (No proctoring warnings)', M + 40, 69);
      doc.setTextColor(20, 20, 20);

      // Score grid banner
      doc.setFillColor(248, 250, 252);
      doc.rect(M, 78, W, 22, 'F');
      doc.rect(M, 78, W, 22);

      const overallVal = ((sub.listening_score + sub.reading_score + (sub.writing_score || 0)) / (sub.writing_score !== null ? 3 : 2));
      const decimal = overallVal - Math.floor(overallVal);
      let roundedOverall = Math.floor(overallVal);
      if (decimal >= 0.25 && decimal < 0.75) roundedOverall += 0.5;
      else if (decimal >= 0.75) roundedOverall += 1.0;

      // Section scores
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(100, 116, 139);
      doc.text('LISTENING', M + 15, 85);
      doc.text('READING', M + 55, 85);
      doc.text('WRITING', M + 95, 85);
      doc.text('OVERALL BAND', M + 140, 85);

      doc.setFontSize(16);
      doc.setTextColor(15, 23, 42);
      doc.text(sub.listening_score.toFixed(1), M + 22, 94);
      doc.text(sub.reading_score.toFixed(1), M + 62, 94);
      doc.text(sub.writing_score !== null ? sub.writing_score.toFixed(1) : 'Pending', M + 102, 94);
      doc.setTextColor(99, 102, 241);
      doc.text(roundedOverall.toFixed(1), M + 148, 94);

      doc.setTextColor(20, 20, 20);
      let y = 112;

      // Writing criteria breakdown if available
      if (sub.writing_scores) {
        const scores = JSON.parse(sub.writing_scores);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.text('Writing Criteria breakdown:', M, y);
        y += 6;

        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        doc.text(`Task Response / Achievement:  ${scores.ta.toFixed(1)}`, M + 5, y);
        doc.text(`Coherence & Cohesion:  ${scores.cc.toFixed(1)}`, M + 95, y);
        y += 6;
        doc.text(`Lexical Resource (Vocabulary):  ${scores.lr.toFixed(1)}`, M + 5, y);
        doc.text(`Grammatical Range & Accuracy:  ${scores.gra.toFixed(1)}`, M + 95, y);
        y += 12;
      }

      // Teacher feedback
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text('Teacher Summary Feedback & Advice:', M, y);
      y += 6;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(50, 50, 50);
      const feedbackLines = doc.splitTextToSize(sub.teacher_feedback || 'No feedback details entered yet.', W - 10);
      for (const line of feedbackLines) {
        if (y > 275) {
          doc.addPage();
          y = 20;
        }
        doc.text(line, M + 5, y);
        y += 5;
      }
      y += 8;

      // Student Essays
      doc.setTextColor(20, 20, 20);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text('Submitted Essays:', M, y);
      y += 8;

      const essays = JSON.parse(sub.writing_answers || '{}');
      
      // Task 1
      doc.setFontSize(9.5);
      doc.text('Writing Task 1:', M + 2, y);
      y += 6;
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(70, 70, 70);
      const t1Lines = doc.splitTextToSize(essays.task1 || '[No response submitted]', W - 10);
      for (const line of t1Lines) {
        if (y > 275) {
          doc.addPage();
          y = 20;
        }
        doc.text(line, M + 5, y);
        y += 5;
      }
      y += 8;

      // Task 2
      doc.setTextColor(20, 20, 20);
      doc.setFont('helvetica', 'bold');
      doc.text('Writing Task 2:', M + 2, y);
      y += 6;
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(70, 70, 70);
      const t2Lines = doc.splitTextToSize(essays.task2 || '[No response submitted]', W - 10);
      for (const line of t2Lines) {
        if (y > 275) {
          doc.addPage();
          y = 20;
        }
        doc.text(line, M + 5, y);
        y += 5;
      }

      // Page footer numbers
      const totalPages = doc.internal.getNumberOfPages();
      for (let p = 1; p <= totalPages; p++) {
        doc.setPage(p);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(150, 150, 150);
        doc.text(`Page ${p} of ${totalPages}`, 210 - M, 287, { align: 'right' });
      }

      doc.save(`IELTS_Report_${sub.student_name.replace(/[^a-zA-Z0-9]/g, '_')}_Mock${sub.test_id}.pdf`);
    } catch (err) {
      console.error('PDF generation failed:', err);
      alert('Could not download PDF report: ' + err.message);
    }
  };

  const getWordCount = (text) => {
    if (!text) return 0;
    return text.trim().split(/\s+/).filter(w => w.length > 0).length;
  };

  const bandOptions = [0, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0];

  const studentGroups = [...new Set(submissions.map(s => s.student_group).filter(Boolean))];

  // Dynamic filter logic
  const filteredSubmissions = submissions.filter(sub => {
    const matchesSearch = sub.student_name.toLowerCase().includes(searchTerm.toLowerCase()) || 
                          sub.student_id.toLowerCase().includes(searchTerm.toLowerCase()) || 
                          sub.test_title.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesStatus = statusFilter === 'all' || 
                          (statusFilter === 'pending' && sub.writing_score === null) ||
                          (statusFilter === 'graded' && sub.writing_score !== null);
    
    const matchesIntegrity = integrityFilter === 'all' || 
                              (integrityFilter === 'clean' && (sub.violations_count || 0) === 0) ||
                              (integrityFilter === 'flagged' && (sub.violations_count || 0) > 0);
    
    const matchesGroup = groupFilter === 'all' || sub.student_group === groupFilter;
    
    return matchesSearch && matchesStatus && matchesIntegrity && matchesGroup;
  });

  const pendingSubmissions = filteredSubmissions.filter(s => s.writing_score === null);
  const gradedSubmissions = filteredSubmissions.filter(s => s.writing_score !== null);

  return (
    <div style={styles.dashboardLayout}>
      <header style={styles.header}>
        <div style={styles.headerTitle}>
          <h2>IELTS <span>Mock Portal</span></h2>
          <span style={styles.badge}>Teacher Assessment Suite</span>
        </div>
        <div style={styles.userInfo}>
          <div style={styles.userMeta}>
            <span style={styles.userName}>{user.name}</span>
            <span style={styles.userId}>Assessor Profile</span>
          </div>
          <button 
            onClick={() => setShowPwdModal(true)} 
            className="theme-toggle-btn"
            style={{ border: 'none', marginRight: '0.75rem' }}
            title="Change Password"
          >
            🔑
          </button>
          <button 
            onClick={toggleTheme} 
            className="theme-toggle-btn"
            style={{ border: 'none', marginRight: '0.75rem' }}
            title="Toggle Light/Dark Theme"
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <button onClick={onLogout} className="btn btn-danger" style={styles.logoutBtn}>
            Logout 🚪
          </button>
        </div>
      </header>

      <main className="container" style={styles.mainContent}>
        {error && <div style={styles.errorAlert}>{error}</div>}

        {loading ? (
          <div style={styles.loadingContainer}>Loading student papers...</div>
        ) : selectedSub ? (
          /* GRADING WORKSPACE SCREEN */
          <div style={styles.gradingWorkspace}>
            <div style={styles.workspaceHeader}>
              <div>
                <button onClick={() => setSelectedSub(null)} className="btn btn-secondary" style={{ marginBottom: '0.5rem' }}>
                  ← Back to Submissions
                </button>
                <h3 style={{ color: 'var(--text-primary)' }}>Grading: {selectedSub.student_name} ({selectedSub.student_id})</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.25rem', flexWrap: 'wrap' }}>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Test paper: {selectedSub.test_title}</span>
                  {selectedSub.violations_count > 0 ? (
                    <span style={{ backgroundColor: 'var(--color-rose)', color: '#ffffff', fontSize: '0.75rem', fontWeight: 'bold', padding: '0.2rem 0.5rem', borderRadius: '4px', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                      ⚠️ {selectedSub.violations_count} Tab Switches
                    </span>
                  ) : (
                    <span style={{ backgroundColor: 'var(--color-emerald)', color: '#ffffff', fontSize: '0.75rem', fontWeight: 'bold', padding: '0.2rem 0.5rem', borderRadius: '4px', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                      🔒 Integrity Verified
                    </span>
                  )}
                </div>
              </div>
              <div style={styles.liveScoreBadge}>
                <span style={styles.liveScoreNum}>{calculateLiveOverall().toFixed(1)}</span>
                <span style={styles.liveScoreLabel}>Live Writing Band</span>
              </div>
            </div>

            {/* View Mode Tabs */}
            <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', userSelect: 'none' }}>
              <button 
                onClick={() => setViewMode('grading')}
                className="btn"
                style={{
                  ...styles.tabBtn,
                  backgroundColor: viewMode === 'grading' ? 'var(--color-indigo)' : 'var(--bg-secondary)',
                  color: '#ffffff',
                  border: '1px solid var(--glass-border)',
                }}
              >
                ✏️ Grade Writing Tasks
              </button>
              <button 
                onClick={() => setViewMode('detailed_review')}
                className="btn"
                style={{
                  ...styles.tabBtn,
                  backgroundColor: viewMode === 'detailed_review' ? 'var(--color-indigo)' : 'var(--bg-secondary)',
                  color: '#ffffff',
                  border: '1px solid var(--glass-border)',
                }}
              >
                📊 Detailed Listening & Reading Review
              </button>
            </div>

            {viewMode === 'grading' ? (
              <div style={styles.workspaceGrid}>
                {/* Left Essay Panel */}
                <div className="card" style={styles.essayPanel}>
                  <div style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '1rem', marginBottom: '1.5rem' }}>
                    <h4 style={{ color: 'var(--text-primary)' }}>Student Writing Answers</h4>
                  </div>

                  <div style={styles.essayBox}>
                    <div style={styles.essayBoxHeader}>
                      <h5>Writing Task 1 Prompt:</h5>
                    </div>
                    <p style={styles.writingPrompt}>Refer to Task 1 instructions assigned in this test.</p>
                    
                    <h5 style={{ color: 'var(--text-secondary)', marginTop: '1rem', marginBottom: '0.5rem' }}>Student Essay (Word count: {getWordCount(selectedSub.writing_answers.task1)}):</h5>
                    <div style={styles.rawEssayText}>{selectedSub.writing_answers.task1 || "No answer submitted"}</div>
                  </div>

                  <div style={{ ...styles.essayBox, marginTop: '2rem' }}>
                    <div style={styles.essayBoxHeader}>
                      <h5>Writing Task 2 Prompt:</h5>
                    </div>
                    <p style={styles.writingPrompt}>Refer to Task 2 instructions assigned in this test.</p>
                    
                    <h5 style={{ color: 'var(--text-secondary)', marginTop: '1rem', marginBottom: '0.5rem' }}>Student Essay (Word count: {getWordCount(selectedSub.writing_answers.task2)}):</h5>
                    <div style={styles.rawEssayText}>{selectedSub.writing_answers.task2 || "No answer submitted"}</div>
                  </div>
                </div>

                {/* Right Grading Panel */}
                <form onSubmit={handleSaveGrade} className="card" style={styles.gradingPanel}>
                  <h4 style={{ color: 'var(--text-primary)', marginBottom: '1.5rem', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '1rem' }}>
                    IELTS Writing Rubric Assessment
                  </h4>

                  <div style={styles.rubricGrid}>
                    <div className="form-group" style={{ display: 'flex', flexDirection: 'column' }}>
                      <label className="form-label">Task Achievement / Response (TR)</label>
                      <select 
                        className="form-input"
                        value={rubric.ta} 
                        onChange={(e) => handleRubricChange('ta', e.target.value)}
                      >
                        {bandOptions.map(val => (
                          <option key={val} value={val}>Band {val.toFixed(1)}</option>
                        ))}
                      </select>
                      <p style={styles.descriptorHint}>
                        💡 {descriptors.ta[rubric.ta.toString()] || "No descriptor found."}
                      </p>
                    </div>

                    <div className="form-group" style={{ display: 'flex', flexDirection: 'column' }}>
                      <label className="form-label">Coherence & Cohesion (CC)</label>
                      <select 
                        className="form-input"
                        value={rubric.cc} 
                        onChange={(e) => handleRubricChange('cc', e.target.value)}
                      >
                        {bandOptions.map(val => (
                          <option key={val} value={val}>Band {val.toFixed(1)}</option>
                        ))}
                      </select>
                      <p style={styles.descriptorHint}>
                        💡 {descriptors.cc[rubric.cc.toString()] || "No descriptor found."}
                      </p>
                    </div>

                    <div className="form-group" style={{ display: 'flex', flexDirection: 'column' }}>
                      <label className="form-label">Lexical Resource (LR)</label>
                      <select 
                        className="form-input"
                        value={rubric.lr} 
                        onChange={(e) => handleRubricChange('lr', e.target.value)}
                      >
                        {bandOptions.map(val => (
                          <option key={val} value={val}>Band {val.toFixed(1)}</option>
                        ))}
                      </select>
                      <p style={styles.descriptorHint}>
                        💡 {descriptors.lr[rubric.lr.toString()] || "No descriptor found."}
                      </p>
                    </div>

                    <div className="form-group" style={{ display: 'flex', flexDirection: 'column' }}>
                      <label className="form-label">Grammatical Range & Accuracy (GRA)</label>
                      <select 
                        className="form-input"
                        value={rubric.gra} 
                        onChange={(e) => handleRubricChange('gra', e.target.value)}
                      >
                        {bandOptions.map(val => (
                          <option key={val} value={val}>Band {val.toFixed(1)}</option>
                        ))}
                      </select>
                      <p style={styles.descriptorHint}>
                        💡 {descriptors.gra[rubric.gra.toString()] || "No descriptor found."}
                      </p>
                    </div>
                  </div>

                  <div className="form-group" style={{ marginTop: '1rem' }}>
                    <label className="form-label">🎧 Listening Calculated Band (Reference)</label>
                    <input type="text" className="form-input" value={`Band ${selectedSub.listening_score.toFixed(1)}`} disabled style={{ opacity: 0.6 }} />
                  </div>

                  <div className="form-group">
                    <label className="form-label">📖 Reading Calculated Band (Reference)</label>
                    <input type="text" className="form-input" value={`Band ${selectedSub.reading_score.toFixed(1)}`} disabled style={{ opacity: 0.6 }} />
                  </div>

                  <div className="form-group" style={{ marginTop: '1.5rem' }}>
                    <label className="form-label">Teacher Written Comments & Advice</label>
                    <textarea 
                      className="form-input"
                      style={{ height: '140px', resize: 'none', lineHeight: '1.5' }}
                      placeholder="Write detailed recommendations on how the student can improve vocabulary, coherence, and grammar patterns..."
                      value={feedbackText}
                      onChange={(e) => setFeedbackText(e.target.value)}
                      required
                    />
                  </div>

                  <div className="form-group" style={styles.toggleRow}>
                    <label style={styles.toggleLabel}>
                      <input 
                        type="checkbox"
                        checked={releaseImmediately} 
                        onChange={(e) => setReleaseImmediately(e.target.checked)}
                      />
                      <span>Release Scores and Feedback to Student Dashboard immediately</span>
                    </label>
                  </div>

                  <button 
                    type="submit" 
                    className="btn btn-success" 
                    style={{ width: '100%', justifyContent: 'center', marginTop: '1.5rem' }}
                  >
                    💾 Save and Finalize Grades
                  </button>
                </form>
              </div>
            ) : (
              <div style={styles.workspaceGrid}>
                {/* Listening Column */}
                <div className="card" style={{ maxHeight: '78vh', display: 'flex', flexDirection: 'column' }}>
                  <div style={{ borderBottom: '1px solid var(--glass-border)', paddingBottom: '1rem', marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h4 style={{ color: 'var(--text-primary)' }}>🎧 Listening Overview</h4>
                    <span style={{ fontSize: '1.1rem', fontWeight: 'bold', color: '#6366f1' }}>
                      Band {selectedSub.listening_score.toFixed(1)}
                    </span>
                  </div>
                  
                  <div style={{ overflowY: 'auto', flex: 1 }}>
                    {!answerKey ? (
                      <p style={{ color: 'var(--text-secondary)', padding: '1rem' }}>
                        {loadingKey ? 'Extracting answer keys from mock test file...' : 'Answer key details could not be found.'}
                      </p>
                    ) : (
                      <table style={styles.reviewTable}>
                        <thead>
                          <tr>
                            <th style={styles.reviewTh}>Q</th>
                            <th style={styles.reviewTh}>Student Answer</th>
                            <th style={styles.reviewTh}>Correct Key</th>
                            <th style={styles.reviewTh}>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Array.from({ length: 40 }, (_, idx) => {
                            const qNum = idx + 1;
                            const studentAns = selectedSub.listening_answers[qNum] || '';
                            const correctArr = answerKey.answers['l' + qNum] || [];
                            const displayCorrect = answerKey.display['l' + qNum] || correctArr.join(' / ') || '—';
                            const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
                            const sNorm = norm(studentAns);
                            const isOk = correctArr.some(ans => norm(ans) === sNorm);
                            
                            return (
                              <tr key={qNum} style={{ borderBottom: '1px solid var(--glass-border)' }}>
                                <td style={styles.reviewTd}><strong>{qNum}</strong></td>
                                <td style={styles.reviewTd}>{studentAns || '—'}</td>
                                <td style={styles.reviewTd}>{displayCorrect}</td>
                                <td style={{ ...styles.reviewTd, color: isOk ? '#10b981' : studentAns ? '#f43f5e' : '#94a3b8', fontWeight: 'bold' }}>
                                  {isOk ? '✓ Correct' : studentAns ? '✗ Wrong' : '— Empty'}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>

                {/* Reading Column */}
                <div className="card" style={{ maxHeight: '78vh', display: 'flex', flexDirection: 'column' }}>
                  <div style={{ borderBottom: '1px solid var(--glass-border)', paddingBottom: '1rem', marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h4 style={{ color: 'var(--text-primary)' }}>📖 Reading Overview</h4>
                    <span style={{ fontSize: '1.1rem', fontWeight: 'bold', color: '#10b981' }}>
                      Band {selectedSub.reading_score.toFixed(1)}
                    </span>
                  </div>
                  
                  <div style={{ overflowY: 'auto', flex: 1 }}>
                    {!answerKey ? (
                      <p style={{ color: 'var(--text-secondary)', padding: '1rem' }}>
                        {loadingKey ? 'Extracting answer keys from mock test file...' : 'Answer key details could not be found.'}
                      </p>
                    ) : (
                      <table style={styles.reviewTable}>
                        <thead>
                          <tr>
                            <th style={styles.reviewTh}>Q</th>
                            <th style={styles.reviewTh}>Student Answer</th>
                            <th style={styles.reviewTh}>Correct Key</th>
                            <th style={styles.reviewTh}>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Array.from({ length: 40 }, (_, idx) => {
                            const qNum = idx + 1;
                            const studentAns = selectedSub.reading_answers[qNum] || '';
                            const correctArr = answerKey.answers['r' + qNum] || [];
                            const displayCorrect = answerKey.display['r' + qNum] || correctArr.join(' / ') || '—';
                            const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
                            const sNorm = norm(studentAns);
                            const isOk = correctArr.some(ans => norm(ans) === sNorm);
                            
                            return (
                              <tr key={qNum} style={{ borderBottom: '1px solid var(--glass-border)' }}>
                                <td style={styles.reviewTd}><strong>{qNum}</strong></td>
                                <td style={styles.reviewTd}>{studentAns || '—'}</td>
                                <td style={styles.reviewTd}>{displayCorrect}</td>
                                <td style={{ ...styles.reviewTd, color: isOk ? '#10b981' : studentAns ? '#f43f5e' : '#94a3b8', fontWeight: 'bold' }}>
                                  {isOk ? '✓ Correct' : studentAns ? '✗ Wrong' : '— Empty'}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                  {answerKey && (
                    <button 
                      onClick={handleCopyReport}
                      className="btn btn-success"
                      style={{ marginTop: '1.5rem', width: '100%', justifyContent: 'center' }}
                    >
                      📋 Copy Review Report to Clipboard
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          /* MAIN LISTINGS VIEW */
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem', marginBottom: '2.5rem' }}>
              {/* 1. Analytics Summary Row */}
              <div style={styles.statsRow}>
                <div className="card" style={styles.statCard}>
                  <span style={styles.statIcon}>⏳</span>
                  <div>
                    <h4 style={styles.statVal}>{submissions.filter(s => s.writing_score === null).length}</h4>
                    <span style={styles.statLabel}>Pending Reviews</span>
                  </div>
                </div>
                <div className="card" style={styles.statCard}>
                  <span style={styles.statIcon}>✅</span>
                  <div>
                    <h4 style={styles.statVal}>{submissions.filter(s => s.writing_score !== null).length}</h4>
                    <span style={styles.statLabel}>Graded Portfolio</span>
                  </div>
                </div>
                <div className="card" style={styles.statCard}>
                  <span style={styles.statIcon}>📈</span>
                  <div>
                    <h4 style={styles.statVal}>{calculateAverageClassBand()}</h4>
                    <span style={styles.statLabel}>Avg Class Band</span>
                  </div>
                </div>
                <div className="card" style={styles.statCard}>
                  <span style={styles.statIcon}>⚠️</span>
                  <div>
                    <h4 style={styles.statVal}>{submissions.reduce((acc, s) => acc + (s.violations_count || 0), 0)}</h4>
                    <span style={styles.statLabel}>Total Violations</span>
                  </div>
                </div>
              </div>

              {/* 2. Visualizations and Filters Container */}
              <div style={styles.vizAndFiltersPanel}>
                {/* Score Distribution Chart */}
                <div className="card" style={styles.chartCard}>
                  <h4 style={{ color: 'var(--text-primary)', marginBottom: '1rem', fontSize: '1.05rem', fontWeight: 'bold' }}>📊 Class Band Score Distribution</h4>
                  <div style={{ width: '100%', display: 'flex', justifyContent: 'center', height: '140px' }}>
                    {submissions.filter(s => s.writing_score !== null).length === 0 ? (
                      <div style={{ color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, fontSize: '0.9rem', fontStyle: 'italic' }}>
                        No graded papers available for score distribution chart.
                      </div>
                    ) : (() => {
                      const scoreFreq = {};
                      for (let i = 4.0; i <= 9.0; i += 0.5) {
                        scoreFreq[i.toFixed(1)] = 0;
                      }
                      submissions.filter(s => s.writing_score !== null).forEach(s => {
                        const overallVal = (s.listening_score + s.reading_score + s.writing_score) / 3;
                        const decimal = overallVal - Math.floor(overallVal);
                        let roundedOverall = Math.floor(overallVal);
                        if (decimal >= 0.25 && decimal < 0.75) roundedOverall += 0.5;
                        else if (decimal >= 0.75) roundedOverall += 1.0;
                        const key = roundedOverall.toFixed(1);
                        scoreFreq[key] = (scoreFreq[key] || 0) + 1;
                      });
                      const maxFreq = Math.max(...Object.values(scoreFreq), 1);
                      const bandKeys = Object.keys(scoreFreq).sort((a,b) => parseFloat(a) - parseFloat(b));

                      return (
                        <svg viewBox="0 0 500 130" style={{ width: '100%', height: '100%', overflow: 'visible' }}>
                          {bandKeys.map((key, i) => {
                            const freq = scoreFreq[key];
                            const barHeight = (freq / maxFreq) * 80;
                            const x = 30 + (i * 42);
                            const y = 95 - barHeight;
                            return (
                              <g key={key}>
                                {/* Bar with rounded top */}
                                <rect 
                                  x={x} 
                                  y={y} 
                                  width="26" 
                                  height={barHeight} 
                                  rx="3"
                                  fill={freq > 0 ? '#6366f1' : 'var(--bg-tertiary)'}
                                />
                                {/* Value label on top of bar */}
                                {freq > 0 && (
                                  <text 
                                    x={x + 13} 
                                    y={y - 4} 
                                    textAnchor="middle" 
                                    fontSize="8.5" 
                                    fontWeight="bold"
                                    fill="var(--text-primary)"
                                  >
                                    {freq}
                                  </text>
                                )}
                                {/* X-axis label */}
                                <text 
                                  x={x + 13} 
                                  y="112" 
                                  textAnchor="middle" 
                                  fontSize="8" 
                                  fontWeight="600"
                                  fill="var(--text-secondary)"
                                >
                                  {key}
                                </text>
                              </g>
                            );
                          })}
                          {/* Horizontal base line */}
                          <line x1="15" y1="98" x2="490" y2="98" stroke="var(--glass-border)" strokeWidth="1" />
                        </svg>
                      );
                    })()}
                  </div>
                </div>

                {/* Advanced Search & Filtering Bar */}
                <div className="card" style={styles.filtersCard}>
                  <h4 style={{ color: 'var(--text-primary)', marginBottom: '1rem', fontSize: '1.05rem', fontWeight: 'bold' }}>🔍 Search & Filters</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
                    <div style={styles.searchContainer}>
                      <input 
                        type="text" 
                        placeholder="Search student name, ID, or test paper..." 
                        value={searchTerm} 
                        onChange={(e) => setSearchTerm(e.target.value)}
                        style={styles.searchInput}
                      />
                    </div>
                    <div style={styles.dropdownsRow}>
                      <select 
                        value={statusFilter} 
                        onChange={(e) => setStatusFilter(e.target.value)}
                        style={styles.dropdownInput}
                      >
                        <option value="all">📁 All Statuses</option>
                        <option value="pending">⏳ Pending Reviews</option>
                        <option value="graded">✅ Graded Portfolios</option>
                      </select>
                      <select 
                        value={integrityFilter} 
                        onChange={(e) => setIntegrityFilter(e.target.value)}
                        style={styles.dropdownInput}
                      >
                        <option value="all">🛡️ All Integrity</option>
                        <option value="clean">🟢 Clean Sessions</option>
                        <option value="flagged">🔴 Proctoring Warnings</option>
                      </select>
                      <select 
                        value={groupFilter} 
                        onChange={(e) => setGroupFilter(e.target.value)}
                        style={styles.dropdownInput}
                      >
                        <option value="all">👥 All Groups</option>
                        {studentGroups.map(g => (
                          <option key={g} value={g}>👥 Group: {g}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div style={styles.dashboardGrid}>
            {/* Left Col: Pending Review */}
            <div>
              <h3 style={{ ...styles.columnTitle, color: '#f59e0b' }}>⏳ Pending Writing Reviews ({pendingSubmissions.length})</h3>
              {pendingSubmissions.length === 0 ? (
                <div className="card" style={styles.emptyCard}>
                  <p>✅ All submissions graded! High five!</p>
                </div>
              ) : (
                pendingSubmissions.map(sub => (
                  <div className="card" style={styles.subCard} key={sub.id}>
                    <div style={styles.subCardHeader}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <h4 style={styles.studentTitle}>{sub.student_name}</h4>
                        {sub.student_group && (
                          <span style={{ 
                            backgroundColor: 'rgba(99, 102, 241, 0.12)', 
                            color: '#6366f1', 
                            fontSize: '0.7rem', 
                            padding: '0.1rem 0.35rem', 
                            borderRadius: '4px', 
                            fontWeight: '600'
                          }}>
                            {sub.student_group}
                          </span>
                        )}
                      </div>
                      <span style={styles.subMeta}>ID: {sub.student_id} | {sub.test_title}</span>
                      <span style={styles.dateLabel}>{new Date(sub.submitted_at).toLocaleDateString()}</span>
                    </div>
                    <div style={styles.miniScoresRow}>
                      <span>🎧 Listening: <strong>{sub.listening_score.toFixed(1)}</strong></span>
                      <span>📖 Reading: <strong>{sub.reading_score.toFixed(1)}</strong></span>
                    </div>
                    <button 
                      onClick={() => handleSelectSubmission(sub)}
                      className="btn btn-primary"
                      style={{ marginTop: '1rem', width: '100%', justifyContent: 'center' }}
                    >
                      ✏️ Evaluate Essays
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* Right Col: Graded & Released */}
            <div>
              <h3 style={{ ...styles.columnTitle, color: '#10b981' }}>📊 Graded & Released Portfolio ({gradedSubmissions.length})</h3>
              {gradedSubmissions.length === 0 ? (
                <div className="card" style={styles.emptyCard}>
                  <p>No graded test portfolio found. Begin grading student writing to populate.</p>
                </div>
              ) : (
                gradedSubmissions.map(sub => (
                  <div className="card" style={styles.subCard} key={sub.id}>
                    <div style={styles.subCardHeader}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <h4 style={styles.studentTitle}>{sub.student_name}</h4>
                        {sub.student_group && (
                          <span style={{ 
                            backgroundColor: 'rgba(99, 102, 241, 0.12)', 
                            color: '#6366f1', 
                            fontSize: '0.7rem', 
                            padding: '0.1rem 0.35rem', 
                            borderRadius: '4px', 
                            fontWeight: '600'
                          }}>
                            {sub.student_group}
                          </span>
                        )}
                      </div>
                      <span style={styles.subMeta}>ID: {sub.student_id} | {sub.test_title}</span>
                      <div style={styles.miniBadgeBox}>
                        <span style={styles.overallScoreNumMini}>{sub.writing_score.toFixed(1)}</span>
                        <span style={{ fontSize: '0.65rem', color: '#94a3b8' }}>Writing Band</span>
                      </div>
                    </div>
                    
                    <div style={{ ...styles.miniScoresRow, marginTop: '0.5rem' }}>
                      <span>🎧 List: <strong>{sub.listening_score.toFixed(1)}</strong></span>
                      <span>📖 Read: <strong>{sub.reading_score.toFixed(1)}</strong></span>
                      <span>✍️ Writ: <strong>{sub.writing_score.toFixed(1)}</strong></span>
                    </div>

                    <div style={styles.revealControlBox}>
                      <span style={{
                        color: sub.is_revealed === 1 ? '#10b981' : '#f59e0b',
                        fontSize: '0.85rem',
                        fontWeight: '600'
                      }}>
                        {sub.is_revealed === 1 ? '🟢 Scores Released' : '🟡 Hidden from Student'}
                      </span>
                      <button 
                        onClick={() => toggleRevealStatus(sub.id, sub.is_revealed === 1)}
                        className="btn btn-secondary"
                        style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}
                      >
                        {sub.is_revealed === 1 ? 'Hide Scores' : 'Release Scores'}
                      </button>
                    </div>

                    <button 
                      onClick={() => handleSelectSubmission(sub)}
                      className="btn btn-secondary"
                      style={{ width: '100%', justifyContent: 'center', marginTop: '0.75rem' }}
                    >
                      🔍 Edit Grade & Feedback
                    </button>
                    <button 
                      onClick={() => downloadPdfReport(sub)}
                      className="btn btn-primary"
                      style={{ width: '100%', justifyContent: 'center', marginTop: '0.5rem', backgroundColor: '#6366f1', borderColor: '#6366f1' }}
                    >
                      📥 Download PDF Report
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
          </>
        )}
      </main>

      {showPwdModal && (
        <ChangePasswordModal 
          userId={user.id} 
          onClose={() => setShowPwdModal(false)} 
        />
      )}
    </div>
  );
}

const styles = {
  statsRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: '1.25rem',
  },
  statCard: {
    display: 'flex',
    alignItems: 'center',
    gap: '1.25rem',
    padding: '1.25rem 1.5rem',
    flexDirection: 'row',
  },
  statIcon: {
    fontSize: '2rem',
  },
  statVal: {
    fontSize: '1.75rem',
    fontWeight: '700',
    color: 'var(--text-primary)',
    margin: 0,
    lineHeight: '1.2',
  },
  statLabel: {
    fontSize: '0.85rem',
    color: 'var(--text-secondary)',
    fontWeight: '500',
  },
  vizAndFiltersPanel: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '1.5rem',
  },
  chartCard: {
    padding: '1.25rem 1.5rem',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
  },
  filtersCard: {
    padding: '1.25rem 1.5rem',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
  },
  searchContainer: {
    width: '100%',
  },
  searchInput: {
    width: '100%',
    padding: '0.65rem 1rem',
    borderRadius: '6px',
    border: '1px solid var(--glass-border)',
    backgroundColor: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    fontSize: '0.9rem',
    outline: 'none',
  },
  dropdownsRow: {
    display: 'flex',
    gap: '0.75rem',
  },
  dropdownInput: {
    flex: 1,
    padding: '0.65rem',
    borderRadius: '6px',
    border: '1px solid var(--glass-border)',
    backgroundColor: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    fontSize: '0.85rem',
    cursor: 'pointer',
    outline: 'none',
  },
  descriptorHint: {
    fontSize: '0.8rem',
    color: 'var(--text-secondary)',
    marginTop: '0.35rem',
    lineHeight: '1.4',
    fontStyle: 'italic',
    padding: '0.35rem 0.5rem',
    backgroundColor: 'var(--bg-secondary)',
    borderLeft: '3px solid #6366f1',
    borderRadius: '0 4px 4px 0',
  },
  dashboardLayout: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: 'var(--bg-primary)',
    color: 'var(--text-primary)',
  },
  header: {
    backgroundColor: 'var(--bg-secondary)',
    borderBottom: '1px solid var(--glass-border)',
    padding: '1rem 2rem',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    h2: {
      fontSize: '1.5rem',
      fontWeight: '700',
    }
  },
  badge: {
    fontSize: '0.75rem',
    backgroundColor: '#10b981',
    color: '#ffffff',
    padding: '0.25rem 0.6rem',
    borderRadius: '4px',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  userInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: '1.5rem',
  },
  userMeta: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
  },
  userName: {
    fontWeight: '600',
    color: 'var(--text-primary)',
  },
  userId: {
    fontSize: '0.85rem',
    color: 'var(--text-secondary)',
  },
  logoutBtn: {
    padding: '0.5rem 1rem',
    fontSize: '0.9rem',
  },
  mainContent: {
    flex: 1,
    paddingTop: '2.5rem',
  },
  loadingContainer: {
    textAlign: 'center',
    padding: '4rem',
    fontSize: '1.2rem',
    color: 'var(--text-secondary)',
  },
  errorAlert: {
    backgroundColor: 'rgba(244, 63, 94, 0.15)',
    color: '#f43f5e',
    padding: '1rem',
    borderRadius: '8px',
    marginBottom: '1.5rem',
  },
  dashboardGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '2.5rem',
  },
  columnTitle: {
    fontSize: '1.15rem',
    fontWeight: '600',
    marginBottom: '1.25rem',
    color: 'var(--text-primary)',
  },
  emptyCard: {
    textAlign: 'center',
    padding: '3rem 2rem',
    color: 'var(--text-secondary)',
  },
  subCard: {
    marginBottom: '1rem',
    backgroundColor: 'var(--bg-secondary)',
  },
  subCardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    borderBottom: '1px solid var(--glass-border)',
    paddingBottom: '0.75rem',
    marginBottom: '0.75rem',
  },
  studentTitle: {
    fontSize: '1.05rem',
    fontWeight: '600',
    color: 'var(--text-primary)',
  },
  subMeta: {
    fontSize: '0.8rem',
    color: 'var(--text-secondary)',
  },
  dateLabel: {
    fontSize: '0.8rem',
    color: 'var(--text-secondary)',
  },
  miniScoresRow: {
    display: 'flex',
    gap: '1rem',
    fontSize: '0.85rem',
    color: 'var(--text-secondary)',
  },
  miniBadgeBox: {
    backgroundColor: 'var(--bg-tertiary)',
    borderRadius: '6px',
    padding: '0.25rem 0.5rem',
    textAlign: 'center',
    border: '1px solid var(--glass-border)',
  },
  overallScoreNumMini: {
    display: 'block',
    fontSize: '1.1rem',
    fontWeight: '700',
    color: '#10b981',
  },
  revealControlBox: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'var(--bg-tertiary)',
    padding: '0.5rem 0.75rem',
    borderRadius: '6px',
    marginTop: '0.75rem',
  },

  /* Grading Workspace Layout */
  gradingWorkspace: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.5rem',
    paddingBottom: '3rem',
  },
  workspaceHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'var(--bg-secondary)',
    padding: '1.25rem 2rem',
    borderRadius: '12px',
    border: '1px solid var(--glass-border)',
  },
  liveScoreBadge: {
    backgroundColor: 'var(--bg-tertiary)',
    border: '1.5px solid #6366f1',
    borderRadius: '10px',
    padding: '0.75rem 1.25rem',
    textAlign: 'center',
    minWidth: '120px',
  },
  liveScoreNum: {
    display: 'block',
    fontSize: '2rem',
    fontWeight: '800',
    color: '#6366f1',
  },
  liveScoreLabel: {
    fontSize: '0.7rem',
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    fontWeight: '600',
  },
  workspaceGrid: {
    display: 'grid',
    gridTemplateColumns: '1.2fr 0.8fr',
    gap: '2rem',
    alignItems: 'start',
  },
  essayPanel: {
    maxHeight: '75vh',
    overflowY: 'auto',
  },
  essayBox: {
    backgroundColor: 'var(--bg-secondary)',
    border: '1px solid var(--glass-border)',
    borderRadius: '8px',
    padding: '1.25rem',
  },
  essayBoxHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottom: '1px solid var(--glass-border)',
    paddingBottom: '0.5rem',
    marginBottom: '0.75rem',
    h5: {
      color: 'var(--text-primary)',
      fontWeight: '600',
    }
  },
  writingPrompt: {
    fontSize: '0.85rem',
    color: 'var(--text-secondary)',
    fontStyle: 'italic',
  },
  rawEssayText: {
    backgroundColor: 'var(--bg-primary)',
    border: '1px solid var(--glass-border)',
    padding: '1.25rem',
    borderRadius: '6px',
    fontSize: '0.95rem',
    lineHeight: '1.6',
    whiteSpace: 'pre-wrap',
    color: 'var(--text-primary)',
    marginTop: '0.5rem',
  },
  gradingPanel: {
    // Stick to top while scrolling essays
    position: 'sticky',
    top: '20px',
  },
  rubricGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '1rem',
  },
  toggleRow: {
    marginTop: '1.25rem',
    backgroundColor: 'var(--bg-secondary)',
    padding: '0.75rem 1rem',
    borderRadius: '6px',
    border: '1px solid var(--glass-border)',
  },
  toggleLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    fontSize: '0.85rem',
    color: 'var(--text-primary)',
    cursor: 'pointer',
  },
  tabBtn: {
    padding: '0.6rem 1.2rem',
    fontSize: '0.9rem',
    fontWeight: '600',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
  },
  reviewTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.85rem',
  },
  reviewTh: {
    textAlign: 'left',
    padding: '0.5rem',
    borderBottom: '2px solid var(--glass-border)',
    color: 'var(--text-secondary)',
    fontWeight: '600',
  },
  reviewTd: {
    padding: '0.5rem',
    verticalAlign: 'middle',
    color: 'var(--text-primary)',
  }
};
