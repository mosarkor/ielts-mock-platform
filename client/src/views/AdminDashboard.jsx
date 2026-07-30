import React, { useState, useEffect } from 'react';
import ChangePasswordModal from '../components/ChangePasswordModal';

export default function AdminDashboard({ user, onLogout, theme, toggleTheme }) {
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

      alert('HTML Mock Test uploaded, sanitized, and seeded successfully!');
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
                      <label className="form-label">Select Mock Tests (Bulk Select)</label>
                      <div style={styles.studentSelectBox}>
                        {tests.length === 0 ? (
                          <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No mock tests built yet.</p>
                        ) : (
                          tests.map(t => {
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
                                  onChange={() => {}} // handled by row click
                                  style={{ pointerEvents: 'none' }}
                                />
                                <span>{t.title}</span>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>

                    <div className="form-group">
                      <label className="form-label">Select Candidates (Bulk Select)</label>
                      <div style={styles.studentSelectBox}>
                        {students.length === 0 ? (
                          <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No students registered.</p>
                        ) : (
                          students.map(s => {
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
                          })
                        )}
                      </div>
                    </div>

                    <button type="submit" className="btn btn-success" style={{ width: '100%', justifyContent: 'center' }}>
                      Assign Selected Mock Test
                    </button>
                  </form>
                </div>

                {/* E. User Directory */}
                <div className="card" style={{ marginTop: '2rem' }}>
                  <h3 style={styles.cardTitle}>👥 System Accounts & Staff</h3>
                  <div style={styles.assignmentsListScroll}>
                    {allUsers.length === 0 ? (
                      <p style={{ color: '#94a3b8', fontSize: '0.85rem', padding: '1rem 0' }}>No accounts found.</p>
                    ) : (
                      allUsers.map(u => (
                        <div key={u.id} style={styles.asgListItem}>
                          <div>
                            <strong>{u.name}</strong> ({u.id})
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
                              Role: <span style={{ textTransform: 'capitalize', fontWeight: 'bold' }}>{u.role}</span> | Passcode: <strong style={{ color: 'var(--color-indigo)' }}>{u.passcode}</strong>
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
                      ))
                    )}
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
                    ) : (
                      tests.map(t => (
                        <div key={t.id} style={styles.testListItem}>
                          <span>📄 <strong>{t.title}</strong></span>
                          <span style={styles.smallBadge}>ID: {t.id}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* D. Assignment Activity Logs */}
                <div className="card">
                  <h3 style={styles.cardTitle}>📊 Live Candidate Assignments</h3>

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
    marginTop: '1rem',
    h5: {
      fontWeight: '600',
      marginBottom: '0.25rem',
    }
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
