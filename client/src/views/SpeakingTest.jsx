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
      let transcriptText = '';
      for (let i = 0; i < e.results.length; i++) {
        transcriptText += e.results[i][0].transcript + ' ';
      }
      setCurrentTyping(transcriptText.trim());
    };
    recognition.onerror = () => {};
    try { recognition.start(); } catch {}
    recognitionRef.current = recognition;
  };

  const stopRecognition = () => {
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch {}
      recognitionRef.current = null;
    }
  };

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const [part1AudioBlobs, setPart1AudioBlobs] = useState([]);
  const [part2AudioBlob, setPart2AudioBlob] = useState(null);
  const [part3AudioBlobs, setPart3AudioBlobs] = useState([]);

  const startMediaRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      mr.start(250);
      mediaRecorderRef.current = mr;
    } catch (e) {
      console.warn('Microphone stream error:', e);
    }
  };

  const stopMediaRecording = () => {
    return new Promise((resolve) => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.onstop = () => {
          const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          resolve(blob);
        };
        try { mediaRecorderRef.current.stop(); } catch { resolve(null); }
      } else {
        resolve(null);
      }
    });
  };

  const handleToggleRecording = async () => {
    if (recording) {
      setRecording(false);
      stopRecognition();
      const blob = await stopMediaRecording();
      if (blob && blob.size > 0) {
        if (step === 'part1') setPart1AudioBlobs(prev => [...prev, blob]);
        if (step === 'part2') setPart2AudioBlob(blob);
        if (step === 'part3') setPart3AudioBlobs(prev => [...prev, blob]);
      }
    } else {
      setRecording(true);
      startRecognition();
      startMediaRecording();
    }
  };

  const blobToBase64 = (blob) => new Promise((resolve) => {
    if (!blob || blob.size === 0) return resolve('');
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });

  const combineBlobs = (blobs) => {
    if (!blobs || blobs.length === 0) return null;
    return new Blob(blobs, { type: 'audio/webm' });
  };

  const doSubmit = async (finalTranscripts) => {
    setStep('submitting');
    try {
      const p1Blob = combineBlobs(part1AudioBlobs);
      const p2Blob = part2AudioBlob;
      const p3Blob = combineBlobs(part3AudioBlobs);

      const [p1Base64, p2Base64, p3Base64] = await Promise.all([
        blobToBase64(p1Blob),
        blobToBase64(p2Blob),
        blobToBase64(p3Blob)
      ]);

      const res = await fetch('/api/speaking/submit-audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentId: user.id,
          promptId: prompt.prompt_id,
          assignmentId: assignment.id,
          part1AudioBase64: p1Base64,
          part2AudioBase64: p2Base64,
          part3AudioBase64: p3Base64,
          part1Transcript: finalTranscripts.part1,
          part2Transcript: finalTranscripts.part2,
          part3Transcript: finalTranscripts.part3
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Submission failed');
      setStep('results');
    } catch (err) {
      setError(err.message);
      setStep('error');
    }
  };

  // Part 1 next
  const handlePart1Next = () => {
    const text = currentTyping.trim();
    if (!text) {
      if (!confirm('🎙️ No response was detected. Did you speak into the microphone? Click OK to proceed with no answer, or Cancel to record/type your response.')) {
        return;
      }
    }
    if (recording) { setRecording(false); stopRecognition(); }
    const updated = [...part1Answers];
    updated[currentQ] = text || '[No answer]';
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
    const text = currentTyping.trim();
    if (!text) {
      if (!confirm('🎙️ No response was detected for Cue Card Part 2. Did you speak into the microphone? Click OK to proceed anyway, or Cancel to record/type your answer.')) {
        return;
      }
    }
    if (recording) { setRecording(false); stopRecognition(); }
    if (prepRunning) { clearInterval(prepTimerRef.current); setPrepRunning(false); }
    setTranscripts(prev => ({ ...prev, part2: (prev.part2 + ' ' + text).trim() }));
    setCurrentTyping('');
    setCurrentQ(0);
    setStep('part3');
  };

  // Part 3 next
  const handlePart3Next = () => {
    const text = currentTyping.trim();
    if (!text) {
      if (!confirm('🎙️ No response was detected. Did you speak into the microphone? Click OK to proceed with no answer, or Cancel to record/type your response.')) {
        return;
      }
    }
    if (recording) { setRecording(false); stopRecognition(); }
    const updated = [...part3Answers];
    updated[currentQ] = text || '[No answer]';
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


  const wrap = { minHeight: '100vh', backgroundColor: 'var(--bg-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem', fontFamily: 'Inter, sans-serif' };
  const card = { maxWidth: '720px', width: '100%', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--glass-border)', borderRadius: '16px', padding: '2.5rem', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' };
  const qBox = { backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--glass-border)', borderRadius: '10px', padding: '1.25rem 1.5rem', fontSize: '1.05rem', color: 'var(--text-primary)', fontWeight: '500', lineHeight: '1.6', marginBottom: '1.25rem' };

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

        {/* Clean Voice Recorder Box */}
        <div style={{
          backgroundColor: 'var(--bg-tertiary)',
          border: `2px solid ${recording ? '#6366f1' : 'var(--glass-border)'}`,
          borderRadius: '12px',
          padding: '2rem 1.5rem',
          textAlign: 'center',
          marginBottom: '1.25rem',
          boxShadow: recording ? '0 0 25px rgba(99,102,241,0.25)' : 'none',
          transition: 'all 0.3s'
        }}>
          <div style={{ position: 'relative', display: 'inline-block', marginBottom: '1rem' }}>
            <div style={{
              width: '72px',
              height: '72px',
              borderRadius: '50%',
              backgroundColor: recording ? 'rgba(99,102,241,0.2)' : 'var(--bg-secondary)',
              border: `2px solid ${recording ? '#6366f1' : 'var(--glass-border)'}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto',
              fontSize: '2rem'
            }}>
              🎙️
            </div>
            {recording && (
              <span style={{
                position: 'absolute',
                top: '-2px',
                right: '-2px',
                width: '14px',
                height: '14px',
                borderRadius: '50%',
                backgroundColor: '#f43f5e',
                border: '2px solid var(--bg-tertiary)',
                animation: 'spkPulse 1s infinite'
              }} />
            )}
          </div>

          {recording ? (
            <div>
              <div style={{ color: '#f43f5e', fontWeight: '700', fontSize: '1.1rem', marginBottom: '0.25rem' }}>
                🔴 Recording Voice...
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>Speak your answer into the microphone</p>
            </div>
          ) : (
            <div>
              <div style={{ color: 'var(--text-primary)', fontWeight: '600', fontSize: '1.05rem', marginBottom: '0.25rem' }}>
                {currentTyping ? '✅ Answer Audio Captured' : 'Ready to Record'}
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
                {currentTyping ? 'Your response is saved. Click Next to proceed.' : 'Press "Record Answer" below to speak your response.'}
              </p>
            </div>
          )}
        </div>

        {/* Live Speech Transcript & Editable Box */}
        <div style={{ marginTop: '0.75rem', marginBottom: '1rem' }}>
          <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: '600', marginBottom: '0.3rem' }}>
            📝 Speech Transcript (Live Voice-to-Text):
          </label>
          <textarea
            rows={3}
            className="form-input"
            placeholder="Your spoken words will appear here live... (You can also type or edit your response directly)"
            value={currentTyping}
            onChange={(e) => setCurrentTyping(e.target.value)}
            style={{ fontFamily: 'sans-serif', fontSize: '0.9rem', width: '100%', resize: 'vertical' }}
          />
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
          <button onClick={handleToggleRecording} className={recording ? 'btn btn-danger' : 'btn btn-secondary'} style={{ flex: 1, justifyContent: 'center' }}>{recording ? '⏹ Stop Recording' : '⏺ Record Answer'}</button>
          <button onClick={handlePart1Next} className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }}>{currentQ < part1Qs.length - 1 ? 'Next Question →' : 'Finish Part 1 →'}</button>
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
        
        {/* Clean Voice Recorder Box */}
        <div style={{
          backgroundColor: 'var(--bg-tertiary)',
          border: `2px solid ${recording ? '#10b981' : 'var(--glass-border)'}`,
          borderRadius: '12px',
          padding: '2rem 1.5rem',
          textAlign: 'center',
          marginBottom: '1.25rem',
          boxShadow: recording ? '0 0 25px rgba(16,185,129,0.25)' : 'none',
          transition: 'all 0.3s'
        }}>
          <div style={{ position: 'relative', display: 'inline-block', marginBottom: '1rem' }}>
            <div style={{
              width: '72px',
              height: '72px',
              borderRadius: '50%',
              backgroundColor: recording ? 'rgba(16,185,129,0.2)' : 'var(--bg-secondary)',
              border: `2px solid ${recording ? '#10b981' : 'var(--glass-border)'}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto',
              fontSize: '2rem'
            }}>
              🎙️
            </div>
            {recording && (
              <span style={{
                position: 'absolute',
                top: '-2px',
                right: '-2px',
                width: '14px',
                height: '14px',
                borderRadius: '50%',
                backgroundColor: '#10b981',
                border: '2px solid var(--bg-tertiary)',
                animation: 'spkPulse 1s infinite'
              }} />
            )}
          </div>

          {recording ? (
            <div>
              <div style={{ color: '#10b981', fontWeight: '700', fontSize: '1.1rem', marginBottom: '0.25rem' }}>
                🟢 Recording Long Turn Speech...
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>Speak continuously on your cue card topic</p>
            </div>
          ) : (
            <div>
              <div style={{ color: 'var(--text-primary)', fontWeight: '600', fontSize: '1.05rem', marginBottom: '0.25rem' }}>
                {currentTyping ? '✅ Speech Recorded' : 'Ready for Long Turn'}
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
                {currentTyping ? 'Long turn audio recorded. Click Continue to proceed.' : 'Press "Start Speaking" below when ready.'}
              </p>
            </div>
          )}
        </div>

        {/* Live Speech Transcript & Editable Box */}
        <div style={{ marginTop: '0.75rem', marginBottom: '1rem' }}>
          <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: '600', marginBottom: '0.3rem' }}>
            📝 Speech Transcript (Live Voice-to-Text):
          </label>
          <textarea
            rows={3}
            className="form-input"
            placeholder="Your spoken words for cue card long turn will appear here... (You can also type or edit directly)"
            value={currentTyping}
            onChange={(e) => setCurrentTyping(e.target.value)}
            style={{ fontFamily: 'sans-serif', fontSize: '0.9rem', width: '100%', resize: 'vertical' }}
          />
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
          <button onClick={handleToggleRecording} className={recording ? 'btn btn-danger' : 'btn btn-secondary'} style={{ flex: 1, justifyContent: 'center' }}>{recording ? '⏹ Stop Recording' : '⏺ Start Speaking'}</button>
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
        
        {/* Clean Voice Recorder Box */}
        <div style={{
          backgroundColor: 'var(--bg-tertiary)',
          border: `2px solid ${recording ? '#f59e0b' : 'var(--glass-border)'}`,
          borderRadius: '12px',
          padding: '2rem 1.5rem',
          textAlign: 'center',
          marginBottom: '1.25rem',
          boxShadow: recording ? '0 0 25px rgba(245,158,11,0.25)' : 'none',
          transition: 'all 0.3s'
        }}>
          <div style={{ position: 'relative', display: 'inline-block', marginBottom: '1rem' }}>
            <div style={{
              width: '72px',
              height: '72px',
              borderRadius: '50%',
              backgroundColor: recording ? 'rgba(245,158,11,0.2)' : 'var(--bg-secondary)',
              border: `2px solid ${recording ? '#f59e0b' : 'var(--glass-border)'}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto',
              fontSize: '2rem'
            }}>
              🎙️
            </div>
            {recording && (
              <span style={{
                position: 'absolute',
                top: '-2px',
                right: '-2px',
                width: '14px',
                height: '14px',
                borderRadius: '50%',
                backgroundColor: '#f59e0b',
                border: '2px solid var(--bg-tertiary)',
                animation: 'spkPulse 1s infinite'
              }} />
            )}
          </div>

          {recording ? (
            <div>
              <div style={{ color: '#f59e0b', fontWeight: '700', fontSize: '1.1rem', marginBottom: '0.25rem' }}>
                🟡 Recording Voice...
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>Speak your answer clearly into the microphone</p>
            </div>
          ) : (
            <div>
              <div style={{ color: 'var(--text-primary)', fontWeight: '600', fontSize: '1.05rem', marginBottom: '0.25rem' }}>
                {currentTyping ? '✅ Response Recorded' : 'Ready to Record'}
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
                {currentTyping ? 'Your response is saved.' : 'Press "Record Answer" below to speak.'}
              </p>
            </div>
          )}
        </div>

        {/* Live Speech Transcript & Editable Box */}
        <div style={{ marginTop: '0.75rem', marginBottom: '1rem' }}>
          <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: '600', marginBottom: '0.3rem' }}>
            📝 Speech Transcript (Live Voice-to-Text):
          </label>
          <textarea
            rows={3}
            className="form-input"
            placeholder="Your spoken words will appear here live... (You can also type or edit your response directly)"
            value={currentTyping}
            onChange={(e) => setCurrentTyping(e.target.value)}
            style={{ fontFamily: 'sans-serif', fontSize: '0.9rem', width: '100%', resize: 'vertical' }}
          />
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
          <button onClick={handleToggleRecording} className={recording ? 'btn btn-danger' : 'btn btn-secondary'} style={{ flex: 1, justifyContent: 'center' }}>{recording ? '⏹ Stop Recording' : '⏺ Record Answer'}</button>
          <button onClick={handlePart3Next} className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }}>{currentQ < part3Qs.length - 1 ? 'Next Question →' : '✅ Submit Test'}</button>
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

  // ── SUBMITTED CONFIRMATION ──
  if (step === 'results') return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ textAlign: 'center', padding: '1.5rem 0' }}>
          <div style={{ fontSize: '3.5rem', marginBottom: '1rem' }}>🎉</div>
          <h2 style={{ color: 'var(--text-primary)', fontWeight: '800', fontSize: '1.6rem', marginBottom: '0.5rem' }}>Speaking Test Submitted!</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', maxWidth: '480px', margin: '0 auto 1.5rem', lineHeight: 1.5 }}>
            Your speaking responses have been successfully submitted. Your teacher will review your test and release the official results to your dashboard.
          </p>
          <div style={{ backgroundColor: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: '10px', padding: '1rem 1.25rem', marginBottom: '2rem', fontSize: '0.85rem', color: '#10b981', fontWeight: '600', display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
            <span>✅ Status: Submitted to Teacher Dashboard</span>
          </div>
          <button onClick={onFinished} className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '0.85rem' }}>
            ← Return to Student Dashboard
          </button>
        </div>
      </div>
    </div>
  );

  return null;
}
