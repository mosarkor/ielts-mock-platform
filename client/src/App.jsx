import React, { useState, useEffect } from 'react';
import LoginPortal from './views/LoginPortal';
import StudentDashboard from './views/StudentDashboard';
import StudentTestRunner from './views/StudentTestRunner';
import SpeakingTest from './views/SpeakingTest';
import TeacherDashboard from './views/TeacherDashboard';
import AdminDashboard from './views/AdminDashboard';

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The app remains usable when storage is blocked or full.
  }
}

function removeStorage(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore unavailable browser storage.
  }
}

// Every API call now needs a real session cookie, not just a locally-stored
// profile -- so a browser left open from before this shipped (or a cookie
// that's expired/been revoked) starts getting 401s from every endpoint it
// touches. Patched once, globally, rather than threading a check through the
// ~50 call sites that use fetch() directly: any 401, while the app still
// believes someone is logged in, means that belief is stale. Drop it and
// reload straight to the login screen instead of leaving broken dashboards
// with silent, confusing failures on screen.
if (typeof window !== 'undefined' && !window.__ieltsAuthFetchPatched) {
  window.__ieltsAuthFetchPatched = true;
  const rawFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await rawFetch(...args);
    if (response.status === 401 && localStorage.getItem('user')) {
      localStorage.removeItem('user');
      localStorage.removeItem('testingTestId');
      window.location.href = '/';
    }
    return response;
  };
}

export default function App() {
  const [user, setUser] = useState(() => {
    const saved = readStorage('user');
    if (!saved) return null;
    try {
      const parsed = JSON.parse(saved);
      return parsed?.id && parsed?.role ? parsed : null;
    } catch {
      removeStorage('user');
      return null;
    }
  });
  // The stored session keeps whatever name and role the account had at login.
  // Renaming an account therefore stayed invisible to anyone already signed in
  // -- the old name kept showing until they happened to log out. Re-read the
  // account on load so what is on screen matches the database.
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    fetch('/api/auth/whoami/' + encodeURIComponent(user.id))
      .then(res => (res.ok ? res.json() : null))
      .then(fresh => {
        if (cancelled || !fresh?.id) return;
        if (fresh.name === user.name && fresh.role === user.role) return;
        const updated = { ...user, name: fresh.name, role: fresh.role };
        setUser(updated);
        writeStorage('user', JSON.stringify(updated));
      })
      .catch(() => { /* offline or mid-deploy: keep showing the stored details */ });
    return () => { cancelled = true; };
    // Only on sign-in / reload -- not every time the object identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const [testingTestId, setTestingTestId] = useState(() => {
    const saved = Number.parseInt(readStorage('testingTestId'), 10);
    return Number.isInteger(saved) && saved > 0 ? saved : null;
  });
  const [speakingAssignment, setSpeakingAssignment] = useState(null);
  const [theme, setTheme] = useState(() => readStorage('theme') || 'dark');

  React.useEffect(() => {
    if (theme === 'light') {
      document.body.classList.add('light');
    } else {
      document.body.classList.remove('light');
    }
    writeStorage('theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  const handleLoginSuccess = (loggedInUser) => {
    setUser(loggedInUser);
    writeStorage('user', JSON.stringify(loggedInUser));
    setTestingTestId(null);
    removeStorage('testingTestId');
  };

  const [activeRole, setActiveRole] = useState(null);

  React.useEffect(() => {
    if (user?.role && !activeRole) {
      setActiveRole(user.role);
    }
  }, [user]);

  const handleSwitchRole = (newRole) => {
    setActiveRole(newRole);
  };

  const handleLogout = () => {
    fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
    setActiveRole(null);
    removeStorage('user');
    setTestingTestId(null);
    removeStorage('testingTestId');
  };

  const handleStartTest = (testId) => {
    setTestingTestId(testId);
    writeStorage('testingTestId', testId.toString());
  };

  const handleFinishedTest = () => {
    setTestingTestId(null);
    removeStorage('testingTestId');
  };

  const handleStartSpeaking = (assignment) => {
    setSpeakingAssignment(assignment);
  };

  const handleFinishedSpeaking = () => {
    setSpeakingAssignment(null);
  };

  // Switch View based on user authentication state and role
  if (!user) {
    return <LoginPortal onLoginSuccess={handleLoginSuccess} theme={theme} toggleTheme={toggleTheme} />;
  }

  if (user.role === 'student') {
    if (testingTestId) {
      return (
        <StudentTestRunner 
          testId={testingTestId} 
          user={user} 
          onFinished={handleFinishedTest} 
        />
      );
    }
    if (speakingAssignment) {
      return (
        <SpeakingTest
          user={user}
          assignment={speakingAssignment}
          onFinished={handleFinishedSpeaking}
        />
      );
    }
    return (
      <StudentDashboard 
        user={user} 
        onLogout={handleLogout} 
        onStartTest={handleStartTest}
        onStartSpeaking={handleStartSpeaking}
        theme={theme}
        toggleTheme={toggleTheme}
      />
    );
  }

  if (user.role === 'teacher' || user.role === 'admin') {
    const currentViewRole = activeRole || user.role;
    if (currentViewRole === 'admin') {
      return (
        <AdminDashboard 
          user={user} 
          onLogout={handleLogout} 
          onSwitchRole={() => handleSwitchRole('teacher')}
          theme={theme} 
          toggleTheme={toggleTheme} 
        />
      );
    }
    return (
      <TeacherDashboard 
        user={user} 
        onLogout={handleLogout} 
        onSwitchRole={() => handleSwitchRole('admin')}
        theme={theme} 
        toggleTheme={toggleTheme} 
      />
    );
  }

  return (
    <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-primary)' }}>
      <h3>Unknown User Role: {user.role}</h3>
      <button onClick={handleLogout} className="btn btn-danger">Reset Session</button>
    </div>
  );
}
