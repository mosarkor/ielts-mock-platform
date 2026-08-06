
const fmtScore = (v) => (v === null || v === undefined || isNaN(Number(v))) ? '—' : Number(v).toFixed(1);
import React, { useState, useEffect } from 'react';
import ChangePasswordModal from '../components/ChangePasswordModal';

export default function AdminDashboard({ user, onLogout, onSwitchRole, theme, toggleTheme }) {
  const [showPwdModal, setShowPwdModal] = useState(false);
  const [metrics, setMetrics] = useState({ students: 0, tests: 0, pendingGrades: 0, completedGrades: 0 });
  const [students, setStudents] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [tests, setTests] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Form States: New Candidate
  const [newStudentId, setNewStudentId] = useState('');
  const [newStudentName, setNewStudentName] = useState('');
  const [newStudentPass, setNewStudentPass] = useState('student123');
  const [newUserRole, setNewUserRole] = useState('student');
  const [newStudentGroup, setNewStudentGroup] = useState('');

  // Form States: New Assignment
  const [selectedTestIds, setSelectedTestIds] = useState([]);
  const [selectedStudentIds, setSelectedStudentIds] = useState([]);

  // Form States: Test Creator
  const [testTitle, setTestTitle] = useState('');
  const [showTestCreator, setShowTestCreator] = useState(false);
  const [uploadedHtmlContent, setUploadedHtmlContent] = useState('');
  const [uploadingTest, setUploadingTest] = useState(false);

  // Bulk Import State
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [bulkImportText, setBulkImportText] = useState('');
  const [bulkImporting, setBulkImporting] = useState(false);
  const [bulkResults, setBulkResults] = useState(null);

  // Assignment Filters
  const [filterGroup, setFilterGroup] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');

  // Directory & Assign Search States
  const [userSearchTerm, setUserSearchTerm] = useState('');
  const [userGroupFilter, setUserGroupFilter] = useState('all');
  const [assignSearchTerm, setAssignSearchTerm] = useState('');

  // Speaking Module States
  const [speakingPrompts, setSpeakingPrompts] = useState([]);
  const [aiSettings, setAiSettings] = useState({ provider: 'gemini', gemini_api_key_set: false, openai_api_key_set: false });
  const [showSpeakingPanel, setShowSpeakingPanel] = useState(false);
  const [spTitle, setSpTitle] = useState('');
  const [spPart1, setSpPart1] = useState('Tell me about your hometown.\nWhat do you like to do in your free time?\nDo you prefer studying alone or with others?');
  const [spPart2, setSpPart2] = useState('Describe a memorable journey you have taken.\n\nYou should say:\n- Where you went\n- Who you went with\n- What you did there\n- And explain why it was memorable');
  const [spPart3, setSpPart3] = useState('How has tourism changed in recent years?\nWhat are the advantages and disadvantages of traveling abroad?\nDo you think travel broadens the mind?');
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [newGeminiKey, setNewGeminiKey] = useState('');
  const [newOpenaiKey, setNewOpenaiKey] = useState('');
  const [newAiProvider, setNewAiProvider] = useState('gemini');
  const [savingSettings, setSavingSettings] = useState(false);
  const [speakingAssignStudents, setSpeakingAssignStudents] = useState([]);
  const [speakingAssignPrompt, setSpeakingAssignPrompt] = useState('');

  useEffect(() => {
    fetchAdminData();
  }, []);

  const fetchAdminData = async () => {
    setLoading(true);
    try {
      const metricsRes = await fetch('/api/admin/overview');
      const usersRes = await fetch('/api/admin/users');
      const testsRes = await fetch('/api/admin/tests');
      const asgRes = await fetch('/api/admin/assignments');

      if (!metricsRes.ok || !usersRes.ok || !testsRes.ok || !asgRes.ok) {
        throw new Error('Failed to retrieve administrative records');
      }

      const metricsData = await metricsRes.json();
      const usersData = await usersRes.json();
      const testsData = await testsRes.json();
      const asgData = await asgRes.json();

      setMetrics(metricsData);
      setAllUsers(usersData);
      setStudents(usersData.filter(u => u.role === 'student'));
      setTests(testsData);
      setAssignments(asgData);

      if (testsData.length > 0) {
        setSelectedTestIds([testsData[0].id]);
      }

      // Load speaking data
      const [spkPromptsRes, settingsRes] = await Promise.all([
        fetch('/api/admin/speaking/prompts'),
        fetch('/api/admin/settings')
      ]);
      if (spkPromptsRes.ok) setSpeakingPrompts(await spkPromptsRes.json());
      if (settingsRes.ok) {
        const s = await settingsRes.json();
        setAiSettings(s);
        setNewAiProvider(s.provider || 'gemini');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const toggleTestSelection = (testId) => {
    const numericId = parseInt(testId);
    setSelectedTestIds(prev => 
      prev.includes(numericId)
        ? prev.filter(id => id !== numericId)
        : [...prev, numericId]
    );
  };

  const handleRegisterStudent = async (e) => {
    e.preventDefault();
    if (!newStudentId.trim() || !newStudentName.trim()) {
      alert('Please fill in User ID and Name');
      return;
    }

    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: newStudentId.trim(),
          name: newStudentName.trim(),
          role: newUserRole,
          password: newStudentPass,
          groupName: newUserRole === 'student' ? newStudentGroup.trim() : null
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to register user');

      alert(`${newUserRole.charAt(0).toUpperCase() + newUserRole.slice(1)} registered successfully!`);
      setNewStudentId('');
      setNewStudentName('');
      setNewStudentGroup('');
      fetchAdminData();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDeleteUser = async (userId) => {
    if (userId === user.id) {
      alert('Cannot delete your own account');
      return;
    }
    if (!confirm(`Are you sure you want to delete user "${userId}"?`)) {
      return;
    }
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete user');
      
      alert('User deleted successfully!');
      fetchAdminData();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleResetUserPassword = async (userId, currentName) => {
    const newPass = prompt(`Enter new passcode for "${currentName}" (${userId}):`);
    if (newPass === null) return; // user cancelled
    if (!newPass.trim()) {
      alert('Passcode cannot be empty');
      return;
    }
    try {
      const res = await fetch('/api/admin/users/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, newPassword: newPass.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to reset password');
      
      alert('Password updated successfully!');
      fetchAdminData();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleAssignTest = async (e) => {
    e.preventDefault();
    if (selectedStudentIds.length === 0) {
      alert('Please select at least one student');
      return;
    }
    if (selectedTestIds.length === 0) {
      alert('Please select at least one mock test');
      return;
    }

    try {
      const res = await fetch('/api/admin/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentIds: selectedStudentIds,
          testIds: selectedTestIds
        })
      });

      if (!res.ok) throw new Error('Failed to create test assignments');

      alert('Tests successfully assigned to selected candidates!');
      setSelectedStudentIds([]);
      fetchAdminData();
    } catch (err) {
      alert(err.message);
    }
  };

  const toggleStudentSelection = (sId) => {
    setSelectedStudentIds(prev => 
      prev.includes(sId) ? prev.filter(id => id !== sId) : [...prev, sId]
    );
  };

  // Bulk Import Handler
  const handleBulkImport = async () => {
    if (!bulkImportText.trim()) {
      alert('Please paste student data first.');
      return;
    }
    const lines = bulkImportText.trim().split('\n').filter(l => l.trim());
    const students = lines.map((line, idx) => {
      const parts = line.split(',').map(p => p.trim());
      const name = parts[0] || `Student ${idx + 1}`;
      const groupName = parts[1] || '';
      // Auto-generate ID from name initials + timestamp fragment
      const initials = name.split(' ').map(w => w[0] || '').join('').toUpperCase().slice(0, 3);
      const id = `${initials}${Date.now().toString().slice(-4)}${String(idx).padStart(2,'0')}`;
      const password = Math.random().toString(36).slice(2, 8).toUpperCase();
      return { id, name, password, groupName };
    });

    setBulkImporting(true);
    try {
      const res = await fetch('/api/admin/users/bulk-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ students })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Bulk import failed');
      setBulkResults(data.results);
      fetchAdminData();
    } catch (err) {
      alert(err.message);
    } finally {
      setBulkImporting(false);
    }
  };

  // Speaking Module Handlers
  const handleSaveAiSettings = async (e) => {
    e.preventDefault();
    setSavingSettings(true);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: newAiProvider,
          gemini_api_key: newGeminiKey,
          openai_api_key: newOpenaiKey
        })
      });
      if (!res.ok) throw new Error('Failed to update AI settings');
      alert('AI Provider settings saved successfully!');
      setNewGeminiKey('');
      setNewOpenaiKey('');
      fetchAdminData();
    } catch (err) {
      alert(err.message);
    } finally {
      setSavingSettings(false);
    }
  };

  const handleCreateSpeakingPrompt = async (e) => {
    e.preventDefault();
    if (!spTitle || !spPart1 || !spPart2 || !spPart3) {
      alert('Please fill out all prompt fields.');
      return;
    }
    setSavingPrompt(true);
    try {
      const part1Questions = spPart1.split('\n').map(q => q.trim()).filter(Boolean);
      const part3Questions = spPart3.split('\n').map(q => q.trim()).filter(Boolean);

      const res = await fetch('/api/admin/speaking/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: spTitle,
          part1Questions,
          part2CueCard: spPart2,
          part3Questions
        })
      });
      if (!res.ok) throw new Error('Failed to create speaking prompt');
      alert('Speaking prompt created successfully!');
      setSpTitle('');
      fetchAdminData();
    } catch (err) {
      alert(err.message);
    } finally {
      setSavingPrompt(false);
    }
  };

  const handleDeleteSpeakingPrompt = async (id) => {
    if (!confirm('Are you sure you want to delete this speaking prompt?')) return;
    try {
      const res = await fetch(`/api/admin/speaking/prompts/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete prompt');
      fetchAdminData();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleAssignSpeaking = async (e) => {
    e.preventDefault();
    if (!speakingAssignPrompt) {
      alert('Please select a speaking prompt.');
      return;
    }
    if (speakingAssignStudents.length === 0) {
      alert('Please select at least one student.');
      return;
    }
    try {
      const res = await fetch('/api/admin/speaking/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentIds: speakingAssignStudents,
          promptId: parseInt(speakingAssignPrompt)
        })
      });
      if (!res.ok) throw new Error('Failed to assign speaking test');
      alert('Speaking test assigned to selected candidates!');
      setSpeakingAssignStudents([]);
      fetchAdminData();
    } catch (err) {
      alert(err.message);
    }
  };


  // Assignment Management
  const handleDeleteAssignment = async (asgId) => {
    if (!confirm('Delete this assignment? The student will no longer see this test.')) return;
    try {
      await fetch(`/api/admin/assignments/${asgId}`, { method: 'DELETE' });
      fetchAdminData();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleResetAssignment = async (asgId, studentName, testTitle) => {
    if (!confirm(`Reset "${testTitle}" for ${studentName}? Their submitted answers will be cleared and they can retake it.`)) return;
    try {
      await fetch(`/api/admin/assignments/${asgId}/reset`, { method: 'POST' });
      alert('Assignment reset! Student can now retake the test.');
      fetchAdminData();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleClearPendingAssignments = async () => {
    if (!confirm('Clear all pending/uncompleted test assignments? Completed student submissions and graded work will remain safe.')) return;
    try {
      const res = await fetch('/api/admin/assignments/clear-pending', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to clear pending assignments');
      alert(data.message || 'Pending assignments cleared successfully.');
      fetchAdminData();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleClearAllAssignments = async () => {
    const input = prompt('⚠️ DANGER: This action will permanently delete ALL student completed work, graded essays, and submissions history.\n\nTo confirm this PERMANENT DELETION, type "DELETE" in the box below:');
    if (input !== 'DELETE') {
      if (input !== null) alert('Action cancelled. You must type DELETE to confirm.');
      return;
    }
    try {
      const res = await fetch('/api/admin/assignments/clear-all', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to clear assignments');
      alert('All candidate assignments cleared successfully!');
      fetchAdminData();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleReassignAll = async () => {
    try {
      const res = await fetch('/api/admin/reassign-default-tests', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to re-assign tests');
      alert(data.message || 'Mock tests successfully re-assigned to all candidates!');
      fetchAdminData();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleReseedSubmissions = async () => {
    try {
      const res = await fetch('/api/admin/reseed-demo-submissions', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to restore submissions');
      alert(data.message || 'Sample student submissions restored!');
      fetchAdminData();
    } catch (err) {
      alert(err.message);
    }
  };

  // HTML Mock Test Uploader
  const handleUploadHtmlTest = async () => {
    if (!testTitle.trim()) {
      alert('Please type a Title first (e.g. IELTS Academic Mock Test 10)');
      return;
    }
    if (!uploadedHtmlContent.trim()) {
      alert('Please select a valid HTML mock test file to upload');
      return;
    }

    setUploadingTest(true);
    try {
      const res = await fetch('/api/admin/upload-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: testTitle.trim(),
          htmlContent: uploadedHtmlContent
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to upload mock test');

      const fixes = [];
      if (data.mojibakeFixedCount > 0) fixes.push(`fixed ${data.mojibakeFixedCount} garbled-text spot${data.mojibakeFixedCount === 1 ? '' : 's'} (mojibake)`);
      if (data.gateRemoved) fixes.push('removed a leftover password/ID gate');
      const fixSummary = fixes.length > 0
        ? `Auto-fixes applied: ${fixes.join(', ')}.`
        : 'No issues found in this file.';

      alert(`HTML Mock Test uploaded and seeded successfully!\n\n${fixSummary}`);
      setTestTitle('');
      setUploadedHtmlContent('');
      setShowTestCreator(false);
      fetchAdminData();
    } catch (err) {
      alert(err.message);
    } finally {
      setUploadingTest(false);
    }
  };

  return (
    <div style={styles.dashboardLayout}>
      <header style={styles.header}>
        <div style={styles.headerTitle}>
          <h2>IELTS <span>Mock Portal</span></h2>
          <span style={styles.badge}>Administrator Suite</span>
        </div>
        <div style={styles.userInfo}>
          <div style={styles.userMeta}>
            <span style={styles.userName}>{user.name}</span>
            <span style={styles.userId}>System Controller</span>
          </div>
                    {onSwitchRole && (
            <button 
              onClick={onSwitchRole}
              className="btn btn-secondary"
              style={{ marginRight: '0.75rem', fontSize: '0.85rem', padding: '0.4rem 0.8rem' }}
              title="Switch to Teacher Dashboard"
            >
              🏫 Teacher View
            </button>
          )}
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
          <div style={styles.loadingContainer}>Loading platform metrics...</div>
        ) : (
          <div>
            {/* 1. Metrics Overview Dashboard */}
            <section style={styles.metricsRow}>
              <div className="card" style={styles.metricCard}>
                <span style={styles.metricNum}>{metrics.students}</span>
                <span style={styles.metricLabel}>Registered Students</span>
              </div>
              <div className="card" style={styles.metricCard}>
                <span style={styles.metricNum}>{metrics.tests}</span>
                <span style={styles.metricLabel}>Mock Tests Built</span>
              </div>
              <div className="card" style={{ ...styles.metricCard, borderLeft: '4px solid #f59e0b' }}>
                <span style={{ ...styles.metricNum, color: '#f59e0b' }}>{metrics.pendingGrades}</span>
                <span style={styles.metricLabel}>Essays Pending Review</span>
              </div>
              <div className="card" style={{ ...styles.metricCard, borderLeft: '4px solid #10b981' }}>
                <span style={{ ...styles.metricNum, color: '#10b981' }}>{metrics.completedGrades}</span>
                <span style={styles.metricLabel}>Graded Submissions</span>
              </div>
            </section>

            {/* 2. Admin Workspace Grid */}
            <div style={styles.workspaceGrid}>
              
              {/* LEFT COLUMN: REGISTRATION & ASSIGNMENT */}
              <div style={styles.leftCol}>
                
                {/* A0. Bulk Import */}
                <div className="card" style={{ marginBottom: '2rem' }}>
                  <div style={styles.flexHeader}>
                    <h3 style={styles.cardTitle}>📥 Bulk Import Students</h3>
                    <button
                      onClick={() => { setShowBulkImport(!showBulkImport); setBulkResults(null); }}
                      className="btn btn-primary"
                      style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}
                    >
                      {showBulkImport ? 'Close ▲' : 'Open ▼'}
                    </button>
                  </div>

                  {showBulkImport && (
                    <div style={{ marginTop: '1rem' }}>
                      <p style={{ fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.75rem', lineHeight: '1.5' }}>
                        Paste one student per line in the format: <strong>Full Name, Group Name</strong><br/>
                        IDs and passwords will be auto-generated.
                      </p>
                      <textarea
                        className="form-input"
                        rows={7}
                        placeholder={`Aria Thorne, Group A\nElara Vane, Group B\nMarcus Stone, Group A`}
                        value={bulkImportText}
                        onChange={(e) => setBulkImportText(e.target.value)}
                        style={{ fontFamily: 'monospace', fontSize: '0.85rem', resize: 'vertical' }}
                      />
                      <button
                        onClick={handleBulkImport}
                        disabled={bulkImporting}
                        className="btn btn-success"
                        style={{ width: '100%', justifyContent: 'center', marginTop: '0.75rem' }}
                      >
                        {bulkImporting ? 'Importing...' : '🚀 Import All Students'}
                      </button>

                      {bulkResults && (
                        <div style={{ marginTop: '1rem' }}>
                          <p style={{ fontSize: '0.8rem', color: '#10b981', fontWeight: '600', marginBottom: '0.5rem' }}>
                            ✅ Import Complete — {bulkResults.filter(r => r.status === 'created').length} created, {bulkResults.filter(r => r.status !== 'created').length} skipped
                          </p>
                          <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
                              <thead>
                                <tr style={{ borderBottom: '2px solid var(--glass-border)' }}>
                                  <th style={{ padding: '0.4rem', textAlign: 'left', color: 'var(--text-secondary)' }}>Name</th>
                                  <th style={{ padding: '0.4rem', textAlign: 'left', color: 'var(--text-secondary)' }}>ID</th>
                                  <th style={{ padding: '0.4rem', textAlign: 'left', color: 'var(--text-secondary)' }}>Password</th>
                                  <th style={{ padding: '0.4rem', textAlign: 'left', color: 'var(--text-secondary)' }}>Group</th>
                                  <th style={{ padding: '0.4rem', textAlign: 'left', color: 'var(--text-secondary)' }}>Status</th>
                                </tr>
                              </thead>
                              <tbody>
                                {bulkResults.map((r, i) => (
                                  <tr key={i} style={{ borderBottom: '1px solid var(--glass-border)', backgroundColor: r.status === 'created' ? 'rgba(16,185,129,0.04)' : 'rgba(244,63,94,0.04)' }}>
                                    <td style={{ padding: '0.4rem', color: 'var(--text-primary)' }}>{r.name}</td>
                                    <td style={{ padding: '0.4rem', fontFamily: 'monospace', color: '#6366f1' }}>{r.id}</td>
                                    <td style={{ padding: '0.4rem', fontFamily: 'monospace', color: '#10b981' }}>{r.password}</td>
                                    <td style={{ padding: '0.4rem', color: 'var(--text-secondary)' }}>{r.groupName || '—'}</td>
                                    <td style={{ padding: '0.4rem', color: r.status === 'created' ? '#10b981' : '#f43f5e', fontWeight: 'bold' }}>{r.status}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <button
                            onClick={() => {
                              const rows = bulkResults.map(r => `${r.name}\t${r.id}\t${r.password}\t${r.groupName}`).join('\n');
                              navigator.clipboard.writeText(`Name\tID\tPassword\tGroup\n${rows}`);
                              alert('Credentials copied to clipboard!');
                            }}
                            className="btn btn-secondary"
                            style={{ width: '100%', justifyContent: 'center', marginTop: '0.5rem', fontSize: '0.8rem' }}
                          >
                            📋 Copy All Credentials
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* A. Register New User */}
                <div className="card" style={{ marginBottom: '2rem' }}>
                  <h3 style={styles.cardTitle}>👤 Register New User</h3>
                  <form onSubmit={handleRegisterStudent} style={{ marginTop: '1rem' }}>
                    <div className="form-group">
                      <label className="form-label">Account Role</label>
                      <select 
                        className="form-input"
                        value={newUserRole}
                        onChange={(e) => {
                          const role = e.target.value;
                          setNewUserRole(role);
                          if (role === 'teacher') setNewStudentPass('teacher123');
                          else if (role === 'admin') setNewStudentPass('admin123');
                          else setNewStudentPass('student123');
                        }}
                      >
                        <option value="student">Student / Candidate</option>
                        <option value="teacher">Teacher / Staff</option>
                        <option value="admin">Administrator</option>
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="form-label">
                        {newUserRole === 'student' ? 'Student ID (Unique)' : 'Username / Login ID'}
                      </label>
                      <input 
                        type="text" 
                        className="form-input" 
                        placeholder={newUserRole === 'student' ? "e.g. UNI2026F" : "e.g. jsmith"}
                        value={newStudentId}
                        onChange={(e) => setNewStudentId(e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Full Name</label>
                      <input 
                        type="text" 
                        className="form-input" 
                        placeholder={newUserRole === 'student' ? "e.g. Marcus Aurelius" : "e.g. John Smith"}
                        value={newStudentName}
                        onChange={(e) => setNewStudentName(e.target.value)}
                      />
                    </div>
                    {newUserRole === 'student' && (
                      <div className="form-group">
                        <label className="form-label">Class Group (Optional)</label>
                        <input 
                          type="text" 
                          className="form-input" 
                          placeholder="e.g. Group A, Evening IELTS..." 
                          value={newStudentGroup}
                          onChange={(e) => setNewStudentGroup(e.target.value)}
                        />
                      </div>
                    )}
                    <div className="form-group">
                      <label className="form-label">Temporary Passcode</label>
                      <input 
                        type="text" 
                        className="form-input" 
                        value={newStudentPass}
                        onChange={(e) => setNewStudentPass(e.target.value)}
                      />
                    </div>
                    <button type="submit" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}>
                      Register User +
                    </button>
                  </form>
                </div>

                {/* B. Assign Test */}
                <div className="card">
                  <h3 style={styles.cardTitle}>🔗 Assign Mock Exams</h3>
                  <form onSubmit={handleAssignTest} style={{ marginTop: '1rem' }}>
                    <div className="form-group">
                      <label className="form-label">Select Tests to Assign (Categorized)</label>
                      <div style={styles.studentSelectBox}>
                        {tests.length === 0 ? (
                          <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No mock tests built yet.</p>
                        ) : (() => {
                          const fullMocks = tests.filter(t => !t.title.toLowerCase().includes('reading') && !t.title.toLowerCase().includes('listening'));
                          const readingMocks = tests.filter(t => t.title.toLowerCase().includes('reading'));
                          
                          const renderRow = (t) => {
                            const isSelected = selectedTestIds.includes(t.id);
                            return (
                              <div 
                                key={t.id} 
                                onClick={() => toggleTestSelection(t.id)}
                                style={{
                                  ...styles.selectStudentRow,
                                  backgroundColor: isSelected ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
                                  borderColor: isSelected ? '#6366f1' : 'transparent'
                                }}
                              >
                                <input 
                                  type="checkbox" 
                                  checked={isSelected}
                                  onChange={() => {}}
                                  style={{ pointerEvents: 'none' }}
                                />
                                <span>{t.title}</span>
                              </div>
                            );
                          };

                          return (
                            <div>
                              {fullMocks.length > 0 && (
                                <div style={{ marginBottom: '0.75rem' }}>
                                  <div style={{ fontSize: '0.75rem', fontWeight: '800', color: '#6366f1', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '0.3rem', paddingLeft: '0.2rem' }}>
                                    🏆 Full IELTS Mock Tests
                                  </div>
                                  {fullMocks.map(renderRow)}
                                </div>
                              )}

                              {readingMocks.length > 0 && (
                                <div>
                                  <div style={{ fontSize: '0.75rem', fontWeight: '800', color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '0.3rem', paddingLeft: '0.2rem' }}>
                                    📖 Reading Practice Tests
                                  </div>
                                  {readingMocks.map(renderRow)}
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    </div>

                    <div className="form-group">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                        <label className="form-label" style={{ margin: 0 }}>Select Candidates (Bulk Select)</label>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                          Selected: {selectedStudentIds.length} / {students.length}
                        </span>
                      </div>

                      {/* Quick Group & Select All Buttons */}
                      <div style={{ display: 'flex', gap: '0.35rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: '0.2rem 0.55rem', fontSize: '0.75rem', backgroundColor: '#6366f1', color: '#fff', borderColor: '#6366f1' }}
                          onClick={() => setSelectedStudentIds(students.map(s => s.id))}
                        >
                          Select ALL ({students.length})
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: '0.2rem 0.55rem', fontSize: '0.75rem' }}
                          onClick={() => setSelectedStudentIds(students.filter(s => s.id.startsWith('G1')).map(s => s.id))}
                        >
                          Group 1
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: '0.2rem 0.55rem', fontSize: '0.75rem' }}
                          onClick={() => setSelectedStudentIds(students.filter(s => s.id.startsWith('G2')).map(s => s.id))}
                        >
                          Group 2
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: '0.2rem 0.55rem', fontSize: '0.75rem' }}
                          onClick={() => setSelectedStudentIds(students.filter(s => s.id.startsWith('G3')).map(s => s.id))}
                        >
                          Group 3
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: '0.2rem 0.55rem', fontSize: '0.75rem' }}
                          onClick={() => setSelectedStudentIds(students.filter(s => s.id.startsWith('G4')).map(s => s.id))}
                        >
                          Group 4
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: '0.2rem 0.55rem', fontSize: '0.75rem', backgroundColor: '#f43f5e', color: '#fff', borderColor: '#f43f5e' }}
                          onClick={() => setSelectedStudentIds([])}
                        >
                          Clear
                        </button>
                      </div>

                      {/* Instant Search Bar for Assign Box */}
                      <input
                        type="text"
                        placeholder="🔍 Search candidate by name, ID (e.g. G1-03) or group..."
                        value={assignSearchTerm}
                        onChange={e => setAssignSearchTerm(e.target.value)}
                        style={{
                          width: '100%',
                          padding: '0.45rem 0.75rem',
                          borderRadius: '6px',
                          border: '1px solid var(--glass-border)',
                          backgroundColor: 'var(--bg-tertiary)',
                          color: 'var(--text-primary)',
                          fontSize: '0.82rem',
                          marginBottom: '0.5rem',
                          outline: 'none',
                          boxSizing: 'border-box'
                        }}
                      />

                      <div style={styles.studentSelectBox}>
                        {students.length === 0 ? (
                          <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No students registered.</p>
                        ) : (() => {
                          const filtered = students.filter(s => {
                            const term = assignSearchTerm.toLowerCase();
                            return s.name.toLowerCase().includes(term) ||
                                   s.id.toLowerCase().includes(term) ||
                                   (s.groupName && s.groupName.toLowerCase().includes(term));
                          });
                          if (filtered.length === 0) {
                            return <p style={{ color: '#94a3b8', fontSize: '0.85rem', padding: '0.5rem' }}>No candidates found matching "{assignSearchTerm}"</p>;
                          }
                          return filtered.map(s => {
                            const isSelected = selectedStudentIds.includes(s.id);
                            return (
                              <div 
                                key={s.id} 
                                onClick={() => toggleStudentSelection(s.id)}
                                style={{
                                  ...styles.selectStudentRow,
                                  backgroundColor: isSelected ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
                                  borderColor: isSelected ? '#6366f1' : 'transparent'
                                }}
                              >
                                <input 
                                  type="checkbox" 
                                  checked={isSelected}
                                  onChange={() => {}} // handled by row click
                                  style={{ pointerEvents: 'none' }}
                                />
                                <span>{s.name} ({s.id}){s.groupName ? ` [${s.groupName}]` : ''}</span>
                              </div>
                            );
                          });
                        })()}
                      </div>
                    </div>

                    <button type="submit" className="btn btn-success" style={{ width: '100%', justifyContent: 'center' }}>
                      Assign Selected Mock Test
                    </button>
                  </form>
                </div>

                {/* E. User Directory */}
                <div className="card" style={{ marginTop: '2rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                    <h3 style={{ ...styles.cardTitle, margin: 0 }}>👥 System Accounts & Staff</h3>
                    <span style={{ backgroundColor: 'var(--color-indigo)', color: '#fff', fontSize: '0.75rem', fontWeight: 'bold', padding: '0.2rem 0.5rem', borderRadius: '12px' }}>
                      Total: {allUsers.length}
                    </span>
                  </div>

                  {/* Directory Search & Filter Controls */}
                  <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                    <input
                      type="text"
                      placeholder="🔍 Search name, ID (G1-01)..."
                      value={userSearchTerm}
                      onChange={e => setUserSearchTerm(e.target.value)}
                      style={{
                        flex: 2,
                        minWidth: '160px',
                        padding: '0.5rem 0.75rem',
                        borderRadius: '6px',
                        border: '1px solid var(--glass-border)',
                        backgroundColor: 'var(--bg-tertiary)',
                        color: 'var(--text-primary)',
                        fontSize: '0.82rem',
                        outline: 'none'
                      }}
                    />
                    <select
                      value={userGroupFilter}
                      onChange={e => setUserGroupFilter(e.target.value)}
                      style={{
                        flex: 1,
                        minWidth: '110px',
                        padding: '0.5rem',
                        borderRadius: '6px',
                        border: '1px solid var(--glass-border)',
                        backgroundColor: 'var(--bg-tertiary)',
                        color: 'var(--text-primary)',
                        fontSize: '0.82rem',
                        outline: 'none',
                        cursor: 'pointer'
                      }}
                    >
                      <option value="all">📁 All Groups</option>
                      <option value="Group 1">Group 1</option>
                      <option value="Group 2">Group 2</option>
                      <option value="Group 3">Group 3</option>
                      <option value="Group 4">Group 4</option>
                      <option value="teacher">Staff / Teachers</option>
                    </select>
                  </div>

                  <div style={styles.assignmentsListScroll}>
                    {allUsers.length === 0 ? (
                      <p style={{ color: '#94a3b8', fontSize: '0.85rem', padding: '1rem 0' }}>No accounts found.</p>
                    ) : (() => {
                      const filteredUsers = allUsers.filter(u => {
                        const term = userSearchTerm.toLowerCase();
                        const matchesSearch = u.name.toLowerCase().includes(term) ||
                                              u.id.toLowerCase().includes(term);
                        
                        let matchesGroup = true;
                        if (userGroupFilter !== 'all') {
                          if (userGroupFilter === 'teacher') matchesGroup = u.role === 'teacher' || u.role === 'admin';
                          else matchesGroup = u.groupName === userGroupFilter;
                        }
                        return matchesSearch && matchesGroup;
                      });

                      if (filteredUsers.length === 0) {
                        return <p style={{ color: '#94a3b8', fontSize: '0.85rem', padding: '1rem 0', textAlign: 'center' }}>No accounts found matching your search.</p>;
                      }

                      return filteredUsers.map(u => (
                        <div key={u.id} style={styles.asgListItem}>
                          <div>
                            <strong>{u.name}</strong> <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>({u.id})</span>
                            {u.groupName && (
                              <span style={{ 
                                backgroundColor: 'var(--color-indigo)', 
                                color: '#ffffff', 
                                fontSize: '0.7rem', 
                                padding: '0.15rem 0.4rem', 
                                borderRadius: '4px', 
                                marginLeft: '0.5rem',
                                fontWeight: '600'
                              }}>
                                {u.groupName}
                              </span>
                            )}
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                              Role: <span style={{ textTransform: 'capitalize', fontWeight: 'bold' }}>{u.role}</span> | Passcode: <em>hidden for security &mdash; use Reset to set a new one</em>
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <button 
                              onClick={() => handleResetUserPassword(u.id, u.name)}
                              className="btn btn-secondary"
                              style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                            >
                              🔑 Reset
                            </button>
                            {u.id !== user.id && (
                              <button 
                                onClick={() => handleDeleteUser(u.id)}
                                className="btn btn-danger"
                                style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </div>
                      ));
                    })()}
                  </div>
                </div>

              </div>

              {/* RIGHT COLUMN: TESTS & ASSIGNMENTS DIRECTORY */}
              <div style={styles.rightCol}>
                
                {/* C. Test Creator Toggle & List */}
                <div className="card" style={{ marginBottom: '2rem' }}>
                  <div style={styles.flexHeader}>
                    <h3 style={styles.cardTitle}>📜 Test Directory</h3>
                    <button 
                      onClick={() => setShowTestCreator(!showTestCreator)} 
                      className="btn btn-primary"
                      style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}
                    >
                      {showTestCreator ? 'Close Uploader' : 'Upload HTML Mock Test +'}
                    </button>
                  </div>

                  {showTestCreator && (
                    <div style={styles.testCreatorBox}>
                      <h5>📤 HTML Mock Test Compiler</h5>
                      <p style={{ fontSize: '0.8rem', color: '#94a3b8', marginBottom: '1rem' }}>
                        Upload a raw HTML IELTS mock test. The system will automatically sanitize Telegram channels, personal tags, and inject the candidate auto-login and score syncing engines.
                      </p>
                      <div className="form-group">
                        <label className="form-label">Test Title</label>
                        <input 
                          type="text" 
                          className="form-input" 
                          placeholder="e.g. IELTS Academic Mock Test 10"
                          value={testTitle}
                          onChange={(e) => setTestTitle(e.target.value)}
                          disabled={uploadingTest}
                        />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Select HTML Test File</label>
                        <input 
                          type="file" 
                          accept=".html" 
                          className="form-input" 
                          disabled={uploadingTest}
                          onChange={(e) => {
                            const file = e.target.files[0];
                            if (file) {
                              const reader = new FileReader();
                              reader.onload = (evt) => {
                                setUploadedHtmlContent(evt.target.result);
                              };
                              reader.readAsText(file);
                            }
                          }}
                        />
                      </div>
                      <button 
                        onClick={handleUploadHtmlTest} 
                        className="btn btn-success" 
                        style={{ width: '100%', justifyContent: 'center', marginTop: '1rem' }}
                        disabled={uploadingTest}
                      >
                        {uploadingTest ? 'Sanitizing & Deploying...' : '🚀 Sanitize & Deploy Test'}
                      </button>
                    </div>
                  )}

                  <div style={{ marginTop: '1rem' }}>
                    {tests.length === 0 ? (
                      <p>No tests created yet.</p>
                    ) : (() => {
                      const fullMocks = tests.filter(t => !t.title.toLowerCase().includes('reading'));
                      const readingTests = tests.filter(t => t.title.toLowerCase().includes('reading'));

                      return (
                        <div>
                          {fullMocks.length > 0 && (
                            <div style={{ marginBottom: '1.25rem' }}>
                              <h6 style={{ color: '#6366f1', fontSize: '0.75rem', fontWeight: '800', textTransform: 'uppercase', marginBottom: '0.4rem' }}>🏆 Full IELTS Mock Tests ({fullMocks.length})</h6>
                              {fullMocks.map(t => (
                                <div key={t.id} style={styles.testListItem}>
                                  <span>📝 <strong>{t.title}</strong></span>
                                  <span style={styles.smallBadge}>ID: {t.id}</span>
                                </div>
                              ))}
                            </div>
                          )}

                          {readingTests.length > 0 && (
                            <div>
                              <h6 style={{ color: '#10b981', fontSize: '0.75rem', fontWeight: '800', textTransform: 'uppercase', marginBottom: '0.4rem' }}>📖 Reading Practice Tests ({readingTests.length})</h6>
                              {readingTests.map(t => (
                                <div key={t.id} style={styles.testListItem}>
                                  <span>📖 <strong>{t.title}</strong></span>
                                  <span style={{ ...styles.smallBadge, backgroundColor: 'rgba(16,185,129,0.15)', color: '#10b981' }}>ID: {t.id}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                </div>

                {/* D. Assignment Activity Logs */}
                <div className="card">
                  <div style={styles.flexHeader}>
                    <h3 style={styles.cardTitle}>📊 Live Candidate Assignments</h3>
                    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                      <button 
                        onClick={handleReassignAll} 
                        className="btn btn-success"
                        style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem' }}
                      >
                        🚀 Re-assign Tests
                      </button>
                      <button 
                        onClick={handleReseedSubmissions} 
                        className="btn btn-primary"
                        style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', backgroundColor: '#6366f1' }}
                        title="Restores sample completed student test submissions and essays"
                      >
                        ↺ Restore Sample Submissions
                      </button>
                      {assignments.length > 0 && (
                        <>
                          <button 
                            onClick={handleClearPendingAssignments} 
                            className="btn btn-secondary"
                            style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', backgroundColor: '#eab308', color: '#000', borderColor: '#eab308' }}
                            title="Clears pending assigned tests without touching student submissions"
                          >
                            🧹 Clear Pending Tests
                          </button>
                          <button 
                            onClick={handleClearAllAssignments} 
                            className="btn btn-danger"
                            style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem' }}
                            title="Purges all assignments AND student submissions history"
                          >
                            🗑️ Purge All Submissions
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Filters Row */}
                  <div style={{ display: 'flex', gap: '0.75rem', margin: '0.75rem 0', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Group:</span>
                      <select
                        value={filterGroup}
                        onChange={(e) => setFilterGroup(e.target.value)}
                        style={{ fontSize: '0.78rem', backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--glass-border)', borderRadius: '5px', padding: '0.25rem 0.4rem' }}
                      >
                        <option value="all">All Groups</option>
                        {[...new Set(students.map(s => s.groupName).filter(Boolean))].sort().map(g => (
                          <option key={g} value={g}>{g}</option>
                        ))}
                      </select>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Status:</span>
                      <select
                        value={filterStatus}
                        onChange={(e) => setFilterStatus(e.target.value)}
                        style={{ fontSize: '0.78rem', backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--glass-border)', borderRadius: '5px', padding: '0.25rem 0.4rem' }}
                      >
                        <option value="all">All Statuses</option>
                        <option value="assigned">Assigned</option>
                        <option value="started">Started</option>
                        <option value="completed">Completed</option>
                      </select>
                    </div>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', alignSelf: 'center', marginLeft: 'auto' }}>
                      {assignments.filter(a => {
                        const studentGroupName = students.find(s => s.id === a.student_id)?.groupName || '';
                        return (filterGroup === 'all' || studentGroupName === filterGroup) && (filterStatus === 'all' || a.status === filterStatus);
                      }).length} records
                    </span>
                  </div>

                  <div style={styles.assignmentsListScroll}>
                    {assignments.length === 0 ? (
                      <p style={{ color: '#94a3b8', fontSize: '0.85rem', padding: '1rem 0' }}>No tests assigned yet.</p>
                    ) : (
                      assignments
                        .filter(asg => {
                          const studentGroupName = students.find(s => s.id === asg.student_id)?.groupName || '';
                          return (
                            (filterGroup === 'all' || studentGroupName === filterGroup) &&
                            (filterStatus === 'all' || asg.status === filterStatus)
                          );
                        })
                        .map(asg => (
                          <div key={asg.id} style={{ ...styles.asgListItem, flexWrap: 'wrap', gap: '0.5rem' }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <strong>{asg.student_name}</strong> <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>({asg.student_id})</span>
                              {(() => {
                                const grp = students.find(s => s.id === asg.student_id)?.groupName;
                                return grp ? <span style={{ backgroundColor: 'rgba(99,102,241,0.15)', color: '#6366f1', fontSize: '0.7rem', padding: '0.1rem 0.4rem', borderRadius: '4px', marginLeft: '0.4rem', fontWeight: '600' }}>{grp}</span> : null;
                              })()}
                              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
                                {asg.test_title}
                              </div>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                              <span style={{
                                ...styles.asgBadge,
                                backgroundColor: 
                                  asg.status === 'completed' ? 'rgba(16, 185, 129, 0.15)' :
                                  asg.status === 'started' ? 'rgba(245, 158, 11, 0.15)' : 'rgba(99, 102, 241, 0.15)',
                                color: 
                                  asg.status === 'completed' ? '#10b981' :
                                  asg.status === 'started' ? '#f59e0b' : '#6366f1'
                              }}>
                                {asg.status.toUpperCase()}
                              </span>
                              <button
                                onClick={() => handleResetAssignment(asg.id, asg.student_name, asg.test_title)}
                                title="Reset — allow student to retake"
                                style={{ background: 'none', border: '1px solid var(--glass-border)', borderRadius: '4px', cursor: 'pointer', padding: '0.2rem 0.4rem', fontSize: '0.75rem', color: '#f59e0b' }}
                              >
                                ↺
                              </button>
                              <button
                                onClick={() => handleDeleteAssignment(asg.id)}
                                title="Delete assignment"
                                style={{ background: 'none', border: '1px solid var(--glass-border)', borderRadius: '4px', cursor: 'pointer', padding: '0.2rem 0.4rem', fontSize: '0.75rem', color: '#f43f5e' }}
                              >
                                🗑
                              </button>
                            </div>
                          </div>
                        ))
                    )}
                  </div>
                </div>

                {/* F. Speaking Module & AI Settings */}
                <div className="card" style={{ marginBottom: '2rem' }}>
                  <div style={styles.flexHeader}>
                    <h3 style={styles.cardTitle}>🎙️ Speaking Module & AI Settings</h3>
                    <button
                      onClick={() => setShowSpeakingPanel(!showSpeakingPanel)}
                      className="btn btn-secondary"
                      style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}
                    >
                      {showSpeakingPanel ? 'Hide Panel ▲' : 'Manage Speaking & AI ▼'}
                    </button>
                  </div>

                  {/* Quick AI Provider Status */}
                  <div style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span>Active Provider: <strong style={{ color: '#6366f1', textTransform: 'uppercase' }}>{aiSettings.provider || 'gemini'}</strong></span>
                    <span>Gemini Key: <strong style={{ color: aiSettings.gemini_api_key_set ? '#10b981' : '#f43f5e' }}>{aiSettings.gemini_api_key_set ? '✅ Set' : '❌ Not Set'}</strong></span>
                    <span>OpenAI Key: <strong style={{ color: aiSettings.openai_api_key_set ? '#10b981' : '#f43f5e' }}>{aiSettings.openai_api_key_set ? '✅ Set' : '❌ Not Set'}</strong></span>
                  </div>

                  {showSpeakingPanel && (
                    <div style={{ marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                      {/* AI Settings Form */}
                      <form onSubmit={handleSaveAiSettings} style={{ backgroundColor: 'var(--bg-tertiary)', borderRadius: '10px', padding: '1.25rem', border: '1px solid var(--glass-border)' }}>
                        <h4 style={{ color: 'var(--text-primary)', fontSize: '0.95rem', fontWeight: '700', marginBottom: '1rem' }}>🤖 AI Evaluation Provider & API Keys</h4>
                        <div className="form-group">
                          <label className="form-label">Active Provider</label>
                          <select className="form-input" value={newAiProvider} onChange={e => setNewAiProvider(e.target.value)}>
                            <option value="gemini">Google Gemini 2.0 Flash (Recommended)</option>
                            <option value="openai">OpenAI GPT-4o</option>
                          </select>
                        </div>
                        <div className="form-group">
                          <label className="form-label">Google Gemini API Key {aiSettings.gemini_api_key_set && '(Already configured — leave blank to keep)'}</label>
                          <input type="password" className="form-input" placeholder="AIzaSy..." value={newGeminiKey} onChange={e => setNewGeminiKey(e.target.value)} />
                        </div>
                        <div className="form-group">
                          <label className="form-label">OpenAI API Key {aiSettings.openai_api_key_set && '(Already configured — leave blank to keep)'}</label>
                          <input type="password" className="form-input" placeholder="sk-..." value={newOpenaiKey} onChange={e => setNewOpenaiKey(e.target.value)} />
                        </div>
                        <button type="submit" disabled={savingSettings} className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', fontSize: '0.85rem' }}>
                          {savingSettings ? 'Saving...' : 'Save AI Configuration ⚙️'}
                        </button>
                      </form>

                      {/* Create Prompt Form */}
                      <form onSubmit={handleCreateSpeakingPrompt} style={{ backgroundColor: 'var(--bg-tertiary)', borderRadius: '10px', padding: '1.25rem', border: '1px solid var(--glass-border)' }}>
                        <h4 style={{ color: 'var(--text-primary)', fontSize: '0.95rem', fontWeight: '700', marginBottom: '1rem' }}>📝 Add New Speaking Prompt</h4>
                        <div className="form-group">
                          <label className="form-label">Prompt Title</label>
                          <input type="text" className="form-input" placeholder="e.g. Speaking Test 1 — Travel & Hometown" value={spTitle} onChange={e => setSpTitle(e.target.value)} />
                        </div>
                        <div className="form-group">
                          <label className="form-label">Part 1 Questions (One question per line)</label>
                          <textarea rows={3} className="form-input" value={spPart1} onChange={e => setSpPart1(e.target.value)} />
                        </div>
                        <div className="form-group">
                          <label className="form-label">Part 2 Cue Card Topic</label>
                          <textarea rows={4} className="form-input" value={spPart2} onChange={e => setSpPart2(e.target.value)} />
                        </div>
                        <div className="form-group">
                          <label className="form-label">Part 3 Questions (One question per line)</label>
                          <textarea rows={3} className="form-input" value={spPart3} onChange={e => setSpPart3(e.target.value)} />
                        </div>
                        <button type="submit" disabled={savingPrompt} className="btn btn-success" style={{ width: '100%', justifyContent: 'center', fontSize: '0.85rem' }}>
                          {savingPrompt ? 'Creating...' : 'Save Speaking Prompt +'}
                        </button>
                      </form>

                      {/* Prompts List & Assign */}
                      <div style={{ backgroundColor: 'var(--bg-tertiary)', borderRadius: '10px', padding: '1.25rem', border: '1px solid var(--glass-border)' }}>
                        <h4 style={{ color: 'var(--text-primary)', fontSize: '0.95rem', fontWeight: '700', marginBottom: '1rem' }}>📋 Prompts & Assignment</h4>
                        {speakingPrompts.length === 0 ? (
                          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>No speaking prompts created yet.</p>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.25rem' }}>
                            {speakingPrompts.map(p => (
                              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.6rem 0.75rem', backgroundColor: 'var(--bg-secondary)', borderRadius: '6px', border: '1px solid var(--glass-border)' }}>
                                <span style={{ color: 'var(--text-primary)', fontSize: '0.85rem', fontWeight: '600' }}>{p.title}</span>
                                <button onClick={() => handleDeleteSpeakingPrompt(p.id)} className="btn btn-danger" style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}>Delete</button>
                              </div>
                            ))}
                          </div>
                        )}

                        {speakingPrompts.length > 0 && (
                          <form onSubmit={handleAssignSpeaking}>
                            <div className="form-group">
                              <label className="form-label">Select Prompt to Assign</label>
                              <select className="form-input" value={speakingAssignPrompt} onChange={e => setSpeakingAssignPrompt(e.target.value)}>
                                <option value="">-- Select Speaking Prompt --</option>
                                {speakingPrompts.map(p => (
                                  <option key={p.id} value={p.id}>{p.title}</option>
                                ))}
                              </select>
                            </div>
                            <div className="form-group">
                              <label className="form-label">Select Candidates</label>
                              <div style={styles.studentSelectBox}>
                                {students.map(s => {
                                  const isSel = speakingAssignStudents.includes(s.id);
                                  return (
                                    <div
                                      key={s.id}
                                      onClick={() => setSpeakingAssignStudents(prev => isSel ? prev.filter(id => id !== s.id) : [...prev, s.id])}
                                      style={{ ...styles.selectStudentRow, backgroundColor: isSel ? 'rgba(99,102,241,0.15)' : 'transparent', borderColor: isSel ? '#6366f1' : 'transparent' }}
                                    >
                                      <input type="checkbox" checked={isSel} onChange={() => {}} style={{ pointerEvents: 'none' }} />
                                      <span>{s.name} ({s.id}){s.groupName ? ` [${s.groupName}]` : ''}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                            <button type="submit" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', fontSize: '0.85rem' }}>
                              Assign Speaking Test 🎙️
                            </button>
                          </form>
                        )}
                      </div>
                    </div>
                  )}
                </div>

              </div>


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
    gap: '1rem'
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
  metricsRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: '1.5rem',
    marginBottom: '2.5rem',
  },
  metricCard: {
    padding: '1.25rem 1.5rem',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    backgroundColor: 'var(--bg-secondary)',
  },
  metricNum: {
    fontSize: '2rem',
    fontWeight: '800',
    color: '#6366f1',
    lineHeight: '1',
    marginBottom: '0.25rem',
  },
  metricLabel: {
    fontSize: '0.75rem',
    color: 'var(--text-secondary)',
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  workspaceGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1.1fr',
    gap: '2.5rem',
  },
  leftCol: {
    display: 'flex',
    flexDirection: 'column',
  },
  rightCol: {
    display: 'flex',
    flexDirection: 'column',
  },
  cardTitle: {
    fontSize: '1.15rem',
    fontWeight: '600',
    color: 'var(--text-primary)',
  },
  studentSelectBox: {
    maxHeight: '180px',
    overflowY: 'auto',
    backgroundColor: 'var(--bg-primary)',
    border: '1px solid var(--glass-border)',
    borderRadius: '6px',
    padding: '0.25rem',
    marginTop: '0.5rem',
  },
  selectStudentRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '0.5rem 0.75rem',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.9rem',
    border: '1px solid transparent',
    marginBottom: '0.25rem',
    userSelect: 'none',
  },
  flexHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  testCreatorBox: {
    backgroundColor: 'var(--bg-primary)',
    border: '1px solid var(--glass-border)',
    borderRadius: '8px',
    padding: '1.25rem',
    marginTop: '1rem'
  },
  testListItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.75rem 1rem',
    backgroundColor: 'var(--bg-primary)',
    border: '1px solid var(--glass-border)',
    borderRadius: '6px',
    marginBottom: '0.5rem',
  },
  smallBadge: {
    fontSize: '0.7rem',
    backgroundColor: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    padding: '0.15rem 0.4rem',
    borderRadius: '4px',
  },
  assignmentsListScroll: {
    maxHeight: '350px',
    overflowY: 'auto',
    marginTop: '1rem',
  },
  asgListItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.75rem 1rem',
    borderBottom: '1px solid var(--glass-border)',
  },
  asgBadge: {
    fontSize: '0.7rem',
    fontWeight: '700',
    padding: '0.25rem 0.5rem',
    borderRadius: '4px',
    letterSpacing: '0.5px',
  }
};
