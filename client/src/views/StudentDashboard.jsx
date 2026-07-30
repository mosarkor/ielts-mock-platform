import React, { useState, useEffect } from 'react';
import ChangePasswordModal from '../components/ChangePasswordModal';

export default function StudentDashboard({ user, onLogout, onStartTest, theme, toggleTheme }) {
  const [showPwdModal, setShowPwdModal] = useState(false);
  const [assignments, setAssignments] = useState([]);
  const [submissions, setSubmissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  
  // Review Modal State
  const [selectedReview, setSelectedReview] = useState(null);

  useEffect(() => {
    fetchDashboardData();
  }, [user.id]);

  const fetchDashboardData = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/student/dashboard/${user.id}`);
      if (!res.ok) throw new Error('Failed to load dashboard data');
      const data = await res.json();
      setAssignments(data.assignments);
      setSubmissions(data.submissions);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

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

  // Helper to round IELTS score to nearest 0.5
  const getIeltsOverall = (l, r, w) => {
    if (!w) return ((l + r) / 2).toFixed(1);
    const avg = (l + r + w) / 3;
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
            <div style={styles.grid}>
            {/* Left Column: Assigned Tests */}
            <div style={styles.leftCol}>
              <h3 style={styles.sectionTitle}>📝 Assigned Mock Tests</h3>
              {assignments.length === 0 ? (
                <div className="card" style={styles.emptyCard}>
                  <p>🎉 No pending tests assigned. Well done!</p>
                </div>
              ) : (
                assignments.map((asg) => (
                  <div className="card" style={styles.assignmentCard} key={asg.assignment_id}>
                    <div>
                      <h4 style={styles.testTitle}>{asg.title}</h4>
                      <span style={{
                        ...styles.statusLabel,
                        backgroundColor: asg.status === 'started' ? '#f59e0b' : '#6366f1'
                      }}>
                        {asg.status === 'started' ? 'In Progress' : 'Assigned'}
                      </span>
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
                ))
              )}
            </div>

            {/* Right Column: Past Results */}
            <div style={styles.rightCol}>
              <h3 style={styles.sectionTitle}>🏆 Past Results & Performance Feedback</h3>
              {submissions.length === 0 ? (
                <div className="card" style={styles.emptyCard}>
                  <p>No graded results released yet. Submissions are marked by teachers within 24 hours.</p>
                </div>
              ) : (
                submissions.map((sub) => {
                  const overall = getIeltsOverall(sub.listening_score, sub.reading_score, sub.writing_score);
                  return (
                    <div className="card" style={styles.resultCard} key={sub.id}>
                      <div style={styles.resultHeader}>
                        <h4 style={styles.testTitle}>{sub.title}</h4>
                        <div style={styles.overallScoreBox}>
                          <span style={styles.scoreNumber}>{overall}</span>
                          <span style={styles.scoreText}>Overall Band</span>
                        </div>
                      </div>
                      <div style={styles.miniScores}>
                        <span style={styles.miniScore}>🎧 Listening: <strong>{sub.listening_score.toFixed(1)}</strong></span>
                        <span style={styles.miniScore}>📖 Reading: <strong>{sub.reading_score.toFixed(1)}</strong></span>
                        <span style={styles.miniScore}>✍️ Writing: <strong>{sub.writing_score ? sub.writing_score.toFixed(1) : 'Pending'}</strong></span>
                      </div>
                      <p style={styles.dateLabel}>Submitted: {new Date(sub.submitted_at).toLocaleDateString()}</p>
                      <button 
                        onClick={() => setSelectedReview(sub)} 
                        className="btn btn-secondary" 
                        style={{ marginTop: '1rem', width: '100%', justifyContent: 'center' }}
                      >
                        🔍 View Teacher Comments & Criteria
                      </button>
                    </div>
                  );
                })
              )}
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
  }
};
