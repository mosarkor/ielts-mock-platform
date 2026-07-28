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

  const getWordCount = (text) => {
    if (!text) return 0;
    return text.trim().split(/\s+/).filter(w => w.length > 0).length;
  };

  const bandOptions = [0, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0];

  const pendingSubmissions = submissions.filter(s => s.writing_score === null);
  const gradedSubmissions = submissions.filter(s => s.writing_score !== null);

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
                <h3 style={{ color: '#ffffff' }}>Grading: {selectedSub.student_name} ({selectedSub.student_id})</h3>
                <p style={{ color: '#94a3b8', fontSize: '0.9rem' }}>Test paper: {selectedSub.test_title}</p>
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
                    <div className="form-group">
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
                    </div>

                    <div className="form-group">
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
                    </div>

                    <div className="form-group">
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
                    </div>

                    <div className="form-group">
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
                      <div>
                        <h4 style={styles.studentTitle}>{sub.student_name}</h4>
                        <span style={styles.subMeta}>ID: {sub.student_id} | {sub.test_title}</span>
                      </div>
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
                      <div>
                        <h4 style={styles.studentTitle}>{sub.student_name}</h4>
                        <span style={styles.subMeta}>ID: {sub.student_id} | {sub.test_title}</span>
                      </div>
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
                  </div>
                ))
              )}
            </div>
          </div>
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
