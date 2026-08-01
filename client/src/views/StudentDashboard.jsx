import React, { useState, useEffect, useCallback } from 'react';
import ChangePasswordModal from '../components/ChangePasswordModal';

export default function StudentDashboard({ user, onLogout, onStartTest, onStartSpeaking, theme, toggleTheme }) {
  const [showPwdModal, setShowPwdModal] = useState(false);
  const [assignments, setAssignments] = useState([]);
  const [submissions, setSubmissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  
  // Review Modal State
  const [selectedReview, setSelectedReview] = useState(null);
  const [answerKey, setAnswerKey] = useState(null);
  const [loadingKey, setLoadingKey] = useState(false);
  const [showOnlyMistakes, setShowOnlyMistakes] = useState(false);
  const [targetScore, setTargetScore] = useState(() => parseFloat(localStorage.getItem(`targetScore_${user.id}`)) || 7.0);
  const [activeGuide, setActiveGuide] = useState(null);
  const [speakingAssignments, setSpeakingAssignments] = useState([]);
  const [speakingResults, setSpeakingResults] = useState([]);

  useEffect(() => {
    if (selectedReview) {
      loadAnswerKey(selectedReview.test_id);
    } else {
      setAnswerKey(null);
    }
  }, [selectedReview]);

  const loadAnswerKey = async (testId) => {
    setLoadingKey(true);
    setAnswerKey(null);
    try {
      const res = await fetch(`/tests/mock${testId}.html`);
      if (!res.ok) throw new Error('Answer key file not found');
      const html = await res.text();

      let answersObj = {};
      let displayObj = {};

      const answersMatch = html.match(/const\s+ANSWERS\s*=\s*({[\s\S]*?});/);
      const displayAnswersMatch = html.match(/const\s+DISPLAY_ANSWERS\s*=\s*({[\s\S]*?});/);

      if (answersMatch) {
        answersObj = JSON.parse(answersMatch[1]);
        displayObj = displayAnswersMatch ? JSON.parse(displayAnswersMatch[1]) : {};
      } else {
        const lMatch = html.match(/const\s+listeningAnswerKey\s*=\s*({[\s\S]*?});/);
        const rMatch = html.match(/const\s+readingAnswerKey\s*=\s*({[\s\S]*?});/);

        if (lMatch) {
          try {
            const lKey = JSON.parse(lMatch[1]);
            for (let q = 1; q <= 40; q++) {
              const val = lKey[q] || lKey[String(q)];
              if (val !== undefined) {
                const arr = Array.isArray(val) ? val : [String(val)];
                answersObj['l' + q] = arr;
                displayObj['l' + q] = Array.isArray(val) ? val.join(' / ') : String(val);
              }
            }
          } catch(e) { console.warn('Failed to parse listeningAnswerKey:', e); }
        }

        if (rMatch) {
          try {
            const rKey = JSON.parse(rMatch[1]);
            for (let q = 1; q <= 40; q++) {
              const val = rKey[q] || rKey[String(q)];
              if (val !== undefined) {
                const arr = Array.isArray(val) ? val : [String(val)];
                answersObj['r' + q] = arr;
                displayObj['r' + q] = Array.isArray(val) ? val.join(' / ') : String(val);
              }
            }
          } catch(e) { console.warn('Failed to parse readingAnswerKey:', e); }
        }
      }

      if (Object.keys(answersObj).length > 0) {
        setAnswerKey({ answers: answersObj, display: displayObj });
      }
    } catch (err) {
      console.error('Failed to load answer key:', err);
    } finally {
      setLoadingKey(false);
    }
  };

  const fetchDashboardData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/student/dashboard/${user.id}`);
      if (!res.ok) throw new Error('Failed to load dashboard data');
      const data = await res.json();
      setAssignments(data.assignments);
      setSubmissions(data.submissions);

      // Load speaking data in parallel
      const [spkAsgRes, spkResRes] = await Promise.all([
        fetch(`/api/speaking/assignments/${user.id}`),
        fetch(`/api/speaking/results/${user.id}`)
      ]);
      if (spkAsgRes.ok) setSpeakingAssignments(await spkAsgRes.json());
      if (spkResRes.ok) setSpeakingResults(await spkResRes.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [user.id]);

  useEffect(() => {
    fetchDashboardData();
  }, [fetchDashboardData]);

  const handleStartTestClick = async (testId) => {
    try {
      const res = await fetch('/api/student/assignment/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId: user.id, testId })
      });
      if (!res.ok) throw new Error('Could not start test session');
      
      // Trigger callback to parent to change screen to test runner
      onStartTest(testId);
    } catch (err) {
      alert(err.message);
    }
  };

  // Helper to round IELTS score to nearest 0.5 according to official IELTS rules
  const getIeltsOverall = (l, r, w, s) => {
    const validScores = [l, r, w, s].filter(v => v !== null && v !== undefined && !isNaN(v));
    if (validScores.length === 0) return '–';
    const avg = validScores.reduce((acc, score) => acc + score, 0) / validScores.length;
    const decimal = avg - Math.floor(avg);
    if (decimal < 0.25) return Math.floor(avg).toFixed(1);
    if (decimal < 0.75) return (Math.floor(avg) + 0.5).toFixed(1);
    return Math.ceil(avg).toFixed(1);
  };

  const getProgressTracker = () => {
    // Filter graded submissions where is_revealed is 1 and writing_score is set
    const graded = submissions
      .filter(sub => sub.is_revealed === 1 && sub.writing_score !== null)
      .sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));

    if (graded.length === 0) return null;

    // Calculate band scores
    const bandHistory = graded.map(sub => {
      const overall = parseFloat(getIeltsOverall(sub.listening_score, sub.reading_score, sub.writing_score));
      return {
        title: sub.title || `Test #${sub.test_id}`,
        date: new Date(sub.submitted_at).toLocaleDateString(),
        overall,
        listening: sub.listening_score,
        reading: sub.reading_score,
        writing: sub.writing_score
      };
    });

    const latest = bandHistory[bandHistory.length - 1];
    const first = bandHistory[0];
    const diff = latest.overall - first.overall;

    let trendText = "➖ Stable Performance";
    let trendColor = "#94a3b8";
    if (diff > 0) {
      trendText = `📈 Improving (+${diff.toFixed(1)} band progress!)`;
      trendColor = "#10b981";
    } else if (diff < 0) {
      trendText = `📉 Declining (${diff.toFixed(1)} band)`;
      trendColor = "#f43f5e";
    }

    // Build coordinates for SVG line chart (width: 400, height: 120)
    const width = 400;
    const height = 120;
    const points = bandHistory.map((pt, i) => {
      const x = bandHistory.length > 1 
        ? 35 + (i * (330 / (bandHistory.length - 1)))
        : 200;
      const y = 90 - ((pt.overall - 4) * 15); // scaled to zoom in on band 4 to 9 range
      return { x, y, val: pt.overall, title: pt.title };
    });

    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

    const targetY = 90 - ((targetScore - 4) * 15);

    return (
      <div className="card" style={{ ...styles.progressCard, marginBottom: '2rem' }}>
        <h3 style={styles.cardTitle}>📊 Candidate Band Score Progress Tracker</h3>
        <div style={styles.progressDashboardGrid}>
          
          {/* Left panel: Info */}
          <div style={styles.progressInfoPanel}>
            <div style={styles.trendRow}>
              <span style={{ fontSize: '1.05rem', fontWeight: '700', color: trendColor }}>{trendText}</span>
            </div>
            <p style={{ fontSize: '0.85rem', color: '#94a3b8', margin: '0.5rem 0 1.25rem 0', lineHeight: '1.5' }}>
              Your overall IELTS band scores are plotted chronologically to visualize your academic improvement and study progress.
            </p>
            <div style={styles.metricComparisonBox}>
              <div style={styles.metricCol}>
                <span style={{ fontSize: '0.75rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>First Test Band</span>
                <span style={{ fontSize: '1.85rem', fontWeight: '800', color: 'var(--text-secondary)' }}>{first.overall.toFixed(1)}</span>
              </div>
              <div style={{ width: '1px', backgroundColor: 'rgba(255,255,255,0.08)', height: '40px' }}></div>
              <div style={styles.metricCol}>
                <span style={{ fontSize: '0.75rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Latest Test Band</span>
                <span style={{ fontSize: '1.85rem', fontWeight: '800', color: '#10b981' }}>{latest.overall.toFixed(1)}</span>
              </div>
            </div>
            
            <div style={{ marginTop: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <span style={{ fontSize: '0.85rem', color: '#94a3b8', fontWeight: '600' }}>🎯 Target Band Score:</span>
              <select 
                value={targetScore} 
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  setTargetScore(val);
                  localStorage.setItem(`targetScore_${user.id}`, val);
                }}
                style={{
                  backgroundColor: '#1f293d',
                  color: '#ffffff',
                  border: '1px solid var(--glass-border)',
                  borderRadius: '6px',
                  padding: '0.3rem 0.6rem',
                  fontSize: '0.85rem',
                  fontWeight: '700',
                  outline: 'none',
                  cursor: 'pointer'
                }}
              >
                {[5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0].map(s => (
                  <option key={s} value={s}>{s.toFixed(1)}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Right panel: SVG Chart */}
          <div style={styles.chartPanel}>
            {bandHistory.length > 1 ? (
              <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: '100%', overflow: 'visible' }}>
                {/* Gridlines */}
                {[0, 1, 2, 3].map((val, index) => {
                  const y = 90 - (val * 15);
                  return (
                    <g key={index}>
                      <line x1="25" y1={y} x2="380" y2={y} stroke="rgba(255,255,255,0.06)" strokeDasharray="3" />
                      <text x="5" y={y + 3} fill="#64748b" fontSize="8.5" fontWeight="500" textAnchor="start">B{(val + 4).toFixed(1)}</text>
                    </g>
                  );
                })}
                
                {/* Target line */}
                <line 
                  x1="25" 
                  y1={targetY} 
                  x2="380" 
                  y2={targetY} 
                  stroke="#f59e0b" 
                  strokeDasharray="4 4" 
                  strokeWidth="1.5" 
                />
                <text 
                  x="385" 
                  y={targetY + 3} 
                  fill="#f59e0b" 
                  fontSize="8" 
                  fontWeight="700"
                  textAnchor="start"
                >
                  T: {targetScore.toFixed(1)}
                </text>

                {/* Trend line */}
                <path d={linePath} fill="none" stroke="#10b981" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                
                {/* Data Points */}
                {points.map((p, idx) => (
                  <g key={idx}>
                    <circle cx={p.x} cy={p.y} r="5.5" fill="#10b981" stroke="#111827" strokeWidth="2.5" />
                    <text x={p.x} y={p.y - 12} fill="var(--text-primary)" fontSize="9.5" fontWeight="700" textAnchor="middle">
                      {p.val.toFixed(1)}
                    </text>
                    <text x={p.x} y="115" fill="#94a3b8" fontSize="8" fontWeight="500" textAnchor="middle">
                      Test {idx + 1}
                    </text>
                  </g>
                ))}
              </svg>
            ) : (
              <div style={styles.singleTestNote}>
                📈 Take more mock tests to unlock your detailed score progress chart!
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  const getSkillsBreakdown = () => {
    const graded = submissions.filter(s => s.listening_score !== null);
    
    // Calculate averages
    const totalTests = graded.length;
    const avgL = totalTests > 0 ? (graded.reduce((acc, s) => acc + s.listening_score, 0) / totalTests) : 0;
    const avgR = totalTests > 0 ? (graded.reduce((acc, s) => acc + s.reading_score, 0) / totalTests) : 0;
    const gradedWriting = graded.filter(s => s.writing_score !== null);
    const avgW = gradedWriting.length > 0 ? (gradedWriting.reduce((acc, s) => acc + s.writing_score, 0) / gradedWriting.length) : 0;
    
    // Calculate overall average
    const avgOverall = totalTests > 0 ? (graded.reduce((acc, s) => {
      const overallVal = (s.listening_score + s.reading_score + (s.writing_score || 0)) / (s.writing_score !== null ? 3 : 2);
      const decimal = overallVal - Math.floor(overallVal);
      let roundedOverall = Math.floor(overallVal);
      if (decimal >= 0.25 && decimal < 0.75) roundedOverall += 0.5;
      else if (decimal >= 0.75) roundedOverall += 1.0;
      return acc + roundedOverall;
    }, 0) / totalTests) : 0;

    // Motivation message
    let motivation = "Start your IELTS preparation journey by taking your first assigned mock test!";
    if (totalTests > 0) {
      const diff = targetScore - avgOverall;
      if (diff <= 0) {
        motivation = `🎉 Amazing work! You are currently meeting or exceeding your target band score of ${targetScore.toFixed(1)}! Keep it up!`;
      } else if (diff <= 0.5) {
        motivation = `🔥 So close! You are only 0.5 bands away from your target band score of ${targetScore.toFixed(1)}! You can do this!`;
      } else {
        motivation = `💪 Keep practicing! You need ${diff.toFixed(1)} more bands to reach your target score of ${targetScore.toFixed(1)}. Focus on your weak spots!`;
      }
    }

    return (
      <div className="card" style={{ padding: '1.5rem', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--glass-border)', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <h3 style={{ color: 'var(--text-primary)', fontSize: '1.15rem', fontWeight: '700', borderBottom: '1px solid var(--glass-border)', paddingBottom: '0.75rem', margin: 0 }}>
          📈 Skills Performance Breakdown
        </h3>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '0.25rem' }}>
              <span style={{ color: 'var(--text-secondary)' }}>🎧 Listening Average</span>
              <strong style={{ color: 'var(--text-primary)' }}>{avgL > 0 ? `${avgL.toFixed(1)} Band` : 'N/A'}</strong>
            </div>
            <div style={{ height: '6px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '3px', overflow: 'hidden' }}>
              <div style={{ width: avgL > 0 ? `${(avgL / 9) * 100}%` : '0%', height: '100%', backgroundColor: '#6366f1', borderRadius: '3px' }}></div>
            </div>
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '0.25rem' }}>
              <span style={{ color: 'var(--text-secondary)' }}>📖 Reading Average</span>
              <strong style={{ color: 'var(--text-primary)' }}>{avgR > 0 ? `${avgR.toFixed(1)} Band` : 'N/A'}</strong>
            </div>
            <div style={{ height: '6px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '3px', overflow: 'hidden' }}>
              <div style={{ width: avgR > 0 ? `${(avgR / 9) * 100}%` : '0%', height: '100%', backgroundColor: '#10b981', borderRadius: '3px' }}></div>
            </div>
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '0.25rem' }}>
              <span style={{ color: 'var(--text-secondary)' }}>✍️ Writing Average</span>
              <strong style={{ color: 'var(--text-primary)' }}>{avgW > 0 ? `${avgW.toFixed(1)} Band` : 'N/A'}</strong>
            </div>
            <div style={{ height: '6px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '3px', overflow: 'hidden' }}>
              <div style={{ width: avgW > 0 ? `${(avgW / 9) * 100}%` : '0%', height: '100%', backgroundColor: '#f59e0b', borderRadius: '3px' }}></div>
            </div>
          </div>
        </div>

        <div style={{
          marginTop: 'auto',
          backgroundColor: 'rgba(99, 102, 241, 0.08)',
          border: '1px dashed rgba(99, 102, 241, 0.3)',
          borderRadius: '8px',
          padding: '0.75rem 1rem',
          fontSize: '0.85rem',
          color: 'var(--text-primary)',
          lineHeight: '1.4'
        }}>
          {motivation}
        </div>
      </div>
    );
  };

  const getStudyGuides = () => {
    const guides = [
      {
        id: 'writing',
        title: '✍️ Writing Band 7+ Assessment Rules',
        content: (
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '0.5rem', lineHeight: '1.4' }}>
            <p>To get a <strong>Band 7.0 or higher</strong> in Writing, you must meet the following criteria:</p>
            <ul style={{ paddingLeft: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <li><strong>Task Response:</strong> Address all parts of the task. For Task 2, present a clear position throughout. For Task 1, present a clear overview.</li>
              <li><strong>Coherence & Cohesion:</strong> Organize ideas logically and use paragraphing effectively. Use a range of cohesive devices (e.g., *however*, *consequently*, *furthermore*).</li>
              <li><strong>Lexical Resource:</strong> Use a wide range of vocabulary with some awareness of style and collocation. Use less common lexical items.</li>
              <li><strong>Grammatical Range:</strong> Use a mix of simple and complex sentence forms. Most sentences must be error-free.</li>
            </ul>
          </div>
        )
      },
      {
        id: 'lr',
        title: '🎧 & 📖 Listening & Reading Exam Tips',
        content: (
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '0.5rem', lineHeight: '1.4' }}>
            <ul style={{ paddingLeft: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <li><strong>Word Count Limits:</strong> Always check instructions (e.g., *NO MORE THAN TWO WORDS AND/OR A NUMBER*). Extra words will make your answer wrong.</li>
              <li><strong>Spelling:</strong> Answers must be spelled 100% correctly. Correct grammar (singular/plural) is essential.</li>
              <li><strong>Pacing:</strong> Do not spend more than 1 minute on a difficult question. Skip it and return if you have time.</li>
              <li><strong>Transferring Answers:</strong> In computer-based tests, type your answers directly into the boxes. Make sure there are no extra spaces.</li>
            </ul>
          </div>
        )
      },
      {
        id: 'structure',
        title: '📚 Essay Structural Layouts',
        content: (
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '0.5rem', lineHeight: '1.4' }}>
            <p><strong>Writing Task 1 structure:</strong></p>
            <ol style={{ paddingLeft: '1.25rem', marginBottom: '0.5rem' }}>
              <li>Intro: Paraphrase the prompt & legends.</li>
              <li>Overview: Mention 2 main trends/highs/lows (no data values yet).</li>
              <li>Detail Paragraph 1: Detailed data for category A.</li>
              <li>Detail Paragraph 2: Detailed data for category B.</li>
            </ol>
            <p><strong>Writing Task 2 structure:</strong></p>
            <ol style={{ paddingLeft: '1.25rem' }}>
              <li>Intro: Paraphrase question statement + state your opinion (thesis).</li>
              <li>Body 1: Present your first main point + explain + give example.</li>
              <li>Body 2: Present your second main point + explain + give example.</li>
              <li>Conclusion: Summarize points + restate your overall opinion.</li>
            </ol>
          </div>
        )
      }
    ];

    return (
      <div className="card" style={{ padding: '1.5rem', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--glass-border)', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <h3 style={{ color: 'var(--text-primary)', fontSize: '1.15rem', fontWeight: '700', borderBottom: '1px solid var(--glass-border)', paddingBottom: '0.75rem', margin: 0 }}>
          📚 IELTS Exam Preparation Guides
        </h3>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {guides.map(g => {
            const isOpen = activeGuide === g.id;
            return (
              <div 
                key={g.id} 
                style={{ 
                  border: '1px solid var(--glass-border)', 
                  borderRadius: '6px', 
                  overflow: 'hidden',
                  backgroundColor: 'var(--bg-tertiary)'
                }}
              >
                <div 
                  onClick={() => setActiveGuide(isOpen ? null : g.id)}
                  style={{ 
                    padding: '0.75rem 1rem', 
                    cursor: 'pointer', 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center',
                    fontWeight: '600',
                    color: isOpen ? '#6366f1' : 'var(--text-primary)',
                    fontSize: '0.9rem',
                    userSelect: 'none'
                  }}
                >
                  <span>{g.title}</span>
                  <span>{isOpen ? '▲' : '▼'}</span>
                </div>
                {isOpen && (
                  <div style={{ padding: '1rem', borderTop: '1px solid var(--glass-border)', backgroundColor: 'rgba(0,0,0,0.1)' }}>
                    {g.content}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div style={styles.dashboardLayout}>
      {/* Header */}
      <header style={styles.header}>
        <div style={styles.headerTitle}>
          <h2>IELTS <span>Mock Portal</span></h2>
          <span style={styles.badge}>Candidate Area</span>
        </div>
        <div style={styles.userInfo}>
          <div style={styles.userMeta}>
            <span style={styles.userName}>{user.name}</span>
            <span style={styles.userId}>ID: {user.id}</span>
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

      {/* Main Grid */}
      <main className="container" style={styles.mainContent}>
        {error && <div style={styles.errorAlert}>{error}</div>}

        {loading ? (
          <div style={styles.loadingContainer}>Loading candidate portfolio...</div>
        ) : (
          <>
            {getProgressTracker()}
            
            {/* New Analytics & Study Guides Row */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '2rem', marginBottom: '2rem' }}>
              {/* Skills breakdown card */}
              {getSkillsBreakdown()}

              {/* Study guides card */}
              {getStudyGuides()}
            </div>

            <div style={styles.grid}>
            {/* Left Column: Categorized Assigned Tests */}
            <div style={styles.leftCol}>
              {(() => {
                const fullMocks = assignments.filter(a => !a.title.toLowerCase().includes('reading') && !a.title.toLowerCase().includes('listening'));
                const readingTests = assignments.filter(a => a.title.toLowerCase().includes('reading'));
                const listeningTests = assignments.filter(a => a.title.toLowerCase().includes('listening'));

                const renderTestCard = (asg, badgeText, badgeColor) => (
                  <div className="card" style={{ ...styles.assignmentCard, marginBottom: '0.75rem' }} key={asg.assignment_id}>
                    <div>
                      <h4 style={styles.testTitle}>{asg.title}</h4>
                      <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.3rem', flexWrap: 'wrap' }}>
                        <span style={{ ...styles.statusLabel, backgroundColor: badgeColor }}>{badgeText}</span>
                        <span style={{
                          ...styles.statusLabel,
                          backgroundColor: asg.status === 'started' ? '#f59e0b' : '#3b82f6'
                        }}>
                          {asg.status === 'started' ? 'In Progress' : 'Assigned'}
                        </span>
                      </div>
                      <p style={styles.dateLabel}>Assigned on: {new Date(asg.assigned_at).toLocaleDateString()}</p>
                    </div>
                    <button 
                      onClick={() => handleStartTestClick(asg.test_id)}
                      className="btn btn-success"
                      style={styles.actionBtn}
                    >
                      {asg.status === 'started' ? 'Resume Test 🚀' : 'Take Exam ✍️'}
                    </button>
                  </div>
                );

                return (
                  <div>
                    {/* SECTION 1: Full IELTS Mock Tests */}
                    <div style={{ marginBottom: '2rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                        <span style={{ fontSize: '1.2rem' }}>🏆</span>
                        <h3 style={{ ...styles.sectionTitle, margin: 0 }}>Full IELTS Mock Tests (All 4 Skills)</h3>
                      </div>
                      {fullMocks.length === 0 ? (
                        <div className="card" style={styles.emptyCard}>
                          <p style={{ margin: 0, fontSize: '0.85rem' }}>No full mock tests assigned.</p>
                        </div>
                      ) : (
                        fullMocks.map(asg => renderTestCard(asg, '📝 Full Mock Test', '#6366f1'))
                      )}
                    </div>

                    {/* SECTION 2: Reading Practice Tests */}
                    <div style={{ marginBottom: '2rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                        <span style={{ fontSize: '1.2rem' }}>📖</span>
                        <h3 style={{ ...styles.sectionTitle, margin: 0 }}>Reading Practice Tests ({readingTests.length})</h3>
                      </div>
                      {readingTests.length === 0 ? (
                        <div className="card" style={styles.emptyCard}>
                          <p style={{ margin: 0, fontSize: '0.85rem' }}>No reading practice tests assigned.</p>
                        </div>
                      ) : (
                        readingTests.map(asg => renderTestCard(asg, '📖 Reading Test Only', '#10b981'))
                      )}
                    </div>

                    {/* SECTION 3: Listening Practice Tests */}
                    {listeningTests.length > 0 && (
                      <div style={{ marginBottom: '2rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                          <span style={{ fontSize: '1.2rem' }}>🎧</span>
                          <h3 style={{ ...styles.sectionTitle, margin: 0 }}>Listening Practice Tests ({listeningTests.length})</h3>
                        </div>
                        {listeningTests.map(asg => renderTestCard(asg, '🎧 Listening Test Only', '#3b82f6'))}
                      </div>
                    )}

                    {/* SECTION 4: AI Speaking Tests */}
                    <div style={{ marginBottom: '2rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                        <span style={{ fontSize: '1.2rem' }}>🎙️</span>
                        <h3 style={{ ...styles.sectionTitle, margin: 0 }}>AI Speaking Tests ({speakingAssignments.length})</h3>
                      </div>
                      {speakingAssignments.length === 0 ? (
                        <div className="card" style={styles.emptyCard}>
                          <p style={{ margin: 0, fontSize: '0.85rem' }}>No speaking tests assigned.</p>
                        </div>
                      ) : (
                        speakingAssignments.map(sa => (
                          <div className="card" style={{ ...styles.assignmentCard, marginBottom: '0.75rem' }} key={sa.id}>
                            <div>
                              <h4 style={styles.testTitle}>{sa.title}</h4>
                              <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.3rem', flexWrap: 'wrap' }}>
                                <span style={{ ...styles.statusLabel, backgroundColor: '#8b5cf6' }}>🎙️ Speaking Test</span>
                                <span style={{ ...styles.statusLabel, backgroundColor: sa.status === 'submitted' ? '#10b981' : '#3b82f6' }}>
                                  {sa.status === 'submitted' ? 'Submitted' : 'Assigned'}
                                </span>
                              </div>
                              <p style={styles.dateLabel}>Assigned: {new Date(sa.assigned_at).toLocaleDateString()}</p>
                            </div>
                            {sa.status !== 'submitted' && onStartSpeaking && (
                              <button
                                onClick={() => onStartSpeaking(sa)}
                                className="btn btn-success"
                                style={styles.actionBtn}
                              >
                                Start Speaking 🎙️
                              </button>
                            )}
                            {sa.status === 'submitted' && (
                              <span style={{ fontSize: '0.8rem', color: '#10b981', fontWeight: '600' }}>✅ Awaiting teacher review</span>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Right Column: Past Results & Score Breakdown */}
            <div style={styles.rightCol}>
              {(() => {
                const fullMockSubs = submissions.filter(sub => 
                  !sub.title.toLowerCase().includes('reading') && !sub.title.toLowerCase().includes('listening')
                );

                const separateSubs = submissions.filter(sub => 
                  sub.title.toLowerCase().includes('reading') || sub.title.toLowerCase().includes('listening')
                );

                return (
                  <div>
                    {/* BREAKDOWN 1: Full Mock Exam Results (All 4 Skills) */}
                    <div style={{ marginBottom: '2.5rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
                        <span style={{ fontSize: '1.25rem' }}>🏆</span>
                        <h3 style={{ ...styles.sectionTitle, margin: 0 }}>1. Full Mock Exam Scores (All 4 Skills)</h3>
                      </div>

                      {/* Speaking Results Cards */}
                      {speakingResults.length > 0 && speakingResults.map(sr => {
                        const fb = (() => { try { return JSON.parse(sr.ai_feedback || '{}'); } catch { return {}; } })();
                        const bandColor = (s) => s >= 7.5 ? '#10b981' : s >= 6.0 ? '#6366f1' : s >= 4.5 ? '#f59e0b' : '#f43f5e';
                        return (
                          <div className="card" style={{ ...styles.resultCard, borderLeft: '4px solid #8b5cf6', marginBottom: '1rem' }} key={sr.id}>
                            <div style={styles.resultHeader}>
                              <h4 style={styles.testTitle}>🎙️ {sr.prompt_title}</h4>
                              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.4rem' }}>
                                <span style={{ ...styles.statusLabel, backgroundColor: '#8b5cf6' }}>Speaking Test</span>
                                <span style={{ ...styles.statusLabel, backgroundColor: bandColor(sr.overall_score), fontSize: '0.8rem' }}>Band {sr.overall_score?.toFixed(1)}</span>
                              </div>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem', margin: '0.75rem 0' }}>
                              {[['Fluency', sr.fluency_score], ['Lexical', sr.lexical_score], ['Grammar', sr.grammar_score], ['Pronunciation', sr.pronunciation_score]].map(([label, score]) => (
                                <div key={label} style={{ backgroundColor: 'var(--bg-tertiary)', borderRadius: '6px', padding: '0.4rem 0.6rem', border: '1px solid var(--glass-border)' }}>
                                  <span style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', display: 'block' }}>{label}</span>
                                  <span style={{ fontWeight: '800', fontSize: '1rem', color: bandColor(score) }}>{score?.toFixed(1)}</span>
                                </div>
                              ))}
                            </div>
                            {fb.overall && <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: '1.4', margin: '0.4rem 0 0', fontStyle: 'italic' }}>"{fb.overall}"</p>}
                            <p style={styles.dateLabel}>Submitted: {new Date(sr.submitted_at).toLocaleDateString()}</p>
                          </div>
                        );
                      })}

                      {/* Full Mock Submissions */}
                      {fullMockSubs.length === 0 ? (
                        <div className="card" style={styles.emptyCard}>
                          <p style={{ fontSize: '0.85rem' }}>No full 4-skill mock exam scores recorded yet.</p>
                        </div>
                      ) : (
                        fullMockSubs.map((sub) => {
                          const speakingSub = speakingResults.find(s => s.student_id === sub.student_id);
                          const spkScore = speakingSub ? speakingSub.overall_score : null;
                          const overall = getIeltsOverall(sub.listening_score, sub.reading_score, sub.writing_score, spkScore);

                          return (
                            <div className="card" style={{ ...styles.resultCard, marginBottom: '1rem' }} key={sub.id}>
                              <div style={styles.resultHeader}>
                                <h4 style={styles.testTitle}>{sub.title}</h4>
                                <div style={styles.overallScoreBox}>
                                  <span style={styles.scoreNumber}>{overall}</span>
                                  <span style={styles.scoreText}>Overall Band</span>
                                </div>
                              </div>
                              <div style={styles.miniScores}>
                                <span style={styles.miniScore}>🎧 Listening: <strong>{sub.listening_score ? sub.listening_score.toFixed(1) : '–'}</strong></span>
                                <span style={styles.miniScore}>📖 Reading: <strong>{sub.reading_score ? sub.reading_score.toFixed(1) : '–'}</strong></span>
                                <span style={styles.miniScore}>✍️ Writing: <strong>{sub.writing_score ? sub.writing_score.toFixed(1) : 'Pending'}</strong></span>
                                <span style={styles.miniScore}>🎙️ Speaking: <strong>{spkScore ? spkScore.toFixed(1) : '–'}</strong></span>
                              </div>
                              <p style={styles.dateLabel}>Submitted: {new Date(sub.submitted_at).toLocaleDateString()}</p>
                              <button 
                                onClick={() => setSelectedReview(sub)} 
                                className="btn btn-secondary" 
                                style={{ marginTop: '0.75rem', width: '100%', justifyContent: 'center', fontSize: '0.8rem' }}
                              >
                                🔍 View Teacher Feedback & Full Breakdown
                              </button>
                            </div>
                          );
                        })
                      )}
                    </div>

                    {/* BREAKDOWN 2: Separate Practice Test Breakdown (L & R) */}
                    <div style={{ marginBottom: '2.5rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
                        <span style={{ fontSize: '1.25rem' }}>📚</span>
                        <h3 style={{ ...styles.sectionTitle, margin: 0 }}>2. Separate Practice Test Scores (L & R)</h3>
                      </div>

                      {separateSubs.length === 0 ? (
                        <div className="card" style={styles.emptyCard}>
                          <p style={{ fontSize: '0.85rem' }}>No separate Reading or Listening practice test scores recorded yet.</p>
                        </div>
                      ) : (
                        separateSubs.map((sub) => {
                          const isReading = sub.title.toLowerCase().includes('reading');
                          const scoreVal = isReading ? sub.reading_score : sub.listening_score;

                          return (
                            <div className="card" style={{ ...styles.resultCard, borderLeft: `4px solid ${isReading ? '#10b981' : '#3b82f6'}`, marginBottom: '1rem' }} key={sub.id}>
                              <div style={styles.resultHeader}>
                                <div>
                                  <h4 style={styles.testTitle}>{sub.title}</h4>
                                  <span style={{ ...styles.statusLabel, backgroundColor: isReading ? '#10b981' : '#3b82f6', marginTop: '0.3rem', display: 'inline-block' }}>
                                    {isReading ? '📖 Reading Practice' : '🎧 Listening Practice'}
                                  </span>
                                </div>
                                <div style={{ textAlign: 'right' }}>
                                  <span style={{ fontSize: '1.6rem', fontWeight: '800', color: isReading ? '#10b981' : '#3b82f6' }}>
                                    {scoreVal ? `Band ${scoreVal.toFixed(1)}` : '–'}
                                  </span>
                                  <span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Instant Score</span>
                                </div>
                              </div>

                              <p style={styles.dateLabel}>Submitted: {new Date(sub.submitted_at).toLocaleDateString()}</p>
                              <button 
                                onClick={() => setSelectedReview(sub)} 
                                className="btn btn-secondary" 
                                style={{ marginTop: '0.75rem', width: '100%', justifyContent: 'center', fontSize: '0.8rem' }}
                              >
                                🔍 Review Answers & Explanations
                              </button>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </>
      )}
      </main>

      {/* Review Modal */}
      {selectedReview && (
        <div style={styles.modalOverlay}>
          <div className="glass-panel" style={{ ...styles.modalContent, backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>
            <div style={{ ...styles.modalHeader, borderBottom: '1px solid var(--glass-border)' }}>
              <h3 style={{ color: 'var(--text-primary)', fontWeight: '600' }}>Detailed Assessment Report</h3>
              <button onClick={() => setSelectedReview(null)} style={styles.closeBtn}>×</button>
            </div>
            
            <div style={styles.modalBody}>
              <h4 style={{ marginBottom: '1rem', color: 'var(--text-primary)', fontWeight: '600' }}>{selectedReview.title}</h4>
              
              <div style={{ ...styles.overallMetricBanner, backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--glass-border)' }}>
                <div style={{ ...styles.metricItem, borderRight: '1px solid var(--glass-border)' }}>
                  <span style={{ ...styles.metricVal, color: 'var(--text-primary)' }}>{selectedReview.listening_score.toFixed(1)}</span>
                  <span style={{ ...styles.metricLabel, color: 'var(--text-secondary)' }}>Listening Band</span>
                </div>
                <div style={{ ...styles.metricItem, borderRight: '1px solid var(--glass-border)' }}>
                  <span style={{ ...styles.metricVal, color: 'var(--text-primary)' }}>{selectedReview.reading_score.toFixed(1)}</span>
                  <span style={{ ...styles.metricLabel, color: 'var(--text-secondary)' }}>Reading Band</span>
                </div>
                <div style={{ ...styles.metricItem, borderRight: '1px solid var(--glass-border)' }}>
                  <span style={{ ...styles.metricVal, color: 'var(--text-primary)' }}>
                    {selectedReview.writing_score ? selectedReview.writing_score.toFixed(1) : 'Pending'}
                  </span>
                  <span style={{ ...styles.metricLabel, color: 'var(--text-secondary)' }}>Writing Band</span>
                </div>
                <div style={{ ...styles.metricItem, border: 'none', backgroundColor: '#6366f1' }}>
                  <span style={{ ...styles.metricVal, color: '#ffffff' }}>
                    {getIeltsOverall(selectedReview.listening_score, selectedReview.reading_score, selectedReview.writing_score)}
                  </span>
                  <span style={{ ...styles.metricLabel, color: '#e2e8f0' }}>Overall Score</span>
                </div>
              </div>

              {selectedReview.writing_scores && (
                <div style={{ ...styles.rubricSection, backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--glass-border)' }}>
                  <h5 style={{ color: 'var(--text-primary)', fontWeight: '600', marginBottom: '0.75rem' }}>Writing Evaluation Criteria Breakdown</h5>
                  <div style={styles.rubricsGrid}>
                    <div style={{ ...styles.rubricRow, borderBottom: '1px solid var(--glass-border)' }}>
                      <span style={{ color: 'var(--text-secondary)' }}>Task Response / Achievement:</span>
                      <strong style={{ color: 'var(--text-primary)' }}>{JSON.parse(selectedReview.writing_scores).ta.toFixed(1)}</strong>
                    </div>
                    <div style={{ ...styles.rubricRow, borderBottom: '1px solid var(--glass-border)' }}>
                      <span style={{ color: 'var(--text-secondary)' }}>Coherence & Cohesion:</span>
                      <strong style={{ color: 'var(--text-primary)' }}>{JSON.parse(selectedReview.writing_scores).cc.toFixed(1)}</strong>
                    </div>
                    <div style={{ ...styles.rubricRow, borderBottom: '1px solid var(--glass-border)' }}>
                      <span style={{ color: 'var(--text-secondary)' }}>Lexical Resource (Vocabulary):</span>
                      <strong style={{ color: 'var(--text-primary)' }}>{JSON.parse(selectedReview.writing_scores).lr.toFixed(1)}</strong>
                    </div>
                    <div style={{ ...styles.rubricRow, borderBottom: '1px solid var(--glass-border)' }}>
                      <span style={{ color: 'var(--text-secondary)' }}>Grammatical Range & Accuracy:</span>
                      <strong style={{ color: 'var(--text-primary)' }}>{JSON.parse(selectedReview.writing_scores).gra.toFixed(1)}</strong>
                    </div>
                  </div>
                </div>
              )}

              <div style={{ 
                ...styles.feedbackSection, 
                backgroundColor: theme === 'light' ? 'rgba(16, 185, 129, 0.05)' : 'rgba(16, 185, 129, 0.08)',
                borderColor: theme === 'light' ? 'rgba(16, 185, 129, 0.25)' : 'rgba(16, 185, 129, 0.2)'
              }}>
                <h5 style={{ color: '#10b981', fontWeight: '600', marginBottom: '0.5rem' }}>✍️ Teacher Feedback & Advice</h5>
                <p style={{ ...styles.feedbackText, color: theme === 'light' ? '#065f46' : '#e2e8f0' }}>{selectedReview.teacher_feedback || "Teacher hasn't submitted a summary feedback yet."}</p>
              </div>

              <div style={styles.essaysSection}>
                <h5 style={{ color: 'var(--text-primary)', fontWeight: '600', marginBottom: '0.75rem' }}>Your Submitted Essays</h5>
                <div style={{ ...styles.essayBox, backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--glass-border)' }}>
                  <h6 style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem', fontWeight: '600' }}>Writing Task 1:</h6>
                  <p style={{ ...styles.essayText, color: 'var(--text-primary)' }}>{JSON.parse(selectedReview.writing_answers || '{}').task1 || 'No answer submitted'}</p>
                </div>
                <div style={{ ...styles.essayBox, marginTop: '1rem', backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--glass-border)' }}>
                  <h6 style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem', fontWeight: '600' }}>Writing Task 2:</h6>
                  <p style={{ ...styles.essayText, color: 'var(--text-primary)' }}>{JSON.parse(selectedReview.writing_answers || '{}').task2 || 'No answer submitted'}</p>
                </div>
              </div>

              {/* Detailed Listening & Reading Review section */}
              <div style={{ marginTop: '2rem', borderTop: '1px solid var(--glass-border)', paddingTop: '1.5rem' }}>
                <h5 style={{ color: 'var(--text-primary)', fontWeight: '600', marginBottom: '0.75rem' }}>🎧 & 📖 Detailed Answers Review</h5>
                
                <div style={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'center', userSelect: 'none', marginBottom: '1rem' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.9rem', fontWeight: '600' }}>
                    <input 
                      type="checkbox" 
                      checked={showOnlyMistakes} 
                      onChange={(e) => setShowOnlyMistakes(e.target.checked)} 
                    />
                    <span>⚠️ Show only incorrect or empty answers</span>
                  </label>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
                  {/* Listening Column */}
                  <div>
                    <h6 style={{ color: 'var(--text-primary)', fontWeight: '600', marginBottom: '0.5rem' }}>Listening Questions</h6>
                    {!answerKey ? (
                      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                        {loadingKey ? 'Extracting answer keys...' : 'Answer key details could not be found.'}
                      </p>
                    ) : (
                      <table style={styles.reviewTable}>
                        <thead>
                          <tr>
                            <th style={styles.reviewTh}>Q</th>
                            <th style={styles.reviewTh}>Your Answer</th>
                            <th style={styles.reviewTh}>Correct Answer</th>
                            <th style={styles.reviewTh}>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Array.from({ length: 40 }, (_, idx) => {
                            const qNum = idx + 1;
                            const studentAns = selectedReview.listening_answers[qNum] || '';
                            const correctArr = answerKey.answers['l' + qNum] || [];
                            const displayCorrect = answerKey.display['l' + qNum] || correctArr.join(' / ') || '—';
                            const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
                            const sNorm = norm(studentAns);
                            const isOk = correctArr.some(ans => norm(ans) === sNorm);
                            
                            if (showOnlyMistakes && isOk) return null;
                            
                            return (
                              <tr key={qNum} style={{ 
                                borderBottom: '1px solid var(--glass-border)',
                                backgroundColor: isOk 
                                  ? 'rgba(16, 185, 129, 0.04)' 
                                  : studentAns 
                                    ? 'rgba(244, 63, 94, 0.04)' 
                                    : 'rgba(148, 163, 184, 0.04)'
                              }}>
                                <td style={styles.reviewTd}><strong>{qNum}</strong></td>
                                <td style={styles.reviewTd}>{studentAns || '—'}</td>
                                <td style={styles.reviewTd}>{displayCorrect}</td>
                                <td style={{ ...styles.reviewTd, color: isOk ? '#10b981' : studentAns ? '#f43f5e' : '#94a3b8', fontWeight: 'bold', fontSize: '0.8rem' }}>
                                  {isOk ? '✓ Correct' : studentAns ? '✗ Wrong' : '— Empty'}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>

                  {/* Reading Column */}
                  <div>
                    <h6 style={{ color: 'var(--text-primary)', fontWeight: '600', marginBottom: '0.5rem' }}>Reading Questions</h6>
                    {!answerKey ? (
                      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                        {loadingKey ? 'Extracting answer keys...' : 'Answer key details could not be found.'}
                      </p>
                    ) : (
                      <table style={styles.reviewTable}>
                        <thead>
                          <tr>
                            <th style={styles.reviewTh}>Q</th>
                            <th style={styles.reviewTh}>Your Answer</th>
                            <th style={styles.reviewTh}>Correct Answer</th>
                            <th style={styles.reviewTh}>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Array.from({ length: 40 }, (_, idx) => {
                            const qNum = idx + 1;
                            const studentAns = selectedReview.reading_answers[qNum] || '';
                            const correctArr = answerKey.answers['r' + qNum] || [];
                            const displayCorrect = answerKey.display['r' + qNum] || correctArr.join(' / ') || '—';
                            const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
                            const sNorm = norm(studentAns);
                            const isOk = correctArr.some(ans => norm(ans) === sNorm);
                            
                            if (showOnlyMistakes && isOk) return null;
                            
                            return (
                              <tr key={qNum} style={{ 
                                borderBottom: '1px solid var(--glass-border)',
                                backgroundColor: isOk 
                                  ? 'rgba(16, 185, 129, 0.04)' 
                                  : studentAns 
                                    ? 'rgba(244, 63, 94, 0.04)' 
                                    : 'rgba(148, 163, 184, 0.04)'
                              }}>
                                <td style={styles.reviewTd}><strong>{qNum}</strong></td>
                                <td style={styles.reviewTd}>{studentAns || '—'}</td>
                                <td style={styles.reviewTd}>{displayCorrect}</td>
                                <td style={{ ...styles.reviewTd, color: isOk ? '#10b981' : studentAns ? '#f43f5e' : '#94a3b8', fontWeight: 'bold', fontSize: '0.8rem' }}>
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
              </div>
            </div>
            
            <div style={{ ...styles.modalFooter, borderTop: '1px solid var(--glass-border)' }}>
              <button onClick={() => setSelectedReview(null)} className="btn btn-primary">Close Report</button>
            </div>
          </div>
        </div>
      )}

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
    backgroundColor: '#0b0f19',
  },
  header: {
    backgroundColor: '#161f30',
    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
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
    backgroundColor: '#6366f1',
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
    color: '#ffffff',
  },
  userId: {
    fontSize: '0.85rem',
    color: '#94a3b8',
  },
  logoutBtn: {
    padding: '0.5rem 1rem',
    fontSize: '0.9rem',
  },
  mainContent: {
    flex: 1,
    paddingTop: '2.5rem',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '2.5rem',
  },
  leftCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
  },
  rightCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
  },
  sectionTitle: {
    fontSize: '1.2rem',
    fontWeight: '600',
    color: '#ffffff',
    marginBottom: '0.5rem',
  },
  emptyCard: {
    textAlign: 'center',
    padding: '3rem 2rem',
    color: '#94a3b8',
  },
  assignmentCard: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  testTitle: {
    fontSize: '1.1rem',
    fontWeight: '600',
    color: 'var(--text-primary)',
    marginBottom: '0.5rem',
  },
  statusLabel: {
    display: 'inline-block',
    fontSize: '0.75rem',
    color: '#ffffff',
    padding: '0.2rem 0.5rem',
    borderRadius: '4px',
    fontWeight: '600',
    marginBottom: '0.5rem',
  },
  dateLabel: {
    fontSize: '0.85rem',
    color: '#94a3b8',
  },
  actionBtn: {
    padding: '0.6rem 1.25rem',
    fontSize: '0.9rem',
  },
  resultCard: {
    marginBottom: '1rem',
  },
  resultHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: '1rem',
  },
  overallScoreBox: {
    backgroundColor: '#1e293b',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '8px',
    padding: '0.5rem 0.75rem',
    textAlign: 'center',
    minWidth: '80px',
  },
  scoreNumber: {
    display: 'block',
    fontSize: '1.5rem',
    fontWeight: '700',
    color: '#10b981',
  },
  scoreText: {
    fontSize: '0.65rem',
    color: '#94a3b8',
    textTransform: 'uppercase',
  },
  miniScores: {
    display: 'flex',
    gap: '1rem',
    fontSize: '0.9rem',
    backgroundColor: 'var(--bg-tertiary)',
    padding: '0.5rem 1rem',
    borderRadius: '6px',
  },
  miniScore: {
    color: 'var(--text-secondary)',
  },
  errorAlert: {
    backgroundColor: 'rgba(244, 63, 94, 0.15)',
    color: '#f43f5e',
    padding: '1rem',
    borderRadius: '8px',
    marginBottom: '1.5rem',
  },
  loadingContainer: {
    textAlign: 'center',
    padding: '4rem',
    fontSize: '1.2rem',
    color: '#94a3b8',
  },

  /* Modal Styles */
  modalOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.7)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    padding: '1rem',
  },
  modalContent: {
    width: '100%',
    maxWidth: '750px',
    maxHeight: '90vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  modalHeader: {
    padding: '1.5rem',
    borderBottom: '1px solid var(--glass-border)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    h3: {
      fontSize: '1.25rem',
      fontWeight: '600',
    }
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: '#94a3b8',
    fontSize: '2rem',
    cursor: 'pointer',
    lineHeight: '1',
  },
  modalBody: {
    padding: '1.5rem',
    overflowY: 'auto',
    flex: 1,
  },
  overallMetricBanner: {
    display: 'flex',
    backgroundColor: 'rgba(0,0,0,0.2)',
    borderRadius: '8px',
    overflow: 'hidden',
    marginBottom: '1.5rem',
    border: '1px solid var(--glass-border)',
  },
  metricItem: {
    flex: 1,
    padding: '1rem',
    textAlign: 'center',
    borderRight: '1px solid var(--glass-border)',
  },
  metricVal: {
    display: 'block',
    fontSize: '1.75rem',
    fontWeight: '700',
    color: '#cbd5e1',
  },
  metricLabel: {
    fontSize: '0.75rem',
    color: '#94a3b8',
    textTransform: 'uppercase',
  },
  rubricSection: {
    backgroundColor: '#161f30',
    border: '1px solid var(--glass-border)',
    borderRadius: '8px',
    padding: '1rem 1.25rem',
    marginBottom: '1.5rem',
    h5: {
      fontWeight: '600',
      marginBottom: '0.75rem',
    }
  },
  rubricsGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '0.75rem',
  },
  rubricRow: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '0.9rem',
    color: '#cbd5e1',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
    paddingBottom: '0.25rem',
  },
  feedbackSection: {
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
    border: '1px solid rgba(16, 185, 129, 0.2)',
    borderRadius: '8px',
    padding: '1.25rem',
    marginBottom: '1.5rem',
    h5: {
      color: '#10b981',
      fontWeight: '600',
      marginBottom: '0.5rem',
    }
  },
  feedbackText: {
    fontSize: '0.95rem',
    lineHeight: '1.5',
    color: '#e2e8f0',
  },
  essaysSection: {
    h5: {
      fontWeight: '600',
      marginBottom: '0.75rem',
    }
  },
  essayBox: {
    backgroundColor: '#151c2c',
    border: '1px solid var(--glass-border)',
    borderRadius: '8px',
    padding: '1rem',
    h6: {
      color: '#94a3b8',
      marginBottom: '0.5rem',
    }
  },
  essayText: {
    fontSize: '0.9rem',
    lineHeight: '1.6',
    whiteSpace: 'pre-wrap',
    color: '#cbd5e1',
  },
  modalFooter: {
    padding: '1.25rem 1.5rem',
    borderTop: '1px solid var(--glass-border)',
    display: 'flex',
    justifyContent: 'flex-end',
  },
  progressCard: {
    padding: '1.75rem',
    background: 'linear-gradient(135deg, rgba(22, 31, 48, 0.35) 0%, rgba(11, 15, 25, 0.5) 100%)',
    border: '1px solid var(--glass-border)',
    borderRadius: '12px',
  },
  progressDashboardGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: '1.5rem',
    marginTop: '0.75rem',
    alignItems: 'center',
  },
  progressInfoPanel: {
    display: 'flex',
    flexDirection: 'column',
  },
  trendRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
  },
  metricComparisonBox: {
    display: 'flex',
    alignItems: 'center',
    gap: '1.5rem',
    marginTop: '0.5rem',
  },
  metricCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
  },
  chartPanel: {
    height: '140px',
    backgroundColor: 'rgba(0, 0, 0, 0.25)',
    borderRadius: '8px',
    padding: '1rem 1.25rem',
    border: '1px solid rgba(255, 255, 255, 0.03)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  singleTestNote: {
    color: '#94a3b8',
    fontSize: '0.9rem',
    fontStyle: 'italic',
    textAlign: 'center',
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
