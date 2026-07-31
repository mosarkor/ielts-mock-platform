import React, { useState, useRef, useEffect } from 'react';

export default function SpeakingTest({ user, assignment, onFinished }) {
  const [step, setStep] = useState('intro'); // intro | part1 | part2 | part3 | submitting | results | error
  const [currentQ, setCurrentQ] = useState(0);
  const [recording, setRecording] = useState(false);
  const [prepTime, setPrepTime] = useState(60);
  const [prepRunning, setPrepRunning] = useState(false);

  const [transcripts, setTranscripts] = useState({ part1: '', part2: '', part3: '' });
  const [currentTyping, setCurrentTyping] = useState('');
  const [part1Answers, setPart1Answers] = useState([]);
  const [part3Answers, setPart3Answers] = useState([]);

  const [results, setResults] = useState(null);
  const [error, setError] = useState('');

  const recognitionRef = useRef(null);
  const prepTimerRef = useRef(null);

  const prompt = assignment;
  const part1Qs = (() => { try { return JSON.parse(prompt.part1_questions || '[]'); } catch { return []; } })();
  const part3Qs = (() => { try { return JSON.parse(prompt.part3_questions || '[]'); } catch { return []; } })();

  useEffect(() => {
    return () => {
      if (prepTimerRef.current) clearInterval(prepTimerRef.current);
      stopRecognition();
    };
  }, []);

  const startRecognition = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    const recognition = new SR();
    recognition.lang = 'en-US';
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (e) => {
      let final = '';
      for (let i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) final += e.results[i][0].transcript + ' ';
      }
      if (final.trim()) setCurrentTyping(prev => prev + ' ' + final.trim());
    };
    recognition.onerror = () => {};
    try { recognition.start(); } catch (e) {}
    recognitionRef.current = recognition;
  };

  const stopRecognition = () => {
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch (e) {}
      recognitionRef.current = null;
    }
  };

  const handleToggleRecording = () => {
    if (recording) {
      setRecording(false);
      stopRecognition();
    } else {
      setRecording(true);
      startRecognition();
    }
  };

  // Part 1 next
  const handlePart1Next = () => {
    if (recording) { setRecording(false); stopRecognition(); }
    const updated = [...part1Answers];
    updated[currentQ] = currentTyping || '[No answer]';
    setPart1Answers(updated);
    setCurrentTyping('');
    if (currentQ < part1Qs.length - 1) {
      setCurrentQ(currentQ + 1);
    } else {
      const combined = part1Qs.map((q, i) => `Q: ${q}\nA: ${updated[i] || '[No answer]'}`).join('\n\n');
      setTranscripts(prev => ({ ...prev, part1: combined }));
      setCurrentQ(0);
      setStep('part2');
      setPrepRunning(true);
      setPrepTime(60);
      prepTimerRef.current = setInterval(() => {
        setPrepTime(prev => {
          if (prev <= 1) { clearInterval(prepTimerRef.current); setPrepRunning(false); return 0; }
          return prev - 1;
        });
      }, 1000);
    }
  };

  // Part 2 next
  const handlePart2Next = () => {
    if (recording) { setRecording(false); stopRecognition(); }
    if (prepRunning) { clearInterval(prepTimerRef.current); setPrepRunning(false); }
    const full = currentTyping.trim();
    setTranscripts(prev => ({ ...prev, part2: (prev.part2 + ' ' + full).trim() }));
    setCurrentTyping('');
    setCurrentQ(0);
    setStep('part3');
  };

  // Part 3 next
  const handlePart3Next = () => {
    if (recording) { setRecording(false); stopRecognition(); }
    const updated = [...part3Answers];
    updated[currentQ] = currentTyping || '[No answer]';
    setPart3Answers(updated);
    setCurrentTyping('');
    if (currentQ < part3Qs.length - 1) {
      setCurrentQ(currentQ + 1);
    } else {
      const combined = part3Qs.map((q, i) => `Q: ${q}\nA: ${updated[i] || '[No answer]'}`).join('\n\n');
      const finalTranscripts = { ...transcripts, part3: combined };
      setTranscripts(finalTranscripts);
      doSubmit(finalTranscripts);
    }
  };

  const doSubmit = async (finalTranscripts) => {
    setStep('submitting');
    try {
      const res = await fetch('/api/speaking/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentId: user.id,
          promptId: prompt.prompt_id,
          assignmentId: assignment.id,
          part1Transcript: finalTranscripts.part1,
          part2Transcript: finalTranscripts.part2,
          part3Transcript: finalTranscripts.part3
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Submission failed');
      setResults(data.scores);
      setStep('results');
    } catch (err) {
      setError(err.message);
      setStep('error');
    }
  };

  const bandColor = (s) => s >= 7.5 ? '#10b981' : s >= 6.0 ? '#6366f1' : s >= 4.5 ? '#f59e0b' : '#f43f5e';

  const wrap = { minHeight: '100vh', backgroundColor: 'var(--bg-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem', fontFamily: 'Inter, sans-serif' };
  const card = { maxWidth: '720px', width: '100%', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--glass-border)', borderRadius: '16px', padding: '2.5rem', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' };
  const qBox = { backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--glass-border)', borderRadius: '10px', padding: '1.25rem 1.5rem', fontSize: '1.05rem', color: 'var(--text-primary)', fontWeight: '500', lineHeight: '1.6', marginBottom: '1.25rem' };
  const textareaStyle = (accent) => ({ width: '100%', backgroundColor: 'var(--bg-tertiary)', border: `1px solid ${recording ? accent : 'var(--glass-border)'}`, borderRadius: '8px', padding: '0.75rem', color: 'var(--text-primary)', fontSize: '0.9rem', resize: 'vertical', outline: 'none', boxSizing: 'border-box', transition: 'border-color 0.2s' });

  const RecordDot = ({ color }) => recording ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color, fontSize: '0.85rem', margin: '0.5rem 0' }}>
      <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: color, animation: 'spkPulse 1s infinite' }} />
      Recording... speak now
    </div>
  ) : null;

  // ── INTRO ──
  if (step === 'intro') return (
    <div style={wrap}>
      <style>{`@keyframes spkPulse{0%,100%{opacity:1}50%{opacity:0.3}} @keyframes spkBounce{0%,80%,100%{transform:scale(0)}40%{transform:scale(1)}}`}</style>
      <div style={card}>
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <span style={{ fontSize: '3rem' }}>🎙️</span>
          <h2 style={{ color: 'var(--text-primary)', fontWeight: '800', fontSize: '1.5rem', marginTop: '0.5rem' }}>IELTS Speaking Test</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}><strong>{prompt.title}</strong></p>
        </div>
        {[{ icon: '📋', l: 'Part 1 — Interview', d: 'General questions about yourself (4–5 min)' }, { icon: '🗒️', l: 'Part 2 — Long Turn', d: 'Speak on a cue card topic for 1–2 minutes' }, { icon: '💬', l: 'Part 3 — Discussion', d: 'Abstract follow-up questions (4–5 min)' }].map(p => (
          <div key={p.l} style={{ display: 'flex', gap: '1rem', alignItems: 'center', backgroundColor: 'var(--bg-tertiary)', borderRadius: '8px', padding: '0.75rem 1rem', border: '1px solid var(--glass-border)', marginBottom: '0.75rem' }}>
            <span style={{ fontSize: '1.5rem' }}>{p.icon}</span>
            <div><strong style={{ color: 'var(--text-primary)', fontSize: '0.9rem' }}>{p.l}</strong><p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', margin: 0 }}>{p.d}</p></div>
          </div>
        ))}
        <div style={{ backgroundColor: 'rgba(99,102,241,0.08)', border: '1px dashed rgba(99,102,241,0.3)', borderRadius: '8px', padding: '0.75rem 1rem', fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '1.25rem 0' }}>
          💡 <strong>Tip:</strong> Allow microphone access for auto-transcription, or just type your answers.
        </div>
        <button onClick={() => setStep('part1')} className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', fontSize: '1rem', padding: '0.85rem' }}>Begin Speaking Test →</button>
        <button onClick={onFinished} style={{ width: '100%', marginTop: '0.75rem', background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.85rem' }}>← Back to Dashboard</button>
      </div>
    </div>
  );

  // ── PART 1 ──
  if (step === 'part1') return (
    <div style={wrap}>
      <style>{`@keyframes spkPulse{0%,100%{opacity:1}50%{opacity:0.3}}`}</style>
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <div><span style={{ fontSize: '0.75rem', fontWeight: '700', textTransform: 'uppercase', color: '#6366f1', letterSpacing: '1px' }}>Part 1 — Interview</span><h2 style={{ color: 'var(--text-primary)', fontWeight: '800', fontSize: '1.2rem', margin: 0 }}>Question {currentQ + 1} of {part1Qs.length}</h2></div>
          <div style={{ display: 'flex', gap: '4px' }}>{part1Qs.map((_, i) => <div key={i} style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: i < currentQ ? '#10b981' : i === currentQ ? '#6366f1' : 'var(--bg-tertiary)', border: '1px solid var(--glass-border)' }} />)}</div>
        </div>
        <div style={qBox}>❓ {part1Qs[currentQ]}</div>
        <textarea rows={4} placeholder="Speak (auto-transcribed) or type your answer..." value={currentTyping} onChange={e => setCurrentTyping(e.target.value)} style={textareaStyle('#6366f1')} />
        <RecordDot color="#6366f1" />
        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
          <button onClick={handleToggleRecording} className={recording ? 'btn btn-danger' : 'btn btn-secondary'} style={{ flex: 1, justifyContent: 'center' }}>{recording ? '⏹ Stop' : '⏺ Record'}</button>
          <button onClick={handlePart1Next} className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }}>{currentQ < part1Qs.length - 1 ? 'Next →' : 'Finish Part 1 →'}</button>
        </div>
      </div>
    </div>
  );

  // ── PART 2 ──
  if (step === 'part2') return (
    <div style={wrap}>
      <style>{`@keyframes spkPulse{0%,100%{opacity:1}50%{opacity:0.3}}`}</style>
      <div style={card}>
        <span style={{ fontSize: '0.75rem', fontWeight: '700', textTransform: 'uppercase', color: '#10b981', letterSpacing: '1px' }}>Part 2 — Long Turn</span>
        <h2 style={{ color: 'var(--text-primary)', fontWeight: '800', fontSize: '1.2rem', marginBottom: '1rem' }}>Cue Card</h2>
        <div style={{ ...qBox, whiteSpace: 'pre-wrap', borderLeft: '4px solid #10b981' }}>{prompt.part2_cue_card}</div>
        {prepRunning && <div style={{ textAlign: 'center', padding: '0.75rem', backgroundColor: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: '8px', marginBottom: '1rem', fontSize: '0.85rem', color: '#f59e0b', fontWeight: '600' }}>⏱️ Preparation Time: {prepTime}s — Make notes, then press Record</div>}
        <textarea rows={5} placeholder="Your speech will be transcribed here, or type your response..." value={currentTyping} onChange={e => setCurrentTyping(e.target.value)} style={textareaStyle('#10b981')} />
        <RecordDot color="#10b981" />
        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
          <button onClick={handleToggleRecording} className={recording ? 'btn btn-danger' : 'btn btn-secondary'} style={{ flex: 1, justifyContent: 'center' }}>{recording ? '⏹ Stop' : '⏺ Start Speaking'}</button>
          <button onClick={handlePart2Next} className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }}>Continue to Part 3 →</button>
        </div>
      </div>
    </div>
  );

  // ── PART 3 ──
  if (step === 'part3') return (
    <div style={wrap}>
      <style>{`@keyframes spkPulse{0%,100%{opacity:1}50%{opacity:0.3}}`}</style>
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <div><span style={{ fontSize: '0.75rem', fontWeight: '700', textTransform: 'uppercase', color: '#f59e0b', letterSpacing: '1px' }}>Part 3 — Discussion</span><h2 style={{ color: 'var(--text-primary)', fontWeight: '800', fontSize: '1.2rem', margin: 0 }}>Question {currentQ + 1} of {part3Qs.length}</h2></div>
          <div style={{ display: 'flex', gap: '4px' }}>{part3Qs.map((_, i) => <div key={i} style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: i <= currentQ ? '#f59e0b' : 'var(--bg-tertiary)', border: '1px solid var(--glass-border)', opacity: i > currentQ ? 0.4 : 1 }} />)}</div>
        </div>
        <div style={{ ...qBox, borderLeft: '4px solid #f59e0b' }}>❓ {part3Qs[currentQ]}</div>
        <textarea rows={4} placeholder="Speak (auto-transcribed) or type your answer..." value={currentTyping} onChange={e => setCurrentTyping(e.target.value)} style={textareaStyle('#f59e0b')} />
        <RecordDot color="#f59e0b" />
        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
          <button onClick={handleToggleRecording} className={recording ? 'btn btn-danger' : 'btn btn-secondary'} style={{ flex: 1, justifyContent: 'center' }}>{recording ? '⏹ Stop' : '⏺ Record'}</button>
          <button onClick={handlePart3Next} className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }}>{currentQ < part3Qs.length - 1 ? 'Next →' : '✅ Submit Test'}</button>
        </div>
      </div>
    </div>
  );

  // ── SUBMITTING ──
  if (step === 'submitting') return (
    <div style={wrap}>
      <style>{`@keyframes spkBounce{0%,80%,100%{transform:scale(0)}40%{transform:scale(1)}}`}</style>
      <div style={{ ...card, textAlign: 'center' }}>
        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🤖</div>
        <h2 style={{ color: 'var(--text-primary)', fontWeight: '800', fontSize: '1.5rem' }}>AI Evaluation in Progress</h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem' }}>Your responses are being evaluated against official IELTS Band Descriptors. This takes 10–20 seconds...</p>
        <div style={{ display: 'flex', justifyContent: 'center', gap: '8px' }}>
          {[0, 1, 2].map(i => <div key={i} style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: '#6366f1', animation: `spkBounce 1.2s ${i * 0.2}s infinite` }} />)}
        </div>
      </div>
    </div>
  );

  // ── ERROR ──
  if (step === 'error') return (
    <div style={wrap}>
      <div style={{ ...card, textAlign: 'center' }}>
        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>⚠️</div>
        <h2 style={{ color: '#f43f5e', fontWeight: '800', fontSize: '1.5rem' }}>Evaluation Error</h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>{error}</p>
        <p style={{ fontSize: '0.85rem', color: '#94a3b8', marginBottom: '1.5rem' }}>Your responses were recorded. Ask your teacher to configure the AI API key in Admin Settings.</p>
        <button onClick={onFinished} className="btn btn-primary">← Back to Dashboard</button>
      </div>
    </div>
  );

  // ── RESULTS ──
  if (step === 'results' && results) return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>🎉</div>
          <h2 style={{ color: 'var(--text-primary)', fontWeight: '800', fontSize: '1.5rem' }}>Test Submitted!</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Your teacher will review and send the official results to your dashboard.</p>
        </div>
        <div style={{ backgroundColor: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: '12px', padding: '1.5rem', marginBottom: '1.5rem', textAlign: 'center' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: '700' }}>AI Estimated Overall Band</span>
          <div style={{ fontSize: '4rem', fontWeight: '900', color: bandColor(results.overall), lineHeight: 1.1 }}>{results.overall?.toFixed(1)}</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1.5rem' }}>
          {[['Fluency & Coherence', 'fluency'], ['Lexical Resource', 'lexical'], ['Grammatical Range', 'grammar'], ['Pronunciation', 'pronunciation']].map(([label, key]) => (
            <div key={key} style={{ backgroundColor: 'var(--bg-tertiary)', borderRadius: '8px', padding: '0.75rem 1rem', border: '1px solid var(--glass-border)' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.25rem' }}>{label}</span>
              <span style={{ fontSize: '1.5rem', fontWeight: '800', color: bandColor(results[key]) }}>{results[key]?.toFixed(1)}</span>
              {results.feedback?.[key] && <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '0.4rem 0 0', lineHeight: 1.4 }}>{results.feedback[key]}</p>}
            </div>
          ))}
        </div>
        {results.feedback?.overall && (
          <div style={{ backgroundColor: 'var(--bg-tertiary)', borderRadius: '8px', padding: '1rem', border: '1px solid var(--glass-border)', marginBottom: '1.5rem' }}>
            <h5 style={{ color: 'var(--text-primary)', fontWeight: '700', marginBottom: '0.5rem', fontSize: '0.9rem' }}>📝 Overall Assessment</h5>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', lineHeight: '1.5', margin: 0 }}>{results.feedback.overall}</p>
          </div>
        )}
        <button onClick={onFinished} className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}>← Return to Dashboard</button>
      </div>
    </div>
  );

  return null;
}
