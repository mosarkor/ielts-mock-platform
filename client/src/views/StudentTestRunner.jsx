import React, { useState, useEffect, useRef, useCallback } from 'react';

export default function StudentTestRunner({ testId, user, onFinished }) {
  const [test, setTest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Active module: 'listening' | 'reading' | 'writing'
  const [activeModule, setActiveModule] = useState('listening');
  const [fontSize, setFontSize] = useState('md'); // 'sm' | 'md' | 'lg' | 'xl'
  const [showTimer, setShowTimer] = useState(true);
  const [timeLeft, setTimeLeft] = useState(2400); // 40 minutes -- native tests only
  // Hybrid tests give Reading and Writing their own real 60-minute clocks (matching
  // the actual exam), rather than one shared clock split across both.
  const [hybridTimers, setHybridTimers] = useState({ reading: 3600, writing: 3600 });
  // Tracks which iframe modules have ever been the active tab. A module's iframe
  // only mounts once the student actually visits it (see the mount conditions
  // below) -- these standalone templates start their OWN internal 60-minute clock
  // the instant they load, using wall-clock time, with anti-cheat logic that
  // deliberately keeps it running even while backgrounded/hidden (so a student
  // can't "pause" the exam by switching browser tabs). Mounting every module's
  // iframe immediately at exam start -- which earlier preserved audio/progress
  // across tab switches -- meant Reading's internal clock silently started
  // counting down from the moment the exam began, not from when the student
  // actually got to it, quietly eating into their real reading time. Mounting
  // lazily on first visit (and never unmounting after that, so state still
  // survives later switches) fixes that without losing the original behavior.
  const [visitedModules, setVisitedModules] = useState({ listening: false, reading: false });

  // Student Answers State
  const [listeningAnswers, setListeningAnswers] = useState({});
  const [readingAnswers, setReadingAnswers] = useState({});
  const [writingAnswers, setWritingAnswers] = useState({ task1: '', task2: '' });

  // Results harvested from iframe-based modules (postMessage bridge), keyed by module
  const [moduleResults, setModuleResults] = useState({ listening: null, reading: null });

  // Navigation and Flags
  const [activeQuestionId, setActiveQuestionId] = useState(null);
  const [flaggedQuestions, setFlaggedQuestions] = useState({});
  const [activeWritingTask, setActiveWritingTask] = useState('task1'); // 'task1' | 'task2'

  // Modal State
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Anti-Cheat Proctoring States
  const [isExamStarted, setIsExamStarted] = useState(false);
  const [violations, setViolations] = useState(0);
  const [isLockoutActive, setIsLockoutActive] = useState(false);
  const [lockoutReason] = useState('');
  const [examTerminated] = useState(false);

  const audioRef = useRef(null);
  const timerIntervalRef = useRef(null);
  const listeningIframeRef = useRef(null);
  const readingIframeRef = useRef(null);
  const submissionInFlightRef = useRef(false);
  const completionCheckRef = useRef(false);
  const latestSubmissionRef = useRef(null);
  // Mirrors what each iframe module has reported. Submitting has to read the
  // freshly harvested values synchronously -- React state set from the module's
  // postMessage is not visible inside the submit call that triggered it.
  const harvestedRef = useRef({ listening: null, reading: null });

  // A module can independently be native (JSON questions) or a standalone iframe.
  // Computed here (not just in the render body) so effects can use it too.
  const listeningIsIframe = test?.listening_data?.isIframe === true;
  const readingIsIframe = test?.reading_data?.isIframe === true;
  const hasListeningContent = listeningIsIframe || test?.listening_data?.sections?.length > 0;
  const hasReadingContent = readingIsIframe || test?.reading_data?.passages?.length > 0;
  const hasTask1 = !!test?.writing_data?.task1?.prompt;
  const hasTask2 = !!test?.writing_data?.task2?.prompt;
  const hasWritingContent = hasTask1 || hasTask2;

  // Real IELTS allots 20 minutes to Task 1 and 40 to Task 2. A test that sets
  // only one of them gets only that task's time, rather than the full hour --
  // otherwise a Task-2-only paper hands the candidate 60 minutes for a 40-minute
  // essay and stops being useful timed practice.
  const writingSeconds = (hasTask1 ? 1200 : 0) + (hasTask2 ? 2400 : 0) || 3600;

  // Legacy standalone full-mock uploads (pre-dating the harvest bridge) are a single
  // iframe that submits itself and owns the whole screen, with no platform chrome.
  const isLegacyFullScreen = listeningIsIframe
    && test?.listening_data?.bridgeType !== 'harvest'
    && !hasReadingContent
    && !hasWritingContent;

  // A hybrid test mixes iframe modules with the platform's own chrome/timer (as
  // opposed to a legacy full-screen test, or a fully native test with no iframes).
  const isHybridWithIframeModules = !isLegacyFullScreen && (listeningIsIframe || readingIsIframe);

  const activeModuleIsIframe = (activeModule === 'listening' && listeningIsIframe)
    || (activeModule === 'reading' && readingIsIframe);

  // Sequential-locked tests (opt-in per test) mirror the real computer-delivered
  // exam: Listening, then Reading, then Writing, one-way -- once a student moves
  // on, the module they left is gone for good, not just hidden. Everything else
  // stays on the platform's normal free tab-switching.
  const sequentialLock = test?.sequentialLock === true;
  const moduleOrder = [
    hasListeningContent && 'listening',
    hasReadingContent && 'reading',
    hasWritingContent && 'writing'
  ].filter(Boolean);
  const currentStageIndex = moduleOrder.indexOf(activeModule);

  // What the header clock shows: the active module's own clock in hybrid mode (none
  // during Listening, which is audio-paced), or the single shared clock for native
  // tests. Derived directly from state rather than tracked separately, so it can
  // never go stale switching between modules with different remaining time.
  const displayTime = isHybridWithIframeModules
    ? (activeModule === 'reading' || activeModule === 'writing' ? hybridTimers[activeModule] : null)
    : timeLeft;
  const isTimerWarning = displayTime !== null && displayTime <= 300;

  // Anti-Cheat System (Disabled strict kickout to prevent false-positive auto-submissions)
  useEffect(() => {
    if (!isExamStarted || examTerminated) return;

    // Sync violations to sessionStorage for telemetry if needed
    sessionStorage.setItem('violations_' + testId, violations.toString());

    // Auto-termination disabled so students are NEVER kicked out mid-test
    /*
    if (violations >= 3) {
      setExamTerminated(true);
      setIsLockoutActive(false);
      ...
    }
    */

    const handleVisibilityChange = () => {
      // Soft tab tracking without auto-submitting or locking out
      if (document.hidden) {
        setViolations(prev => {
          const next = prev + 1;
          sessionStorage.setItem('violations_' + testId, next.toString());
          return next;
        });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isExamStarted, violations, examTerminated, testId]);

  const startExamAndEnterFullscreen = () => {
    setIsExamStarted(true);
    setViolations(0);
    setIsLockoutActive(false);
    
    const docEl = document.documentElement;
    if (docEl.requestFullscreen) {
      docEl.requestFullscreen().catch(() => {});
    } else if (docEl.mozRequestFullScreen) {
      docEl.mozRequestFullScreen().catch(() => {});
    } else if (docEl.webkitRequestFullscreen) {
      docEl.webkitRequestFullscreen().catch(() => {});
    } else if (docEl.msRequestFullscreen) {
      docEl.msRequestFullscreen().catch(() => {});
    }
  };

  const resumeFullscreen = () => {
    const docEl = document.documentElement;
    if (docEl.requestFullscreen) {
      docEl.requestFullscreen().then(() => {
        setIsLockoutActive(false);
      }).catch(() => {});
    } else {
      setIsLockoutActive(false);
    }
  };

  // Fetch test details and listen to iframe submit/module-complete events
  useEffect(() => {
    const handleIframeMessage = async (event) => {
      if (event.origin !== window.location.origin || String(event.data?.testId) !== String(testId)) {
        return;
      }

      // Legacy standalone full-mock templates: the iframe submits itself to the
      // server and just tells the parent it's done, so the parent confirms and exits.
      if (event.data?.type === 'IELTS_TEST_SUBMITTED') {
        if (event.source !== listeningIframeRef.current?.contentWindow || completionCheckRef.current) return;

        completionCheckRef.current = true;
        try {
          for (const delay of [0, 800, 1600]) {
            if (delay) await new Promise(resolve => setTimeout(resolve, delay));
            const response = await fetch(`/api/student/submission-status/${encodeURIComponent(user.id)}/${testId}`, {
              cache: 'no-store'
            });
            if (!response.ok) continue;
            const status = await response.json();
            if (status.submitted) {
              onFinished();
              return;
            }
          }
          alert('Your submission has not been confirmed yet. Your exam will stay open so you can retry safely.');
        } catch (error) {
          console.error('Could not confirm iframe submission:', error);
          alert('The platform could not confirm your submission. Check your connection and try again.');
        } finally {
          completionCheckRef.current = false;
        }
        return;
      }

      // Newer "prediction" template modules: the iframe never submits itself, it just
      // reports its harvested answers/score back so the parent can hold onto them until
      // the student clicks the platform's own shared Submit Test button.
      if (event.data?.type === 'IELTS_MODULE_COMPLETE') {
        const isFromListening = event.source === listeningIframeRef.current?.contentWindow;
        const isFromReading = event.source === readingIframeRef.current?.contentWindow;
        if (!isFromListening && !isFromReading) return;

        const moduleType = isFromListening ? 'listening' : 'reading';
        const answers = event.data.answers && typeof event.data.answers === 'object' ? event.data.answers : {};
        const detail = event.data.detail && typeof event.data.detail === 'object' ? event.data.detail : {};
        const band = Number(event.data.band) || 0;
        const correctCount = Number(event.data.correctCount) || 0;

        harvestedRef.current[moduleType] = { answers, detail, correctCount, band };
        setModuleResults(prev => ({ ...prev, [moduleType]: { answers, detail, correctCount, band } }));
        if (moduleType === 'listening') setListeningAnswers(answers);
        else setReadingAnswers(answers);

        // Some templates ship their own essay box inside the module iframe. That
        // duplicate is hidden now, but a student who typed into it before would
        // otherwise lose the essay entirely -- it never reaches the teacher.
        // Adopt it ONLY when this student's own Task 2 box is still empty, so a
        // stale iframe value can never overwrite what they actually wrote here.
        const iframeEssay = typeof event.data.essay === 'string' ? event.data.essay.trim() : '';
        if (iframeEssay) {
          setWritingAnswers(prev => (prev.task2 && prev.task2.trim() ? prev : { ...prev, task2: iframeEssay }));
        }
      }
    };
    window.addEventListener('message', handleIframeMessage);

    return () => {
      window.removeEventListener('message', handleIframeMessage);
    };
  }, [testId, user.id, onFinished]);

  const fetchTestDetails = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/student/test/${testId}`);
      if (!res.ok) throw new Error('Failed to load mock test content');
      const data = await res.json();
      setTest(data);

      // Restore saved progress from localStorage if present
      try {
        const saveKey = `ielts_native_progress_${user?.id}_${testId}`;
        const saved = localStorage.getItem(saveKey);
        if (saved) {
          const p = JSON.parse(saved);
          if (p.listeningAnswers) setListeningAnswers(p.listeningAnswers);
          if (p.readingAnswers) setReadingAnswers(p.readingAnswers);
          if (p.writingAnswers) setWritingAnswers(p.writingAnswers);
          if (p.timeLeft && p.timeLeft > 0) setTimeLeft(p.timeLeft);
        }
      } catch {}

      // Initialize active question id
      if (data.listening_data?.sections?.[0]?.questions?.[0]) {
        setActiveQuestionId(data.listening_data.sections[0].questions[0].id);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [testId, user?.id]);

  // Auto-save answers & time state to localStorage
  useEffect(() => {
    if (!isExamStarted || !user || !testId) return;
    try {
      const saveKey = `ielts_native_progress_${user?.id}_${testId}`;
      localStorage.setItem(saveKey, JSON.stringify({
        listeningAnswers,
        readingAnswers,
        writingAnswers,
        timeLeft,
        timestamp: Date.now()
      }));
    } catch {}
  }, [listeningAnswers, readingAnswers, writingAnswers, timeLeft, isExamStarted, user, testId]);

  const submitTestAnswers = async () => {
    if (submissionInFlightRef.current) return;
    submissionInFlightRef.current = true;
    setSubmitting(true);
    setShowSubmitConfirm(false);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    // Answers inside an iframe module only reach this component when that module
    // reports them, which until now happened solely because the student pressed
    // the module's own "Complete Section" button. A student who answered
    // everything and then pressed Submit Test -- the obvious thing to do, and the
    // only button on a single-module test that looks like it ends the exam --
    // submitted an empty paper with no score. Harvest anything outstanding here so
    // Submit alone is always sufficient.
    const pending = [];
    if (listeningIsIframe && !harvestedRef.current.listening) {
      autoCompleteIframeModule(listeningIframeRef);
      pending.push('listening');
    }
    if (readingIsIframe && !harvestedRef.current.reading) {
      autoCompleteIframeModule(readingIframeRef);
      pending.push('reading');
    }
    if (pending.length) {
      // The module answers via postMessage, so give it a moment to arrive; the
      // values are read from the ref below rather than from state, which this
      // call cannot see updated.
      const deadline = Date.now() + 3000;
      while (pending.some(m => !harvestedRef.current[m]) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    const listening = harvestedRef.current.listening || moduleResults.listening;
    const reading = harvestedRef.current.reading || moduleResults.reading;

    try {
      const res = await fetch(`/api/student/submit/${testId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          studentId: user.id,
          listeningAnswers: listening?.answers || listeningAnswers,
          readingAnswers: reading?.answers || readingAnswers,
          writingAnswers,
          listeningDetail: listening?.detail,
          readingDetail: reading?.detail,
          listeningScore: listening?.band,
          readingScore: reading?.band,
          violationsCount: violations
        })
      });

      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || 'Failed to submit answers');

      try {
        localStorage.removeItem(`ielts_native_progress_${user?.id}_${testId}`);
      } catch {}

      if (document.fullscreenElement) {
        await document.exitFullscreen().catch(() => {});
      }
      alert(result.message || 'Test submitted successfully.');
      onFinished();
    } catch (err) {
      const message = err.name === 'AbortError'
        ? 'The submission timed out. Your answers are still saved; check your connection and try again.'
        : err.message;
      alert(`Submission Error: ${message}`);
    } finally {
      clearTimeout(timeout);
      submissionInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  useEffect(() => {
    fetchTestDetails();
  }, [fetchTestDetails]);

  // Default to the first module that actually has content (e.g. a reading-only test).
  useEffect(() => {
    if (!test) return;
    if (!hasListeningContent && hasReadingContent) setActiveModule('reading');
    else if (!hasListeningContent && !hasReadingContent && hasWritingContent) setActiveModule('writing');
  }, [test, hasListeningContent, hasReadingContent, hasWritingContent]);

  // Reset the per-module clocks whenever a (new) hybrid test loads.
  useEffect(() => {
    if (isHybridWithIframeModules) setHybridTimers({ reading: 3600, writing: writingSeconds });
  }, [test, isHybridWithIframeModules, writingSeconds]);

  // A writing-only paper is not "hybrid", so it fell through to the flat
  // 40-minute native default and gave students 40 minutes for a paper whose own
  // rubric asks for 20 on Task 1 and 40 on Task 2. Give it the time its tasks
  // add up to -- the same figure the hybrid path already uses.
  //
  // Only when the clock is still the untouched default: a resumed attempt has
  // already restored the student's real remaining time just above, and must not
  // be handed a fresh hour.
  useEffect(() => {
    if (!test || isHybridWithIframeModules) return;
    if (hasListeningContent || hasReadingContent || !hasWritingContent) return;
    setTimeLeft((current) => (current === 2400 ? writingSeconds : current));
  }, [test, isHybridWithIframeModules, hasListeningContent, hasReadingContent, hasWritingContent, writingSeconds]);

  // Mark whichever module is active as "visited" so its iframe mounts (see the
  // mount conditions below) -- lazily, the first time the student actually gets
  // there, not before.
  useEffect(() => {
    if (!isExamStarted) return;
    if (activeModule !== 'listening' && activeModule !== 'reading') return;
    setVisitedModules((previous) => (previous[activeModule] ? previous : { ...previous, [activeModule]: true }));
  }, [isExamStarted, activeModule]);

  latestSubmissionRef.current = submitTestAnswers;

  // Programmatically fires an iframe module's own "Complete Section" button (same
  // effect as the student clicking it) -- used when that module's own clock runs out,
  // or a sequential-locked exam moves the student on, rather than the student
  // finishing the section directly. No-ops safely if already completed.
  //
  // Prefers the bridge's own exposed handler (window.__ieltsBridgeComplete) over
  // searching the DOM for "the button" -- a real incident: this module's button
  // used a non-standard id, and the bridge itself relabels the button's text away
  // from "Check Answers" the moment it installs, so a DOM search from out here
  // silently stopped matching and a student's whole Reading section went
  // unsubmitted. Falls back to the old DOM search for content uploaded before
  // this hook existed.
  const autoCompleteIframeModule = (iframeRef) => {
    try {
      const win = iframeRef.current?.contentWindow;
      const doc = iframeRef.current?.contentDocument;
      if (!win || !doc) return;
      if (typeof win.__ieltsBridgeComplete === 'function') {
        win.__ieltsBridgeComplete();
        return;
      }
      const btn = doc.getElementById('checkBtn')
        || doc.getElementById('checkAnswersBtn')
        || Array.from(doc.querySelectorAll('button')).find((b) => /check\s*answers?/i.test(b.textContent || ''));
      if (btn && !btn.disabled) btn.click();
    } catch {}
  };

  // Sequential-locked tests only: advances to the next module in moduleOrder.
  // There is deliberately no equivalent step backward -- once a student moves
  // on, the module they left is locked, matching the real exam.
  const goToNextStage = () => {
    const nextModule = moduleOrder[currentStageIndex + 1];
    if (!nextModule) return;
    setActiveModule(nextModule);
    if (nextModule === 'writing') {
      // Open on the task this test actually has -- a Task-2-only test must not
      // land the student on a blank Task 1.
      setActiveQuestionId(hasTask1 ? 'task1' : 'task2');
      setActiveWritingTask(hasTask1 ? 'task1' : 'task2');
    }
  };

  const MODULE_LABELS = { listening: 'Listening', reading: 'Reading', writing: 'Writing' };

  const finishCurrentStageAndContinue = () => {
    const nextModule = moduleOrder[currentStageIndex + 1];
    if (!nextModule) return;
    const confirmed = window.confirm(
      `You will not be able to return to ${MODULE_LABELS[activeModule]} once you continue. Move on to ${MODULE_LABELS[nextModule]} now?`
    );
    if (!confirmed) return;
    if (activeModule === 'listening' && listeningIsIframe) autoCompleteIframeModule(listeningIframeRef);
    if (activeModule === 'reading' && readingIsIframe) autoCompleteIframeModule(readingIframeRef);
    goToNextStage();
  };

  // Native tests keep one shared clock across the whole exam, exactly as before.
  // Hybrid tests give Reading and Writing independent 60-minute clocks (matching the
  // real exam), and Listening none at all (it's audio-paced, not clock-driven).
  // Legacy standalone full-mock iframes (which own their internal timer/UI) skip the
  // parent timer entirely.
  useEffect(() => {
    if (!isExamStarted || !test || isLegacyFullScreen) return;

    if (isHybridWithIframeModules) {
      if (activeModule !== 'reading' && activeModule !== 'writing') return;
      const tickingModule = activeModule;

      timerIntervalRef.current = setInterval(() => {
        setHybridTimers((previous) => {
          if (previous[tickingModule] <= 1) {
            clearInterval(timerIntervalRef.current);
            if (tickingModule === 'writing') {
              alert('Time is up! Your answers are being submitted automatically.');
              latestSubmissionRef.current?.();
            } else {
              alert('Reading time is up! Your Reading section has been locked and saved.');
              autoCompleteIframeModule(readingIframeRef);
              // Sequential-locked tests have no manual tab-switching to fall back on,
              // so a timed-out module must advance the exam itself or the student
              // would be stuck with every tab locked.
              if (sequentialLock) goToNextStage();
            }
            return { ...previous, [tickingModule]: 0 };
          }
          return { ...previous, [tickingModule]: previous[tickingModule] - 1 };
        });
      }, 1000);

      return () => clearInterval(timerIntervalRef.current);
    }

    timerIntervalRef.current = setInterval(() => {
      setTimeLeft((previous) => {
        if (previous <= 1) {
          clearInterval(timerIntervalRef.current);
          alert('Time is up! Your answers are being submitted automatically.');
          latestSubmissionRef.current?.();
          return 0;
        }
        return previous - 1;
      });
    }, 1000);

    return () => clearInterval(timerIntervalRef.current);
  }, [isExamStarted, test, isLegacyFullScreen, isHybridWithIframeModules, activeModule, sequentialLock]);

  // Helper to format remaining seconds into MM:SS
  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Get word count helper
  const getWordCount = (text) => {
    if (!text) return 0;
    return text.trim().split(/\s+/).filter(word => word.length > 0).length;
  };

  if (loading) {
    return (
      <div style={{ ...styles.ieltsSimulator, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f3f4f6' }}>
        <h3>Loading IELTS Simulator Engine...</h3>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ ...styles.ieltsSimulator, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f3f4f6' }}>
        <h3>System Loading Error: {error}</h3>
        <button onClick={onFinished} className="btn btn-danger" style={{ marginTop: '1rem' }}>Go Back</button>
      </div>
    );
  }

  // Early returns removed to keep iframe mounted in background during lockout

  // Define questions list for active module to build bottom bubbles
  let questionsForActiveModule = [];
  if (activeModule === 'listening' && !listeningIsIframe && test.listening_data && test.listening_data.sections) {
    test.listening_data.sections.forEach(sec => {
      if (sec.questions) {
        sec.questions.forEach(q => questionsForActiveModule.push(q));
      }
    });
  } else if (activeModule === 'reading' && !readingIsIframe && test.reading_data && test.reading_data.passages) {
    test.reading_data.passages.forEach(pass => {
      if (pass.questions) {
        pass.questions.forEach(q => questionsForActiveModule.push(q));
      }
    });
  } else if (activeModule === 'writing') {
    // Writing tasks
    questionsForActiveModule = [
      ...(hasTask1 ? [{ id: 'task1', label: 'T1' }] : []),
      ...(hasTask2 ? [{ id: 'task2', label: 'T2' }] : [])
    ];
  }

  const activeQuestionIndex = questionsForActiveModule.findIndex(q => q.id === activeQuestionId);

  const handleNextQuestion = () => {
    if (activeQuestionIndex < questionsForActiveModule.length - 1) {
      setActiveQuestionId(questionsForActiveModule[activeQuestionIndex + 1].id);
    }
  };

  const handlePrevQuestion = () => {
    if (activeQuestionIndex > 0) {
      setActiveQuestionId(questionsForActiveModule[activeQuestionIndex - 1].id);
    }
  };

  const toggleFlagged = (id) => {
    setFlaggedQuestions(prev => ({
      ...prev,
      [id]: !prev[id]
    }));
  };

  const isQuestionAnswered = (qId) => {
    if (activeModule === 'listening') {
      return !!listeningAnswers[qId];
    } else if (activeModule === 'reading') {
      return !!readingAnswers[qId];
    } else {
      // Writing
      return qId === 'task1' ? getWordCount(writingAnswers.task1) > 0 : getWordCount(writingAnswers.task2) > 0;
    }
  };

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      {isLegacyFullScreen ? (
        <div style={{ width: '100vw', height: '100vh', margin: 0, padding: 0, overflow: 'hidden' }}>
          {isExamStarted && (
            <iframe
              ref={listeningIframeRef}
              src={`${window.location.origin}${test.listening_data.iframeUrl}?studentId=${encodeURIComponent(user.id)}&testId=${testId}`}
              style={{ width: '100%', height: '100%', border: 'none' }}
              title={test.title}
            />
          )}
        </div>
      ) : (
        <div className="ielts-simulator">
      {/* 1. Header Bar */}
      <header className="ielts-header">
        <div className="ielts-header-left">
          <div className="ielts-logo">IELTS <span>Mock CD</span></div>
          <span style={{ fontSize: '0.85rem', color: '#94a3b8', borderLeft: '1px solid #475569', paddingLeft: '1rem' }}>
            {test.title}
          </span>
        </div>

        {showTimer && displayTime !== null && (
          <div className={`ielts-timer ${isTimerWarning ? 'warning' : ''}`}>
            ⏳ {formatTime(displayTime)}
          </div>
        )}

        <div className="ielts-header-tools">
          {/* Font sizer */}
          <div className="font-sizer">
            <span style={{ fontSize: '0.75rem', color: '#cbd5e1', padding: '0 0.5rem', fontWeight: 'bold' }}>A</span>
            <button 
              className={`font-sizer-btn ${fontSize === 'md' ? 'active' : ''}`}
              onClick={() => setFontSize('md')}
            >
              Std
            </button>
            <button 
              className={`font-sizer-btn ${fontSize === 'lg' ? 'active' : ''}`}
              onClick={() => setFontSize('lg')}
            >
              Large
            </button>
            <button 
              className={`font-sizer-btn ${fontSize === 'xl' ? 'active' : ''}`}
              onClick={() => setFontSize('xl')}
            >
              X-Large
            </button>
          </div>

          <button className="ielts-tool-btn" onClick={() => setShowTimer(!showTimer)}>
            {showTimer ? 'Hide Timer ⏱️' : 'Show Timer ⏱️'}
          </button>
          <button className="ielts-tool-btn" onClick={() => setShowHelpModal(true)}>
            Help ❓
          </button>
          <button className="btn btn-danger" style={{ padding: '0.4rem 1rem' }} onClick={() => setShowSubmitConfirm(true)}>
            Submit Test 📥
          </button>
        </div>
      </header>

      {/* 2. Part Navigation (Tabs for Module Switching) */}
      <nav className="ielts-part-tabs">
        {hasListeningContent && (
          <button
            className={`ielts-part-tab ${activeModule === 'listening' ? 'active' : ''}`}
            disabled={sequentialLock && moduleOrder.indexOf('listening') !== currentStageIndex}
            onClick={() => {
              if (sequentialLock && moduleOrder.indexOf('listening') !== currentStageIndex) return;
              setActiveModule('listening');
              if (!listeningIsIframe && test.listening_data?.sections?.[0]?.questions?.[0]) {
                setActiveQuestionId(test.listening_data.sections[0].questions[0].id);
              }
            }}
          >
            🎧 Listening {sequentialLock
              ? (moduleOrder.indexOf('listening') < currentStageIndex ? '✓' : moduleOrder.indexOf('listening') > currentStageIndex ? '🔒' : '')
              : (moduleResults.listening ? '✓' : '')}
          </button>
        )}
        {hasReadingContent && (
          <button
            className={`ielts-part-tab ${activeModule === 'reading' ? 'active' : ''}`}
            disabled={sequentialLock && moduleOrder.indexOf('reading') !== currentStageIndex}
            onClick={() => {
              if (sequentialLock && moduleOrder.indexOf('reading') !== currentStageIndex) return;
              setActiveModule('reading');
              if (!readingIsIframe && test.reading_data?.passages?.[0]?.questions?.[0]) {
                setActiveQuestionId(test.reading_data.passages[0].questions[0].id);
              }
            }}
          >
            📖 Reading {sequentialLock
              ? (moduleOrder.indexOf('reading') < currentStageIndex ? '✓' : moduleOrder.indexOf('reading') > currentStageIndex ? '🔒' : '')
              : (moduleResults.reading ? '✓' : '')}
          </button>
        )}
        {hasWritingContent && (
          <button
            className={`ielts-part-tab ${activeModule === 'writing' ? 'active' : ''}`}
            disabled={sequentialLock && moduleOrder.indexOf('writing') !== currentStageIndex}
            onClick={() => {
              if (sequentialLock && moduleOrder.indexOf('writing') !== currentStageIndex) return;
              setActiveModule('writing');
              setActiveQuestionId(hasTask1 ? 'task1' : 'task2');
              setActiveWritingTask(hasTask1 ? 'task1' : 'task2');
            }}
          >
            ✍️ Writing {sequentialLock && moduleOrder.indexOf('writing') > currentStageIndex ? '🔒' : ''}
          </button>
        )}
        {sequentialLock && currentStageIndex >= 0 && currentStageIndex < moduleOrder.length - 1 && (
          <button
            className="ielts-part-tab"
            style={{ marginLeft: 'auto', background: '#16a34a', color: '#fff', fontWeight: 600 }}
            onClick={finishCurrentStageAndContinue}
          >
            Finish {MODULE_LABELS[activeModule]} & Continue ▶
          </button>
        )}
      </nav>

      {/* 3. Main Workspace */}
      <div className="ielts-workspace">
        {/* LISTENING MODULE WORKSPACE (standalone iframe, kept mounted across tab switches) */}
        {listeningIsIframe && (
          <div style={{ width: '100%', height: '100%', display: activeModule === 'listening' ? 'block' : 'none' }}>
            {isExamStarted && visitedModules.listening && (
              <iframe
                ref={listeningIframeRef}
                src={`${window.location.origin}${test.listening_data.iframeUrl}?studentId=${encodeURIComponent(user.id)}&testId=${testId}&moduleType=listening&multiModule=${moduleOrder.length > 1 ? 1 : 0}`}
                style={{ width: '100%', height: '100%', border: 'none' }}
                title={`${test.title} — Listening`}
              />
            )}
          </div>
        )}

        {/* LISTENING MODULE WORKSPACE (native JSON questions) */}
        {!listeningIsIframe && activeModule === 'listening' && (
          <div style={styles.listeningContainer}>
            {/* Embedded Audio Control */}
            <div style={styles.audioBar}>
              <p style={{ fontWeight: '600', color: '#1e293b', marginBottom: '0.5rem' }}>
                🎧 Please click play to start Listening Section Audio. Real exam play-once applies.
              </p>
              <audio 
                ref={audioRef}
                src={test.listening_data.audioUrl} 
                controls 
                style={{ width: '100%' }}
              />
            </div>
            
            {/* Listening Sections list */}
            <div className="ielts-highlightable" style={styles.listeningQuestionsScroll}>
              {(test.listening_data?.sections || []).map((section, sIdx) => (
                <div key={sIdx} style={styles.listeningSectionBlock}>
                  <h4 style={styles.sectionHeading}>{section.title}</h4>
                  <p style={styles.instructionText}>{section.instructions}</p>
                  
                  <div style={styles.questionsGrid}>
                    {section.questions.map((q) => {
                      const isActive = q.id === activeQuestionId;
                      return (
                        <div 
                          key={q.id} 
                          id={`q-${q.id}`}
                          onClick={() => setActiveQuestionId(q.id)}
                          style={{
                            ...styles.testQuestionCard,
                            borderColor: isActive ? '#2563eb' : '#d1d5db',
                            boxShadow: isActive ? '0 0 0 2px rgba(37,99,235,0.15)' : 'none'
                          }}
                        >
                          <span style={styles.qNumBadge}>{q.id}</span>
                          
                          {q.type === 'fill-in-the-blank' && (
                            <div style={styles.blankFieldRow}>
                              <label style={styles.blankLabel}>{q.label}</label>
                              <input 
                                type="text"
                                className="ielts-input-blank"
                                placeholder={q.placeholder}
                                value={listeningAnswers[q.id] || ''}
                                onChange={(e) => setListeningAnswers({
                                  ...listeningAnswers,
                                  [q.id]: e.target.value
                                })}
                              />
                            </div>
                          )}

                          {q.type === 'multiple-choice' && (
                            <div>
                              <p style={styles.mcqText}>{q.text}</p>
                              {q.options.map((opt, oIdx) => {
                                const optionChar = opt.charAt(0); // A, B, C etc.
                                return (
                                  <label key={oIdx} className="ielts-option-label">
                                    <input 
                                      type="radio"
                                      name={`listening-q-${q.id}`}
                                      checked={listeningAnswers[q.id] === optionChar}
                                      onChange={() => setListeningAnswers({
                                        ...listeningAnswers,
                                        [q.id]: optionChar
                                      })}
                                    />
                                    <span>{opt}</span>
                                  </label>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* READING MODULE WORKSPACE (standalone iframe, kept mounted across tab switches) */}
        {readingIsIframe && (
          <div style={{ width: '100%', height: '100%', display: activeModule === 'reading' ? 'block' : 'none' }}>
            {isExamStarted && visitedModules.reading && (
              <iframe
                ref={readingIframeRef}
                src={`${window.location.origin}${test.reading_data.iframeUrl}?studentId=${encodeURIComponent(user.id)}&testId=${testId}&moduleType=reading&multiModule=${moduleOrder.length > 1 ? 1 : 0}`}
                style={{ width: '100%', height: '100%', border: 'none' }}
                title={`${test.title} — Reading`}
              />
            )}
          </div>
        )}

        {/* READING MODULE WORKSPACE (native JSON questions, Independent Split Panel) */}
        {!readingIsIframe && activeModule === 'reading' && (
          <div style={{ display: 'flex', width: '100%', overflow: 'hidden' }}>
            {/* Left Passage Pane */}
            <div className={`ielts-passage-pane ielts-highlightable font-${fontSize}`}>
              {(test.reading_data?.passages || []).map((passage, pIdx) => (
                <div key={pIdx}>
                  <h3 className="ielts-passage-title">{passage.title}</h3>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{passage.text}</div>
                </div>
              ))}
            </div>

            {/* Right Question Pane */}
            <div className={`ielts-questions-pane font-${fontSize}`}>
              {(test.reading_data?.passages || []).map((passage, pIdx) => (
                <div key={pIdx}>
                  <h4 style={{ marginBottom: '1rem', borderBottom: '1px solid #d1d5db', paddingBottom: '0.25rem', color: '#1f2937' }}>
                    Questions for Reading Passage {pIdx + 1}
                  </h4>
                  
                  {passage.questions.map((q) => {
                    const isActive = q.id === activeQuestionId;
                    return (
                      <div 
                        key={q.id}
                        id={`q-${q.id}`}
                        onClick={() => setActiveQuestionId(q.id)}
                        className="ielts-question-card"
                        style={{
                          borderColor: isActive ? '#2563eb' : '#d1d5db',
                          boxShadow: isActive ? '0 0 0 2px rgba(37,99,235,0.15)' : 'none'
                        }}
                      >
                        <span style={styles.qNumBadge}>{q.id}</span>

                        {q.type === 'multiple-choice' && (
                          <div>
                            <p style={styles.mcqText}>{q.text}</p>
                            {q.options.map((opt, oIdx) => {
                              const optionChar = opt.charAt(0);
                              return (
                                <label key={oIdx} className="ielts-option-label">
                                  <input 
                                    type="radio"
                                    name={`reading-q-${q.id}`}
                                    checked={readingAnswers[q.id] === optionChar}
                                    onChange={() => setReadingAnswers({
                                      ...readingAnswers,
                                      [q.id]: optionChar
                                    })}
                                  />
                                  <span>{opt}</span>
                                </label>
                              );
                            })}
                          </div>
                        )}

                        {q.type === 'true-false-notgiven' && (
                          <div>
                            <p style={styles.mcqText}>{q.text}</p>
                            {q.options.map((opt, oIdx) => (
                              <label key={oIdx} className="ielts-option-label">
                                <input 
                                  type="radio"
                                  name={`reading-q-${q.id}`}
                                  checked={readingAnswers[q.id] === opt}
                                  onChange={() => setReadingAnswers({
                                    ...readingAnswers,
                                    [q.id]: opt
                                  })}
                                />
                                <span>{opt}</span>
                              </label>
                            ))}
                          </div>
                        )}

                        {q.type === 'fill-in-the-blank' && (
                          <div style={styles.blankFieldRow}>
                            <label style={styles.blankLabel}>{q.label}</label>
                            <input 
                              type="text"
                              className="ielts-input-blank"
                              placeholder={q.placeholder}
                              value={readingAnswers[q.id] || ''}
                              onChange={(e) => setReadingAnswers({
                                ...readingAnswers,
                                [q.id]: e.target.value
                              })}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* WRITING MODULE WORKSPACE (Independent Split Panel) */}
        {activeModule === 'writing' && (
          <div style={{ display: 'flex', width: '100%', overflow: 'hidden' }}>
            {/* Left Prompt Panel */}
            <div className={`ielts-passage-pane font-${fontSize}`} style={{ flex: '0.45' }}>
              {/* Only offer the tasks this test actually sets. A Task-2-only
                  test (e.g. the "Day N" files) otherwise opened on an empty
                  Task 1 reading "No Task 1 prompt is available", which looks
                  like the test failed to load and hides the real essay behind
                  a second tab. */}
              <div style={styles.writingSelectorBar}>
                {hasTask1 && (
                  <button
                    onClick={() => {
                      setActiveWritingTask('task1');
                      setActiveQuestionId('task1');
                    }}
                    style={{
                      ...styles.writingSelTab,
                      borderBottomColor: activeWritingTask === 'task1' ? '#2563eb' : 'transparent',
                      color: activeWritingTask === 'task1' ? '#2563eb' : '#374151'
                    }}
                  >
                    Writing Task 1 (Min 150 Words)
                  </button>
                )}
                {hasTask2 && (
                  <button
                    onClick={() => {
                      setActiveWritingTask('task2');
                      setActiveQuestionId('task2');
                    }}
                    style={{
                      ...styles.writingSelTab,
                      borderBottomColor: activeWritingTask === 'task2' ? '#2563eb' : 'transparent',
                      color: activeWritingTask === 'task2' ? '#2563eb' : '#374151'
                    }}
                  >
                    Writing Task 2 (Min 250 Words)
                  </button>
                )}
              </div>

              <div style={{ padding: '1rem 0' }}>
                <h4 style={{ marginBottom: '1rem', color: '#111827' }}>
                  {activeWritingTask === 'task1' ? 'Task 1 instructions:' : 'Task 2 instructions:'}
                </h4>
                <p style={{ lineHeight: '1.6', color: '#374151', fontSize: '1.05rem', whiteSpace: 'pre-wrap' }}>
                  {activeWritingTask === 'task1'
                    ? (test.writing_data?.task1?.prompt || 'No Task 1 prompt is available for this test.')
                    : (test.writing_data?.task2?.prompt || 'No Task 2 prompt is available for this test.')}
                </p>
                {activeWritingTask === 'task1' && (test.writing_data?.task1?.imageUrl || test.writing_data?.task1?.image) && (
                  <img
                    src={test.writing_data.task1.imageUrl || test.writing_data.task1.image}
                    alt="Task 1 chart"
                    style={{ maxWidth: '100%', marginTop: '1rem', border: '1px solid #d1d5db', borderRadius: '4px' }}
                  />
                )}
              </div>
            </div>

            {/* Right Writing Input Pane */}
            <div className="ielts-questions-pane" style={{ flex: '0.55', display: 'flex', flexDirection: 'column' }}>
              <h4 style={{ marginBottom: '0.5rem', color: '#1f2937' }}>Candidate Essay Response</h4>
              
              {activeWritingTask === 'task1' ? (
                <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                  <textarea 
                    className="ielts-writing-textarea"
                    placeholder="Type your Task 1 response here..."
                    value={writingAnswers.task1}
                    onChange={(e) => setWritingAnswers({ ...writingAnswers, task1: e.target.value })}
                  />
                  <div>
                    <span className="word-count-badge">
                      Word Count: {getWordCount(writingAnswers.task1)} / {test.writing_data?.task1?.minWords ?? 150} min
                    </span>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                  <textarea 
                    className="ielts-writing-textarea"
                    placeholder="Type your Task 2 response here..."
                    value={writingAnswers.task2}
                    onChange={(e) => setWritingAnswers({ ...writingAnswers, task2: e.target.value })}
                  />
                  <div>
                    <span className="word-count-badge">
                      Word Count: {getWordCount(writingAnswers.task2)} / {test.writing_data?.task2?.minWords ?? 250} min
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 4. Bottom Dock -- skipped entirely for iframe modules. They have their own
          complete navigation/status bar, and every pixel here is worth giving back
          to the passage/audio content instead of duplicating status the student can
          already see (the tab checkmark above, and the module's own nav bar). */}
      {activeModuleIsIframe ? null : (
      <footer className="ielts-bottom-dock">
        {/* Navigation buttons */}
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <button 
            onClick={handlePrevQuestion}
            disabled={activeQuestionIndex <= 0}
            className="ielts-tool-btn"
            style={{ padding: '0.5rem 1rem' }}
          >
            ← Previous
          </button>
          
          {activeQuestionId && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#cbd5e1', cursor: 'pointer', fontSize: '0.85rem' }}>
              <input 
                type="checkbox"
                checked={!!flaggedQuestions[activeQuestionId]}
                onChange={() => toggleFlagged(activeQuestionId)}
              />
              <span>📌 Review Flag</span>
            </label>
          )}
        </div>

        {/* Dynamic Bubble Navigation */}
        <div className="ielts-nav-bubbles">
          {questionsForActiveModule.map((q, idx) => {
            const isCurrent = q.id === activeQuestionId;
            const isAnswered = isQuestionAnswered(q.id);
            const isFlagged = flaggedQuestions[q.id];

            return (
              <button 
                key={q.id}
                onClick={() => {
                  setActiveQuestionId(q.id);
                  if (activeModule === 'writing') {
                    setActiveWritingTask(q.id);
                  } else {
                    // Try to scroll into view
                    const element = document.getElementById(`q-${q.id}`);
                    if (element) {
                      element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }
                  }
                }}
                className={`ielts-bubble ${isCurrent ? 'active' : ''} ${isAnswered ? 'answered' : ''} ${isFlagged ? 'flagged' : ''}`}
                title={activeModule === 'writing' ? `Task ${idx + 1}` : `Question ${q.id}`}
              >
                {activeModule === 'writing' ? (idx + 1) : q.id}
              </button>
            );
          })}
        </div>

        <button
          onClick={handleNextQuestion}
          disabled={activeQuestionIndex >= questionsForActiveModule.length - 1}
          className="ielts-tool-btn"
          style={{ padding: '0.5rem 1rem' }}
        >
          Next →
        </button>
      </footer>
      )}

      {/* Submit Confirmation Modal */}
      {showSubmitConfirm && (
        <div style={styles.modalOverlay}>
          <div style={styles.confirmPanel}>
            <h4>Confirm Test Submission</h4>
            <p style={{ margin: '1rem 0', color: '#4b5563', lineHeight: '1.5' }}>
              Are you sure you want to end and submit your IELTS mock exam?
              Once submitted, your Listening, Reading, and Writing responses will be sent directly to your teacher for review.
              Your final band scores, mistake explanations, and teacher feedback will be published to your dashboard after teacher evaluation.
            </p>
            {listeningIsIframe && !moduleResults.listening && (
              <p style={{ color: '#b45309', fontSize: '0.9rem', marginBottom: '0.5rem' }}>
                ⚠️ You haven't marked the Listening section complete yet.
              </p>
            )}
            {readingIsIframe && !moduleResults.reading && (
              <p style={{ color: '#b45309', fontSize: '0.9rem', marginBottom: '0.5rem' }}>
                ⚠️ You haven't marked the Reading section complete yet.
              </p>
            )}
            <div style={styles.confirmActions}>
              <button className="btn btn-primary" onClick={submitTestAnswers} disabled={submitting}>
                Yes, Submit Test 📥
              </button>
              <button className="btn btn-secondary" onClick={() => setShowSubmitConfirm(false)}>
                Cancel & Continue Testing
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Help Modal */}
      {showHelpModal && (
        <div style={styles.modalOverlay}>
          <div style={styles.confirmPanel}>
            <h4>Mock CD-IELTS Navigation Help</h4>
            <div style={{ margin: '1rem 0', fontSize: '0.9rem', color: '#4b5563', lineHeight: '1.6' }}>
              <p>🎯 <strong>Highlighting Text</strong>: Highlight passages or questions by simply clicking and dragging your cursor over the text.</p>
              <p style={{ marginTop: '0.5rem' }}>⏱️ <strong>Timer</strong>: The countdown timer is pinned in the header. Use the "Hide" button to hide the timer. It turns red in the final 5 minutes.</p>
              <p style={{ marginTop: '0.5rem' }}>📌 <strong>Review Dock</strong>: Mark any question for review by checking the "Review Flag" box. A dot indicator will appear on that question bubble in the dock below.</p>
            </div>
            <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={() => setShowHelpModal(false)}>
              Got it
            </button>
          </div>
        </div>
      )}
      </div>
      )}

      {/* 2. Intro overlay */}
      {!isExamStarted && (
        <div style={styles.startExamContainer}>
          <div className="card" style={styles.startExamCard}>
            <h2 style={{ color: '#f43f5e', marginBottom: '1rem', textAlign: 'center', fontWeight: 'bold' }}>🔒 Secure Exam Environment</h2>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem', fontSize: '0.95rem', lineHeight: '1.6' }}>
              This exam is monitored by the IELTS Mock Platform tab-lock and anti-cheat engine. To start the exam, you must agree to the following rules:
            </p>
            <ul style={{ color: 'var(--text-primary)', paddingLeft: '1.25rem', marginBottom: '2rem', fontSize: '0.9rem', lineHeight: '1.8' }}>
              <li>You must remain in <strong>Fullscreen Mode</strong> at all times.</li>
              <li>Switching tabs, minimizing the browser, or opening other windows is strictly prohibited.</li>
              <li>Any attempt to leave this page will log a <strong>violation</strong>.</li>
              <li>Accumulating <strong>3 violations</strong> will terminate your test and submit your progress automatically.</li>
            </ul>
            <button onClick={startExamAndEnterFullscreen} className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', fontSize: '1.05rem', padding: '1rem' }}>
              🔐 Agree & Begin Test
            </button>
            <button onClick={onFinished} className="btn btn-secondary" style={{ width: '100%', justifyContent: 'center', marginTop: '0.75rem', fontSize: '0.95rem', padding: '0.75rem' }}>
              🚪 Cancel & Go Back
            </button>
          </div>
        </div>
      )}

      {/* 3. Warning overlay */}
      {isLockoutActive && !examTerminated && (
        <div style={{ ...styles.startExamContainer, backgroundColor: 'rgba(15, 23, 42, 0.95)', zIndex: 99999 }}>
          <div className="card" style={{ ...styles.startExamCard, border: '2px solid #f59e0b', textAlign: 'center' }}>
            <h2 style={{ color: '#f59e0b', marginBottom: '1.5rem', fontWeight: 'bold' }}>⚠️ Anti-Cheat Warning</h2>
            <p style={{ color: '#cbd5e1', marginBottom: '1rem' }}>
              Violation Detected: <strong>{lockoutReason}</strong>
            </p>
            <p style={{ color: '#f43f5e', fontWeight: 'bold', marginBottom: '2rem', fontSize: '1.1rem' }}>
              Total Violations: {violations} / 3
            </p>
            <button onClick={resumeFullscreen} className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}>
              🔐 Resume Fullscreen & Continue
            </button>
          </div>
        </div>
      )}

      {/* 4. Terminated overlay */}
      {examTerminated && (
        <div style={{ ...styles.startExamContainer, backgroundColor: '#0f172a', zIndex: 999999 }}>
          <div className="card" style={{ ...styles.startExamCard, border: '2px solid #f43f5e', textAlign: 'center' }}>
            <h2 style={{ color: '#f43f5e', marginBottom: '1.5rem', fontWeight: 'bold' }}>🚨 Test Terminated</h2>
            <p style={{ color: '#cbd5e1', marginBottom: '2rem', lineHeight: '1.6' }}>
              Your test session has been terminated because you exceeded the limit of 3 tab-switching or focus-loss violations.
            </p>
            <p style={{ color: '#f43f5e', fontWeight: 'bold', fontSize: '1.1rem' }}>
              Your answers have been submitted automatically.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  listeningContainer: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    backgroundColor: '#ffffff',
  },
  audioBar: {
    backgroundColor: '#e2e8f0',
    padding: '1.25rem 2rem',
    borderBottom: '1px solid #cbd5e1',
  },
  listeningQuestionsScroll: {
    flex: 1,
    overflowY: 'auto',
    padding: '2rem',
  },
  listeningSectionBlock: {
    marginBottom: '3rem',
    borderBottom: '1px dotted #d1d5db',
    paddingBottom: '2rem',
  },
  sectionHeading: {
    fontSize: '1.25rem',
    fontWeight: '700',
    color: '#1e293b',
    marginBottom: '0.5rem',
  },
  instructionText: {
    fontSize: '0.95rem',
    fontStyle: 'italic',
    color: '#475569',
    marginBottom: '1.5rem',
  },
  questionsGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr',
    gap: '1.5rem',
  },
  testQuestionCard: {
    backgroundColor: '#f8fafc',
    border: '1px solid #cbd5e1',
    borderRadius: '6px',
    padding: '1.25rem',
    position: 'relative',
    cursor: 'pointer',
    transition: 'all 0.2s',
  },
  qNumBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    borderRadius: '4px',
    backgroundColor: '#1e293b',
    color: '#ffffff',
    fontSize: '0.8rem',
    fontWeight: '700',
    marginBottom: '0.75rem',
  },
  blankFieldRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    marginTop: '0.25rem',
  },
  blankLabel: {
    fontWeight: '600',
    color: '#334155',
  },
  mcqText: {
    fontWeight: '600',
    color: '#1e293b',
    marginBottom: '0.75rem',
  },
  writingSelectorBar: {
    display: 'flex',
    borderBottom: '1px solid #e5e7eb',
    marginBottom: '1rem',
    userSelect: 'none',
  },
  writingSelTab: {
    flex: 1,
    padding: '0.75rem 0.5rem',
    background: 'none',
    border: 'none',
    borderBottom: '2px solid transparent',
    fontWeight: '600',
    fontSize: '0.9rem',
    cursor: 'pointer',
    transition: 'all 0.2s',
  },
  modalOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
  },
  confirmPanel: {
    width: '100%',
    maxWidth: '480px',
    backgroundColor: '#ffffff',
    borderRadius: '4px',
    padding: '2rem',
    border: '1px solid #d1d5db',
    boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1)',
  },
  confirmActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '1rem',
    marginTop: '1.5rem',
  },
  startExamContainer: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'var(--bg-primary)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
    padding: '1.5rem',
  },
  startExamCard: {
    width: '100%',
    maxWidth: '540px',
    backgroundColor: 'var(--bg-secondary)',
    borderRadius: '12px',
    padding: '2.5rem',
    boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.3)',
    border: '1px solid var(--glass-border)',
  }
};
