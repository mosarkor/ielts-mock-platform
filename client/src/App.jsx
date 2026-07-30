import React, { useState } from 'react';
import LoginPortal from './views/LoginPortal';
import StudentDashboard from './views/StudentDashboard';
import StudentTestRunner from './views/StudentTestRunner';
import TeacherDashboard from './views/TeacherDashboard';
import AdminDashboard from './views/AdminDashboard';

export default function App() {
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem('user');
    return saved ? JSON.parse(saved) : null;
  });
  const [testingTestId, setTestingTestId] = useState(() => {
    const saved = localStorage.getItem('testingTestId');
    return saved ? parseInt(saved) : null;
  });
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');

  React.useEffect(() => {
    if (theme === 'light') {
      document.body.classList.add('light');
    } else {
      document.body.classList.remove('light');
    }
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  const handleLoginSuccess = (loggedInUser) => {
    setUser(loggedInUser);
    localStorage.setItem('user', JSON.stringify(loggedInUser));
    setTestingTestId(null);
    localStorage.removeItem('testingTestId');
  };

  const handleLogout = () => {
    setUser(null);
    localStorage.removeItem('user');
    setTestingTestId(null);
    localStorage.removeItem('testingTestId');
  };

  const handleStartTest = (testId) => {
    setTestingTestId(testId);
    localStorage.setItem('testingTestId', testId.toString());
  };

  const handleFinishedTest = () => {
    setTestingTestId(null);
    localStorage.removeItem('testingTestId');
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
    return (
      <StudentDashboard 
        user={user} 
        onLogout={handleLogout} 
        onStartTest={handleStartTest} 
        theme={theme}
        toggleTheme={toggleTheme}
      />
    );
  }

  if (user.role === 'teacher') {
    return <TeacherDashboard user={user} onLogout={handleLogout} theme={theme} toggleTheme={toggleTheme} />;
  }

  if (user.role === 'admin') {
    return <AdminDashboard user={user} onLogout={handleLogout} theme={theme} toggleTheme={toggleTheme} />;
  }

  return (
    <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-primary)' }}>
      <h3>Unknown User Role: {user.role}</h3>
      <button onClick={handleLogout} className="btn btn-danger">Reset Session</button>
    </div>
  );
}
