import React, { Component, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('App ErrorBoundary caught error:', error, errorInfo);
  }

  handleReset = () => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch (e) {}
    window.location.href = window.location.origin;
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
          backgroundColor: '#0f172a',
          color: '#f8fafc',
          fontFamily: 'system-ui, sans-serif',
          textAlign: 'center'
        }}>
          <h2 style={{ fontSize: '1.8rem', color: '#ef4444', marginBottom: '1rem' }}>
            IELTS Platform Session Reset
          </h2>
          <p style={{ maxWidth: '520px', color: '#94a3b8', lineHeight: '1.6', marginBottom: '1.5rem' }}>
            Your browser session saved an outdated cache from a previous update. Click the button below to clear session cache and load the latest IELTS Platform version.
          </p>
          {this.state.error && (
            <div style={{
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              borderRadius: '6px',
              padding: '0.75rem 1rem',
              color: '#fca5a5',
              fontSize: '0.85rem',
              maxWidth: '550px',
              wordBreak: 'break-word',
              marginBottom: '1.5rem',
              fontFamily: 'monospace'
            }}>
              {String(this.state.error?.message || this.state.error)}
            </div>
          )}
          <button 
            onClick={this.handleReset}
            style={{
              backgroundColor: '#c8102e',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              padding: '0.8rem 2rem',
              fontSize: '1rem',
              fontWeight: 'bold',
              cursor: 'pointer'
            }}
          >
            Reset Session & Refresh
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
