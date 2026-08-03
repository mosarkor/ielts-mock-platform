import React, { useState } from 'react';

export default function LoginPortal({ onLoginSuccess, theme, toggleTheme }) {
  const [roleMode, setRoleMode] = useState('student'); // 'student' or 'staff'
  const [userId, setUserId] = useState('');
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPasscode, setShowPasscode] = useState(false);

  // Sound Check State
  const [tempUser, setTempUser] = useState(null);
  const [soundCheckStep, setSoundCheckStep] = useState(false);
  const [candidateConfirmStep, setCandidateConfirmStep] = useState(false);

  const handleLoginSubmit = async (e) => {
    e.preventDefault();
    if (!userId.trim() || !passcode.trim()) {
      setError('Please fill in all fields');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: userId.trim(), passcode: passcode.trim() })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Login failed');
      }

      if (data.role === 'student') {
        // Show candidate confirmation before entering
        setTempUser(data);
        setCandidateConfirmStep(true);
      } else {
        // Staff log in directly to dashboard
        onLoginSuccess(data);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const playSynthesizedChime = () => {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioContext();
      
      // Sequence of clean notes: C5, E5, G5, C6 (Arpeggio chime)
      const notes = [523.25, 659.25, 783.99, 1046.50];
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.15);
        
        gain.gain.setValueAtTime(0.2, ctx.currentTime + idx * 0.15);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.15 + 0.6);
        
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + idx * 0.15);
        osc.stop(ctx.currentTime + idx * 0.15 + 0.65);
      });
    } catch (err) {
      console.error('AudioContext is blocked or not supported:', err);
    }
  };

  if (candidateConfirmStep && tempUser) {
    return (
      <div style={styles.fullscreenOverlay}>
        <div style={styles.cdPanel}>
          <div style={styles.cdHeader}>
            <div style={styles.ieltsLogo}>IELTS <span>Mock</span></div>
            <div style={styles.headerLabel}>Confirm Candidate Details</div>
          </div>
          <div style={styles.cdContent}>
            <p style={styles.instruction}>Please check that your details are correct before starting.</p>
            <div style={styles.detailsGrid}>
              <div style={styles.detailRow}>
                <span style={styles.detailLabel}>Candidate Name:</span>
                <span style={styles.detailVal}>{tempUser.name}</span>
              </div>
              <div style={styles.detailRow}>
                <span style={styles.detailLabel}>Candidate ID:</span>
                <span style={styles.detailVal}>{tempUser.id}</span>
              </div>
              {tempUser.group_name && (
                <div style={styles.detailRow}>
                  <span style={styles.detailLabel}>Group:</span>
                  <span style={styles.detailVal}>{tempUser.group_name}</span>
                </div>
              )}
            </div>
            <div style={styles.actionButtons}>
              <button 
                onClick={() => {
                  setCandidateConfirmStep(false);
                  setSoundCheckStep(true);
                }} 
                style={styles.btnBlue}
              >
                My details are correct
              </button>
              <button 
                onClick={() => {
                  setCandidateConfirmStep(false);
                  setTempUser(null);
                }} 
                style={styles.btnOutline}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (soundCheckStep && tempUser) {
    return (
      <div style={styles.fullscreenOverlay}>
        <div style={styles.cdPanel}>
          <div style={styles.cdHeader}>
            <div style={styles.ieltsLogo}>IELTS <span>Mock</span></div>
            <div style={styles.headerLabel}>Sound Check</div>
          </div>
          <div style={styles.cdContent}>
            <p style={styles.instruction}>
              Put on your headphones. Click the button below to test if the sound is working.
            </p>
            <div style={styles.soundTestBox}>
              <button onClick={playSynthesizedChime} style={styles.soundCheckBtn}>
                🔊 Play Sound Test
              </button>
            </div>
            <p style={styles.soundSubtext}>
              If you can hear the sound clearly, click the button below to continue.
            </p>
            <div style={styles.actionButtons}>
              <button 
                onClick={() => {
                  setSoundCheckStep(false);
                  onLoginSuccess(tempUser);
                }} 
                style={styles.btnBlue}
              >
                I can hear the sound clearly
              </button>
              <button 
                onClick={() => {
                  setSoundCheckStep(false);
                  setCandidateConfirmStep(true);
                }} 
                style={styles.btnOutline}
              >
                Go Back
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page-container" style={styles.pageContainer}>
      <button 
        onClick={toggleTheme} 
        className="theme-toggle-btn"
        style={{ position: 'absolute', top: '1.5rem', right: '1.5rem', border: 'none' }}
        title="Toggle Light/Dark Theme"
      >
        {theme === 'dark' ? '☀️' : '🌙'}
      </button>

      <div className="glass-panel" style={styles.loginCard}>
        <div style={styles.logoHeader}>
          <h2>IELTS <span>Mock Exam Portal</span></h2>
          <p>Access your candidate exam cabinet or staff dashboards</p>
        </div>

        <div style={styles.tabContainer}>
          <button 
            style={{
              ...styles.tabBtn,
              ...(roleMode === 'student' ? styles.tabBtnActive : {})
            }}
            onClick={() => {
              setRoleMode('student');
              setError('');
            }}
          >
            👨‍🎓 Candidate Login
          </button>
          <button 
            style={{
              ...styles.tabBtn,
              ...(roleMode === 'staff' ? styles.tabBtnActive : {})
            }}
            onClick={() => {
              setRoleMode('staff');
              setError('');
            }}
          >
            🏫 Staff Portal
          </button>
        </div>

        {error && <div style={styles.errorAlert}>{error}</div>}

        <form onSubmit={handleLoginSubmit}>
          <div className="form-group">
            <label className="form-label">
              {roleMode === 'student' ? 'Candidate ID (e.g. G1-01)' : 'Staff Username (teacher / admin)'}
            </label>
            <input 
              type="text" 
              className="form-input" 
              placeholder={roleMode === 'student' ? "Type Candidate ID" : "Type staff username (e.g. teacher)"}
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              disabled={loading}
              autoFocus
            />
          </div>

          <div className="form-group">
            <label className="form-label">Passcode</label>
            <div style={{ position: 'relative' }}>
              <input 
                type={showPasscode ? "text" : "password"} 
                className="form-input" 
                placeholder="••••••••"
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
                disabled={loading}
                style={{ paddingRight: '2.5rem' }}
              />
              <button
                type="button"
                onClick={() => setShowPasscode(prev => !prev)}
                style={{
                  position: 'absolute',
                  right: '0.75rem',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  fontSize: '1.1rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 0,
                  outline: 'none',
                }}
                title={showPasscode ? "Hide Passcode" : "Show Passcode"}
              >
                {showPasscode ? '👁️' : '🙈'}
              </button>
            </div>
          </div>

          {roleMode === 'staff' && (
            <div style={styles.hintText}>
              💡 <strong>Teacher Credentials:</strong> Username: <code>teacher</code> | Passcode: <code>teacher123</code><br/>
              💡 <strong>Admin Credentials:</strong> Username: <code>admin</code> | Passcode: <code>admin123</code>
            </div>
          )}

          <button 
            type="submit" 
            className="btn btn-primary" 
            style={{ width: '100%', justifyContent: 'center', marginTop: '1rem' }}
            disabled={loading}
          >
            {loading ? 'Processing...' : 'Continue'}
          </button>
        </form>
      </div>
    </div>
  );
}

const styles = {
  pageContainer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    padding: '1rem',
    background: 'radial-gradient(circle at 50% 50%, #151e33 0%, #0b0f19 100%)',
  },
  loginCard: {
    width: '100%',
    maxWidth: '460px',
    padding: '2.5rem 2rem',
  },
  logoHeader: {
    textAlign: 'center',
    marginBottom: '2rem',
    h2: {
      fontSize: '1.75rem',
      fontWeight: '700',
    }
  },
  tabContainer: {
    display: 'flex',
    background: 'rgba(0,0,0,0.2)',
    borderRadius: '8px',
    padding: '0.25rem',
    marginBottom: '1.5rem',
  },
  tabBtn: {
    flex: 1,
    padding: '0.6rem',
    background: 'transparent',
    border: 'none',
    color: '#94a3b8',
    cursor: 'pointer',
    borderRadius: '6px',
    fontWeight: '600',
    fontSize: '0.9rem',
    transition: 'all 0.2s',
  },
  tabBtnActive: {
    background: '#1e293b',
    color: '#ffffff',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
  },
  errorAlert: {
    backgroundColor: 'rgba(244, 63, 94, 0.15)',
    color: '#f43f5e',
    padding: '0.75rem 1rem',
    borderRadius: '6px',
    fontSize: '0.875rem',
    border: '1px solid rgba(244, 63, 94, 0.3)',
    marginBottom: '1.25rem',
  },
  hintText: {
    fontSize: '0.8rem',
    color: '#94a3b8',
    marginTop: '0.5rem',
    lineHeight: '1.4',
  },

  /* IELTS Sound Check Overlay Styles (matches authentic CD-IELTS design) */
  fullscreenOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#f3f4f6',
    color: '#1f2937',
    fontFamily: '"Inter", sans-serif',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
  },
  cdPanel: {
    width: '100%',
    maxWidth: '650px',
    backgroundColor: '#ffffff',
    border: '1px solid #d1d5db',
    borderRadius: '4px',
    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
  },
  cdHeader: {
    backgroundColor: '#1e293b',
    color: '#ffffff',
    padding: '0.75rem 1.5rem',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottom: '3px solid #2563eb',
  },
  ieltsLogo: {
    fontWeight: '700',
    fontSize: '1.25rem',
    letterSpacing: '1px',
    color: '#fff',
  },
  headerLabel: {
    fontSize: '0.95rem',
    fontWeight: '500',
    color: '#e2e8f0',
  },
  cdContent: {
    padding: '2rem',
  },
  instruction: {
    fontSize: '1rem',
    fontWeight: '500',
    marginBottom: '1.5rem',
    color: '#374151',
  },
  detailsGrid: {
    backgroundColor: '#f9fafb',
    border: '1px solid #e5e7eb',
    borderRadius: '4px',
    padding: '1.5rem',
    marginBottom: '2rem',
  },
  detailRow: {
    display: 'grid',
    gridTemplateColumns: '180px 1fr',
    padding: '0.5rem 0',
    borderBottom: '1px solid #f3f4f6',
  },
  detailLabel: {
    fontWeight: '600',
    color: '#6b7280',
  },
  detailVal: {
    fontWeight: '600',
    color: '#111827',
  },
  actionButtons: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '1rem',
    marginTop: '1.5rem',
  },
  btnBlue: {
    backgroundColor: '#2563eb',
    color: '#ffffff',
    border: 'none',
    borderRadius: '4px',
    padding: '0.6rem 1.5rem',
    fontWeight: '600',
    cursor: 'pointer',
    fontSize: '0.95rem',
  },
  btnOutline: {
    backgroundColor: 'transparent',
    color: '#4b5563',
    border: '1px solid #d1d5db',
    borderRadius: '4px',
    padding: '0.6rem 1.5rem',
    fontWeight: '600',
    cursor: 'pointer',
    fontSize: '0.95rem',
  },
  soundTestBox: {
    backgroundColor: '#f3f4f6',
    border: '1px dotted #9ca3af',
    borderRadius: '4px',
    padding: '2rem',
    textAlign: 'center',
    marginBottom: '1.5rem',
  },
  soundCheckBtn: {
    backgroundColor: '#10b981',
    color: '#ffffff',
    border: 'none',
    borderRadius: '4px',
    padding: '0.75rem 2rem',
    fontWeight: '700',
    cursor: 'pointer',
    fontSize: '1rem',
    boxShadow: '0 2px 4px rgba(0,0,0,0.15)',
  },
  soundSubtext: {
    fontSize: '0.9rem',
    color: '#4b5563',
    lineHeight: '1.5',
  }
};
