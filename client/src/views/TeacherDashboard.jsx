
import React, { useState, useEffect } from 'react';
import ChangePasswordModal from '../components/ChangePasswordModal';
import { generateDetailedReviewPdf } from '../utils/pdfReport';

const fmtScore = (v) => (v === null || v === undefined || isNaN(Number(v))) ? '—' : Number(v).toFixed(1);

export default function TeacherDashboard({ user, onLogout, onSwitchRole, theme, toggleTheme }) {
  const [showPwdModal, setShowPwdModal] = useState(false);
  const [submissions, setSubmissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Selected submission for grading
  const [selectedSub, setSelectedSub] = useState(null);
  const [viewMode, setViewMode] = useState('grading'); // 'grading' or 'detailed_review'
  const [answerKey, setAnswerKey] = useState(null);
  const [loadingKey, setLoadingKey] = useState(false);
  const [showOnlyMistakes, setShowOnlyMistakes] = useState(false);
  const [expandedExplanation, setExpandedExplanation] = useState(null); // e.g. 'l-5' or 'r-12'

  // Rubric scores state (dual-task: Task 1 = TA/CC/LR/GRA, Task 2 = TR/CC/LR/GRA)
  const [rubricTask1, setRubricTask1] = useState({ ta: 6.0, cc: 6.0, lr: 6.0, gra: 6.0 });
  const [rubricTask2, setRubricTask2] = useState({ tr: 6.0, cc: 6.0, lr: 6.0, gra: 6.0 });
  const [activeTaskTab, setActiveTaskTab] = useState('task1');
  const [feedbackText, setFeedbackText] = useState('');
  const [releaseImmediately, setReleaseImmediately] = useState(true);

  // Search & Filter States
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [integrityFilter, setIntegrityFilter] = useState('all');
  const [groupFilter, setGroupFilter] = useState('all');

  // Speaking
  const [speakingSubmissions, setSpeakingSubmissions] = useState([]);
  const [activeSection, setActiveSection] = useState('writing'); // 'writing' | 'speaking' | 'feedback'
  const [expandedSpeaking, setExpandedSpeaking] = useState(null);

  // Essay feedback: draft with the model, edit, approve, then print.
  const [fbTestId, setFbTestId] = useState('');
  const [fbTaskType, setFbTaskType] = useState('task2');
  const [fbModel, setFbModel] = useState('claude-haiku-4-5');
  const [fbList, setFbList] = useState(null);
  const [fbLoading, setFbLoading] = useState(false);
  const [fbBatchRunning, setFbBatchRunning] = useState(false);
  const [fbNotice, setFbNotice] = useState('');
  const [fbExpanded, setFbExpanded] = useState(null);   // submissionId being edited
  const [fbDraftText, setFbDraftText] = useState('');
  const [fbBusyId, setFbBusyId] = useState(null);       // per-row spinner

  // Speaking Edit Modal State
  const [editingSpeakingSub, setEditingSpeakingSub] = useState(null);
  const [editFluency, setEditFluency] = useState(6.0);
  const [editLexical, setEditLexical] = useState(6.0);
  const [editGrammar, setEditGrammar] = useState(6.0);
  const [editPronunciation, setEditPronunciation] = useState(6.0);
  const [editFeedbackText, setEditFeedbackText] = useState('');

  // IELTS Band Descriptor guide lookup
  const descriptors = {
    ta: {
      9: "Fully addresses all parts of the task. Presents a fully developed response.",
      8.5: "Fully addresses task requirements with natural, well-supported progression.",
      8: "Sufficiently addresses all parts of the task. Presents a well-developed response with relevant details.",
      7.5: "Addresses all parts of the task with clear details and strong supporting evidence.",
      7: "Addresses all parts of the task. Clear overview and well-selected details.",
      6.5: "Addresses the requirements, with a clear focus, though some aspects are more fully covered than others.",
      6: "Addresses the requirements of the task, though some details may be irrelevant or incorrect.",
      5.5: "Partially addresses task requirements, but lacks detail or focus in certain parts.",
      5: "Only partially addresses the requirements. Key features may be missing or inadequately covered.",
      4.5: "Attempts to address the task but key features are highly unclear or repetitive.",
      4: "Attempts to address the task but fails to provide a clear overview or relevant details.",
      3.5: "Extremely limited response. Major task elements are completely unaddressed.",
      3: "Response is barely relevant, mostly off-topic or extremely short.",
      2.5: "Extremely minimal or disjointed response.",
      2: "Barely attempts the task. Content is unrelated.",
      1.5: "Extremely fragmented words.",
      1: "Answer is completely irrelevant or copy-pasted prompt.",
      0: "No task response provided."
    },
    cc: {
      9: "Uses cohesion in such a way that it attracts no attention. Skillfully manages paragraphing.",
      8.5: "Exceptional cohesion, natural structure, seamless paragraph transitions.",
      8: "Sequences information and ideas logically. Uses a wide range of cohesive devices appropriately.",
      7.5: "Logical progression throughout, clear paragraphing with minor errors in cohesive devices.",
      7: "Logically organizes information and ideas. Clear progression throughout.",
      6.5: "Clear progression, although cohesion and reference devices may occasionally be repetitive.",
      6: "Arranges information and ideas coherently. Paragraphing may not be logical.",
      5.5: "Coherence is present but relationships between ideas are sometimes disjointed.",
      5: "Presents information with some organization but lacks overall progression.",
      4.5: "Frequent mistakes in paragraphing, progression is difficult to follow.",
      4: "Presents information without logical organization. Paragraphing is absent or confusing.",
      3.5: "Lack of paragraphing, highly disorganized ideas.",
      3: "Extremely hard to follow, ideas are mostly disconnected.",
      2.5: "Coherence is completely absent.",
      2: "Extremely disjointed words.",
      1.5: "Fails to communicate a cohesive message.",
      1: "Fails to organize any coherent sentences.",
      0: "No coherent structure."
    },
    lr: {
      9: "Uses a wide range of vocabulary with natural and sophisticated control. Rare minor slips.",
      8.5: "Very broad lexical resource, natural collocation, extremely rare slips.",
      8: "Uses a wide range of vocabulary. Uses uncommon lexical items fluently with occasional errors.",
      7.5: "Sufficiently wide vocabulary with clear flexibility and precise word choices.",
      7: "Uses a sufficient range of vocabulary to allow flexibility. Uses some less common lexical items.",
      6.5: "Adequate vocabulary with some attempts at advanced style and minor errors.",
      6: "Uses an adequate range of vocabulary. Makes some errors in spelling and/or word formation.",
      5.5: "Vocabulary is limited but sufficient to express basic ideas. Frequent errors.",
      5: "Uses a limited range of vocabulary. Spelling/word formation errors may cause some difficulty.",
      4.5: "Limited vocabulary causes regular communication difficulties.",
      4: "Uses only basic vocabulary. Frequent errors cause major communication barriers.",
      3.5: "Vocabulary is highly insufficient, severe spelling errors.",
      3: "Extremely limited words.",
      2.5: "Only isolated words.",
      2: "Extremely poor word choice.",
      1.5: "Fails to demonstrate basic vocabulary.",
      1: "Barely writes single words.",
      0: "No vocabulary resource demonstrated."
    },
    gra: {
      9: "Uses a wide range of structures with full flexibility and accuracy. Rare minor slips.",
      8.5: "Excellent sentence variety, flawless grammar with extremely minor slips.",
      8: "Uses a wide range of structures. Most sentences are error-free.",
      7.5: "Produces frequent error-free sentences with diverse complex structures.",
      7: "Uses a variety of complex structures. Produces frequent error-free sentences.",
      6.5: "Good mix of complex sentences with minor errors that do not affect communication.",
      6: "Uses a mix of simple and complex sentence forms. Some grammatical errors occur.",
      5.5: "Frequent grammatical mistakes, complex structures often result in errors.",
      5: "Uses only a limited range of structures. Grammatical errors are frequent.",
      4.5: "Errors predominate, making comprehension difficult in most sentences.",
      4: "Uses basic structures. Errors predominate and grammar causes difficulty.",
      3.5: "Frequent errors block communication completely.",
      3: "Extremely basic or broken structures.",
      2.5: "Fails to construct simple sentences.",
      2: "Only a few basic words.",
      1.5: "No sentence grammar.",
      1: "Extremely fragmented structure.",
      0: "No grammatical range demonstrated."
    }
  };

  useEffect(() => {
    fetchSubmissions();
  }, []);

  useEffect(() => {
    if (selectedSub) {
      loadAnswerKey(selectedSub);
    } else {
      setAnswerKey(null);
    }
  }, [selectedSub]);

  const loadAnswerKey = async (sub) => {
    setLoadingKey(true);
    try {
      let answersObj = {};
      let displayObj = {};

      if (sub.listening_data) {
        try {
          const lData = typeof sub.listening_data === 'string' ? JSON.parse(sub.listening_data) : sub.listening_data;
          if (lData.sections) {
            lData.sections.forEach(sec => {
              (sec.questions || []).forEach(q => {
                if (q.id && q.answer !== undefined) {
                  const val = Array.isArray(q.answer) ? q.answer : [String(q.answer)];
                  answersObj['l' + q.id] = val;
                  displayObj['l' + q.id] = Array.isArray(q.answer) ? q.answer.join(' / ') : String(q.answer);
                }
              });
            });
          }
        } catch {}
      }

      if (sub.reading_data) {
        try {
          const rData = typeof sub.reading_data === 'string' ? JSON.parse(sub.reading_data) : sub.reading_data;
          if (rData.passages) {
            rData.passages.forEach(pass => {
              (pass.questions || []).forEach(q => {
                if (q.id && q.answer !== undefined) {
                  const val = Array.isArray(q.answer) ? q.answer : [String(q.answer)];
                  answersObj['r' + q.id] = val;
                  displayObj['r' + q.id] = Array.isArray(q.answer) ? q.answer.join(' / ') : String(q.answer);
                }
              });
            });
          }
        } catch {}
      }

      if (Object.keys(answersObj).length === 0) {
        let iframeUrl = `/tests/mock${sub.test_id}.html`;
        const res = await fetch(iframeUrl);
        if (res.ok) {
          const html = await res.text();
          const lMatch = html.match(/const\s+listeningAnswerKey\s*=\s*({[\s\S]*?});/);
          const rMatch = html.match(/const\s+readingAnswerKey\s*=\s*({[\s\S]*?});/);

          if (lMatch) {
            try {
              const lKey = JSON.parse(lMatch[1]);
              for (let q = 1; q <= 40; q++) {
                const val = lKey[q] || lKey[String(q)];
                if (val !== undefined) {
                  const arr = Array.isArray(val) ? val : [String(val)];
                  answersObj['l' + q] = arr;
                  displayObj['l' + q] = Array.isArray(val) ? val.join(' / ') : String(val);
                }
              }
            } catch(e) {}
          }

          if (rMatch) {
            try {
              const rKey = JSON.parse(rMatch[1]);
              for (let q = 1; q <= 40; q++) {
                const val = rKey[q] || rKey[String(q)];
                if (val !== undefined) {
                  const arr = Array.isArray(val) ? val : [String(val)];
                  answersObj['r' + q] = arr;
                  displayObj['r' + q] = Array.isArray(val) ? val.join(' / ') : String(val);
                }
              }
            } catch(e) {}
          }
        }
      }

      if (Object.keys(answersObj).length > 0) {
        setAnswerKey({ answers: answersObj, display: displayObj });
      } else {
        setAnswerKey(null);
      }
    } catch (err) {
      console.error('Failed to load answer key:', err);
      setAnswerKey(null);
    } finally {
      setLoadingKey(false);
    }
  };

  const fetchSubmissions = async () => {
    setLoading(true);
    try {
      const [subRes, spkRes] = await Promise.all([
        fetch('/api/teacher/submissions'),
        fetch('/api/teacher/speaking')
      ]);
      if (!subRes.ok) throw new Error('Failed to fetch submissions list');
      const data = await subRes.json();
      setSubmissions(data);
      if (spkRes.ok) setSpeakingSubmissions(await spkRes.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectSubmission = async (listSub) => {
    if (!listSub) return;
    // The list no longer carries the per-question detail -- it is the bulk of
    // that response and is only needed for the paper actually being opened, so
    // it is fetched here. Falls back to the list row if the fetch fails, which
    // still gives the writing grading view rather than nothing.
    let sub = listSub;
    try {
      const res = await fetch(`/api/teacher/submission/${listSub.id}`);
      if (res.ok) sub = await res.json();
    } catch {
      // keep listSub
    }
    let parsedWriting = sub.writing_answers;
    if (typeof parsedWriting === 'string') {
      try { parsedWriting = JSON.parse(parsedWriting); } catch(_) { parsedWriting = { task1: String(sub.writing_answers || ''), task2: '' }; }
    }
    if (!parsedWriting || typeof parsedWriting !== 'object') parsedWriting = { task1: '', task2: '' };

    let parsedListening = sub.listening_answers;
    if (typeof parsedListening === 'string') {
      try { parsedListening = JSON.parse(parsedListening); } catch(_) { parsedListening = {}; }
    }
    if (!parsedListening || typeof parsedListening !== 'object') parsedListening = {};

    let parsedReading = sub.reading_answers;
    if (typeof parsedReading === 'string') {
      try { parsedReading = JSON.parse(parsedReading); } catch(_) { parsedReading = {}; }
    }
    if (!parsedReading || typeof parsedReading !== 'object') parsedReading = {};

    let parsedRubric = sub.writing_scores;
    if (typeof parsedRubric === 'string') {
      try { parsedRubric = JSON.parse(parsedRubric); } catch(_) { parsedRubric = null; }
    }

    let parsedListeningDetail = sub.listening_detail;
    if (typeof parsedListeningDetail === 'string') {
      try { parsedListeningDetail = JSON.parse(parsedListeningDetail); } catch(_) { parsedListeningDetail = null; }
    }

    let parsedReadingDetail = sub.reading_detail;
    if (typeof parsedReadingDetail === 'string') {
      try { parsedReadingDetail = JSON.parse(parsedReadingDetail); } catch(_) { parsedReadingDetail = null; }
    }

    const cleanSub = {
      ...sub,
      writing_answers: parsedWriting,
      listening_answers: parsedListening,
      reading_answers: parsedReading,
      listening_detail: parsedListeningDetail,
      reading_detail: parsedReadingDetail,
    };

    setSelectedSub(cleanSub);
    // A Reading- or Listening-only paper has nothing to grade, so open straight
    // on the per-question review rather than an empty writing rubric.
    setViewMode(hasWritingTask(cleanSub) ? 'grading' : 'detailed_review');
    // Open on a task this test actually sets, so a Task-2-only submission does
    // not present an empty Task 1 rubric as the thing to grade.
    setActiveTaskTab(sub?.test_writing_data?.task1?.prompt || !sub?.test_writing_data?.task2?.prompt ? 'task1' : 'task2');
    if (parsedRubric && typeof parsedRubric === 'object') {
      if (parsedRubric.task1 && parsedRubric.task2) {
        setRubricTask1({
          ta: Number(parsedRubric.task1.ta) || 6.0,
          cc: Number(parsedRubric.task1.cc) || 6.0,
          lr: Number(parsedRubric.task1.lr) || 6.0,
          gra: Number(parsedRubric.task1.gra) || 6.0,
        });
        setRubricTask2({
          tr: Number(parsedRubric.task2.tr) || 6.0,
          cc: Number(parsedRubric.task2.cc) || 6.0,
          lr: Number(parsedRubric.task2.lr) || 6.0,
          gra: Number(parsedRubric.task2.gra) || 6.0,
        });
      } else {
        // Backwards compat: old single-rubric submission
        const taVal = Number(parsedRubric.ta) || 6.0;
        const ccVal = Number(parsedRubric.cc) || 6.0;
        const lrVal = Number(parsedRubric.lr) || 6.0;
        const graVal = Number(parsedRubric.gra) || 6.0;
        setRubricTask1({ ta: taVal, cc: ccVal, lr: lrVal, gra: graVal });
        setRubricTask2({ tr: taVal, cc: ccVal, lr: lrVal, gra: graVal });
      }
    } else {
      setRubricTask1({ ta: 6.0, cc: 6.0, lr: 6.0, gra: 6.0 });
      setRubricTask2({ tr: 6.0, cc: 6.0, lr: 6.0, gra: 6.0 });
    }
    setFeedbackText(sub.teacher_feedback || '');
    setReleaseImmediately(sub.is_revealed === 1);
  };

  // Which tasks this submission's test actually sets. A Task-2-only test (e.g.
  // the "Day N" files) must not demand a Task 1 grade: the rubric defaults to
  // 6.0 across the board, and at 33% weight that quietly drags the student's
  // Writing band toward 6 no matter what they actually wrote for Task 2.
  const subHasTask1 = !!selectedSub?.test_writing_data?.task1?.prompt;
  const subHasTask2 = !!selectedSub?.test_writing_data?.task2?.prompt;
  // Fall back to showing both only for an older submission that has writing but
  // no stored prompts. A Reading- or Listening-only paper has no writing at all,
  // and must not be given two empty rubrics to grade.
  // Copying an essay out to mark it elsewhere was a select-and-drag job over a
  // scrolling box, which is easy to clip halfway through. The button takes the
  // whole thing, and says so afterwards, so there is no doubt it copied.
  const [copiedLabel, setCopiedLabel] = useState('');
  const copyEssay = async (label, text) => {
    const essay = String(text || '').trim();
    if (!essay) return;
    try {
      await navigator.clipboard.writeText(essay);
    } catch {
      // Clipboard access can be refused (an insecure origin, or a browser that
      // wants a fresher gesture). Fall back rather than silently doing nothing.
      const scratch = document.createElement('textarea');
      scratch.value = essay;
      scratch.style.position = 'fixed';
      scratch.style.opacity = '0';
      document.body.appendChild(scratch);
      scratch.select();
      try { document.execCommand('copy'); } catch { /* nothing more to try */ }
      document.body.removeChild(scratch);
    }
    setCopiedLabel(label);
    setTimeout(() => setCopiedLabel(''), 2000);
  };


  // Deleting a student's paper is not undoable, so the confirmation names the
  // student and says what happens next rather than asking a generic 'are you
  // sure?'. The server refuses released or already-marked papers regardless.
  // Takes the submission to delete, so it works from a card in the pending list
  // as well as from the paper currently open for marking.
  const handleDeletePendingSubmission = async (submission) => {
    const target = submission || selectedSub;
    if (!target) return;
    const who = target.student_name || target.student_id;
    const ok = window.confirm(
      'Delete ' + who + '\'s submission for "' + target.test_title + '"?\n\n' +
      'Their answers will be permanently removed and the test will be put back on their list to sit again.\n\n' +
      'This cannot be undone.'
    );
    if (!ok) return;
    try {
      const res = await fetch('/api/teacher/submissions/' + target.id + '/delete', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not delete this submission');
      setSelectedSub(null);
      fetchSubmissions();
    } catch (err) {
      alert(err.message);
    }
  };
  // ---- Essay feedback -------------------------------------------------------
  const loadFeedbackList = async (testId = fbTestId, taskType = fbTaskType) => {
    if (!testId) { setFbList(null); return; }
    setFbLoading(true);
    setFbNotice('');
    try {
      const res = await fetch('/api/teacher/tests/' + testId + '/feedback?taskType=' + taskType);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load feedback');
      setFbList(data);
    } catch (err) {
      setFbNotice(err.message);
      setFbList(null);
    } finally {
      setFbLoading(false);
    }
  };

  const handleDraftOne = async (row) => {
    setFbBusyId(row.submissionId);
    setFbNotice('');
    try {
      const res = await fetch('/api/teacher/submissions/' + row.submissionId + '/draft-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskType: fbTaskType, model: fbModel })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not draft feedback');
      await loadFeedbackList();
    } catch (err) {
      setFbNotice(err.message);
    } finally {
      setFbBusyId(null);
    }
  };

  // The batch is sequential on the server and a class takes several minutes, so
  // the button stays disabled with a warning rather than looking idle.
  const handleDraftBatch = async () => {
    if (!fbTestId || !fbList) return;
    const todo = fbList.students.filter(s => s.hasEssay && !s.feedback).length;
    if (!todo) { setFbNotice('Every essay on this paper already has a draft.'); return; }
    const ok = window.confirm(
      'Draft feedback for ' + todo + ' essay' + (todo === 1 ? '' : 's') + ' on "' + fbList.test + '"?\n\n' +
      'This takes roughly ' + Math.max(1, Math.round(todo * 12 / 60)) + ' minute(s) and calls the API once per essay.\n' +
      'Essays that already have a draft are left alone.'
    );
    if (!ok) return;

    setFbBatchRunning(true);
    setFbNotice('Drafting ' + todo + ' essays — leave this tab open.');
    try {
      const res = await fetch('/api/teacher/tests/' + fbTestId + '/draft-feedback-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskType: fbTaskType, model: fbModel })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Batch failed');
      setFbNotice('Drafted ' + data.drafted + ' · skipped ' + data.skipped + (data.failed ? ' · failed ' + data.failed : ''));
      await loadFeedbackList();
    } catch (err) {
      setFbNotice(err.message);
    } finally {
      setFbBatchRunning(false);
    }
  };

  const handleSaveFeedback = async (row, approve) => {
    const text = fbDraftText.trim();
    if (!text) { setFbNotice('Feedback cannot be empty.'); return; }
    setFbBusyId(row.submissionId);
    try {
      const res = await fetch('/api/teacher/submissions/' + row.submissionId + '/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback: text, approved: approve })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save');
      setFbNotice(approve ? 'Approved ' + row.student + '.' : 'Saved ' + row.student + '.');
      setFbExpanded(null);
      await loadFeedbackList();
    } catch (err) {
      setFbNotice(err.message);
    } finally {
      setFbBusyId(null);
    }
  };

  const subHasAnyWriting = !!(selectedSub?.writing_answers?.task1 || selectedSub?.writing_answers?.task2)
    || subHasTask1 || subHasTask2;
  const gradeTask1 = subHasTask1 || (subHasAnyWriting && !subHasTask1 && !subHasTask2);
  const gradeTask2 = subHasTask2 || (subHasAnyWriting && !subHasTask1 && !subHasTask2);

  const roundIeltsBand = (avg) => {
    const decimal = avg - Math.floor(avg);
    if (decimal < 0.25) return Math.floor(avg);
    if (decimal < 0.75) return Math.floor(avg) + 0.5;
    return Math.ceil(avg);
  };

  const handleTask1Change = (key, value) => {
    setRubricTask1(prev => ({ ...prev, [key]: parseFloat(value) }));
  };

  const handleTask2Change = (key, value) => {
    setRubricTask2(prev => ({ ...prev, [key]: parseFloat(value) }));
  };

  const calculateTask1Band = () => {
    const avg = (rubricTask1.ta + rubricTask1.cc + rubricTask1.lr + rubricTask1.gra) / 4;
    return roundIeltsBand(avg);
  };

  const calculateTask2Band = () => {
    const avg = (rubricTask2.tr + rubricTask2.cc + rubricTask2.lr + rubricTask2.gra) / 4;
    return roundIeltsBand(avg);
  };

  const calculateLiveOverall = () => {
    const t1 = calculateTask1Band();
    const t2 = calculateTask2Band();
    // Only weight the tasks the test actually sets, otherwise a missing task's
    // default rubric would count as a real score.
    if (!gradeTask1) return t2;
    if (!gradeTask2) return t1;
    return roundIeltsBand((t1 * 1 + t2 * 2) / 3);
  };

  const handleSaveGrade = async (e) => {
    e.preventDefault();
    if (!selectedSub) return;

    try {
      // 1. Submit the scores & feedback
      const gradeRes = await fetch(`/api/teacher/grade/${selectedSub.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Only store the tasks this test actually sets, so a Task-2-only test
          // does not save an untouched default Task 1 rubric that the student
          // would then see presented as a real Task 1 band.
          writingScores: {
            ...(gradeTask1 ? { task1: rubricTask1, task1Band: calculateTask1Band() } : {}),
            ...(gradeTask2 ? { task2: rubricTask2, task2Band: calculateTask2Band() } : {})
          },
          teacherFeedback: feedbackText,
          gradedBy: user.id
        })
      });

      if (!gradeRes.ok) throw new Error('Failed to save rubric scores');
      const gradeData = await gradeRes.json();

      // 2. Submit the reveal toggle status
      const revealRes = await fetch(`/api/teacher/reveal/${selectedSub.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isRevealed: releaseImmediately })
      });
      if (!revealRes.ok) throw new Error('Failed to set score visibility status');

      alert(`Submission successfully graded! Overall Writing Band: ${gradeData.writingScore.toFixed(1)}`);
      setSelectedSub(null);
      fetchSubmissions();
    } catch (err) {
      alert(err.message);
    }
  };

  // Prefers server-harvested per-question detail (works for every
  // harvest-bridge iframe test -- Full Mock Test 1, Prediction Mock Test 10,
  // any standalone Reading/Listening test) over the legacy answerKey scraping
  // mechanism, which only ever worked for the old single-file mock1-9
  // templates and silently showed nothing for anything else. Falls back to
  // answerKey only when the submission has no server-provided detail at all
  // (older submissions from before this was tracked).
  const renderReviewColumn = (detail, prefix, rawAnswers) => {
    const usingServerDetail = !!detail;
    if (!usingServerDetail && !answerKey) {
      return (
        <p style={{ color: 'var(--text-secondary)', padding: '1rem' }}>
          {loadingKey ? 'Extracting answer keys from mock test file...' : 'Answer key details could not be found.'}
        </p>
      );
    }

    const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const moduleKey = prefix === 'l' ? 'listening' : 'reading';

    return (
      <table style={styles.reviewTable}>
        <thead>
          <tr>
            <th style={styles.reviewTh}>Q</th>
            <th style={styles.reviewTh}>Student Answer</th>
            <th style={styles.reviewTh}>Correct Key</th>
            <th style={styles.reviewTh}>Status</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 40 }, (_, idx) => {
            const qNum = idx + 1;
            let studentAns, displayCorrect, isOk, explanationHtml;

            if (usingServerDetail) {
              const d = detail[qNum];
              if (!d) return null;
              studentAns = d.userAnswer || '';
              displayCorrect = d.correctAnswer ?? '—';
              isOk = !!d.isCorrect;
              explanationHtml = d.explanationHtml;
            } else {
              studentAns = rawAnswers?.[qNum] || '';
              const correctArr = answerKey.answers[prefix + qNum] || [];
              displayCorrect = answerKey.display[prefix + qNum] || correctArr.join(' / ') || '—';
              isOk = correctArr.some((ans) => norm(ans) === norm(studentAns));
            }

            if (showOnlyMistakes && isOk) return null;
            const explanationKey = `${prefix}-${qNum}`;
            const isExpanded = expandedExplanation === explanationKey;

            return (
              <React.Fragment key={qNum}>
                <tr
                  onClick={() => explanationHtml && setExpandedExplanation(isExpanded ? null : explanationKey)}
                  style={{
                    borderBottom: isExpanded ? 'none' : '1px solid var(--glass-border)',
                    cursor: explanationHtml ? 'pointer' : 'default',
                    backgroundColor: isOk
                      ? 'rgba(16, 185, 129, 0.04)'
                      : studentAns
                        ? 'rgba(244, 63, 94, 0.04)'
                        : 'rgba(148, 163, 184, 0.04)'
                  }}
                >
                  <td style={styles.reviewTd}><strong>{qNum}</strong></td>
                  <td style={styles.reviewTd}>{studentAns || '—'}</td>
                  <td style={styles.reviewTd}>{displayCorrect}</td>
                  <td style={{ ...styles.reviewTd, color: isOk ? '#10b981' : studentAns ? '#f43f5e' : '#94a3b8', fontWeight: 'bold' }}>
                    {isOk ? '✓ Correct' : studentAns ? '✗ Wrong' : '— Empty'}
                    {explanationHtml && (isExpanded ? ' ▲' : ' ▼ Why?')}
                  </td>
                </tr>
                {isExpanded && explanationHtml && (
                  <tr style={{ borderBottom: '1px solid var(--glass-border)' }}>
                    <td colSpan={4} style={{ padding: '0.75rem 0.5rem', backgroundColor: 'var(--bg-tertiary)' }}>
                      <div
                        className={`ielts-explanation-${moduleKey}`}
                        style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}
                        dangerouslySetInnerHTML={{ __html: explanationHtml }}
                      />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    );
  };

  const handleCopyReport = () => {
    if (!selectedSub || !answerKey) return;
    
    const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const isCorrect = (studentAns, correctAnswersArr) => {
      if (!correctAnswersArr || !correctAnswersArr.length) return false;
      const sNorm = norm(studentAns);
      return correctAnswersArr.some(ans => norm(ans) === sNorm);
    };

    let report = `IELTS Mock Test Center — Performance Report\n`;
    report += `==================================================\n`;
    report += `Candidate ID: ${selectedSub.student_id}\n`;
    report += `Candidate Name: ${selectedSub.student_name}\n`;
    report += `Test Title: ${selectedSub.test_title}\n\n`;
    
    report += `BAND SCORES OVERVIEW:\n`;
    report += `- Listening Score: Band ${fmtScore(selectedSub.listening_score)}\n`;
    report += `- Reading Score: Band ${fmtScore(selectedSub.reading_score)}\n`;
    if (selectedSub.writing_score !== null) {
      report += `- Writing Score: Band ${fmtScore(selectedSub.writing_score)}\n`;
    }
    report += `- Exam Integrity: ${selectedSub.violations_count || 0} Tab switches / Fullscreen exits detected\n`;
    report += `\nINCORRECT & MISSED ANSWERS FEEDBACK:\n\n`;
    
    report += `[🎧 LISTENING SECTION ERRORS]\n`;
    let lErrors = 0;
    for (let i = 1; i <= 40; i++) {
      const studentAns = selectedSub.listening_answers[i] || '';
      const correctArr = answerKey.answers['l' + i] || [];
      const correctText = answerKey.display['l' + i] || correctArr.join(' / ') || '—';
      if (!isCorrect(studentAns, correctArr)) {
        lErrors++;
        report += `Q${i}: Student: "${studentAns || '—'}" | Correct: "${correctText}"\n`;
      }
    }
    if (lErrors === 0) report += `Perfect score in Listening section!\n`;
    report += `\n`;

    report += `[📖 READING SECTION ERRORS]\n`;
    let rErrors = 0;
    for (let i = 1; i <= 40; i++) {
      const studentAns = selectedSub.reading_answers[i] || '';
      const correctArr = answerKey.answers['r' + i] || [];
      const correctText = answerKey.display['r' + i] || correctArr.join(' / ') || '—';
      if (!isCorrect(studentAns, correctArr)) {
        rErrors++;
        report += `Q${i}: Student: "${studentAns || '—'}" | Correct: "${correctText}"\n`;
      }
    }
    if (rErrors === 0) report += `Perfect score in Reading section!\n`;
    
    navigator.clipboard.writeText(report);
    alert('Detailed performance report successfully copied to clipboard!');
  };

  const handleDownloadDetailedReviewPdf = () => {
    if (!selectedSub) return;
    try {
      generateDetailedReviewPdf({
        studentName: selectedSub.student_name,
        studentId: selectedSub.student_id,
        testTitle: selectedSub.test_title,
        submittedAt: selectedSub.submitted_at,
        listeningScore: selectedSub.listening_score,
        readingScore: selectedSub.reading_score,
        listeningDetail: selectedSub.listening_detail,
        readingDetail: selectedSub.reading_detail,
        listeningAnswers: selectedSub.listening_answers,
        readingAnswers: selectedSub.reading_answers,
        answerKey,
      });
    } catch (err) {
      alert('Could not generate PDF: ' + err.message);
    }
  };

  const handleCopyScoresOnly = () => {
    if (!selectedSub) return;
    
    let report = `IELTS Mock Test Center — Performance Report\n`;
    report += `==================================================\n`;
    report += `Candidate ID: ${selectedSub.student_id}\n`;
    report += `Candidate Name: ${selectedSub.student_name}\n`;
    report += `Test Title: ${selectedSub.test_title}\n\n`;
    
    report += `BAND SCORES OVERVIEW:\n`;
    report += `- Listening Score: Band ${fmtScore(selectedSub.listening_score)}\n`;
    report += `- Reading Score: Band ${fmtScore(selectedSub.reading_score)}\n`;
    if (selectedSub.writing_score !== null) {
      report += `- Writing Score: Band ${fmtScore(selectedSub.writing_score)}\n`;
      
      const overallVal = ((selectedSub.listening_score + selectedSub.reading_score + selectedSub.writing_score) / 3);
      const decimal = overallVal - Math.floor(overallVal);
      let roundedOverall = Math.floor(overallVal);
      if (decimal >= 0.25 && decimal < 0.75) roundedOverall += 0.5;
      else if (decimal >= 0.75) roundedOverall += 1.0;
      report += `- Overall Score: Band ${roundedOverall.toFixed(1)}\n`;
    } else {
      const overallVal = ((selectedSub.listening_score + selectedSub.reading_score) / 2);
      const decimal = overallVal - Math.floor(overallVal);
      let roundedOverall = Math.floor(overallVal);
      if (decimal >= 0.25 && decimal < 0.75) roundedOverall += 0.5;
      else if (decimal >= 0.75) roundedOverall += 1.0;
      report += `- Overall Score: Band ${roundedOverall.toFixed(1)} (Listening & Reading only)\n`;
    }
    report += `- Exam Integrity: ${selectedSub.violations_count || 0} Tab switches / Fullscreen exits detected\n`;
    if (selectedSub.teacher_feedback) {
      report += `\nTeacher Feedback:\n${selectedSub.teacher_feedback}\n`;
    }
    
    navigator.clipboard.writeText(report);
    alert('Band scores summary successfully copied to clipboard!');
  };

  const toggleRevealStatus = async (subId, currentStatus) => {
    try {
      const res = await fetch(`/api/teacher/reveal/${subId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isRevealed: !currentStatus })
      });
      if (!res.ok) throw new Error('Failed to toggle score reveal state');
      fetchSubmissions();
    } catch (err) {
      alert(err.message);
    }
  };

  const calculateAverageClassBand = () => {
    const graded = filteredSubmissions.filter(s => s.writing_score !== null);
    if (graded.length === 0) return 'N/A';
    const sum = graded.reduce((acc, s) => {
      const overallVal = (s.listening_score + s.reading_score + s.writing_score) / 3;
      const decimal = overallVal - Math.floor(overallVal);
      let roundedOverall = Math.floor(overallVal);
      if (decimal >= 0.25 && decimal < 0.75) roundedOverall += 0.5;
      else if (decimal >= 0.75) roundedOverall += 1.0;
      return acc + roundedOverall;
    }, 0);
    return (sum / graded.length).toFixed(1);
  };

  const downloadPdfReport = (sub) => {
    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const M = 14, W = 182;
      const now = new Date(sub.submitted_at);

      // Title header band
      doc.setFillColor(99, 102, 241); // indigo
      doc.rect(0, 0, 210, 20, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(14);
      doc.text('IELTS MOCK EXAM ASSESSMENT REPORT', M, 13);

      doc.setTextColor(20, 20, 20);
      doc.setFontSize(16);
      doc.text(sub.test_title || 'IELTS Mock Test', M, 35);
      doc.setDrawColor(226, 232, 240);
      doc.line(M, 38, 210 - M, 38);

      // Student info table
      doc.setFontSize(10);
      doc.setFont('helvetica', 'bold');
      doc.text('Candidate Name:', M, 48);
      doc.setFont('helvetica', 'normal');
      doc.text(sub.student_name, M + 40, 48);

      doc.setFont('helvetica', 'bold');
      doc.text('Candidate ID:', M, 55);
      doc.setFont('helvetica', 'normal');
      doc.text(sub.student_id, M + 40, 55);

      doc.setFont('helvetica', 'bold');
      doc.text('Date of Submission:', M, 62);
      doc.setFont('helvetica', 'normal');
      doc.text(now.toLocaleString(), M + 40, 62);

      doc.setFont('helvetica', 'bold');
      doc.text('Proctoring Log:', M, 69);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(sub.violations_count > 0 ? 239 : 16, sub.violations_count > 0 ? 68 : 185, sub.violations_count > 0 ? 68 : 129);
      doc.text(sub.violations_count > 0 ? `${sub.violations_count} Tab switches/focus losses detected` : 'Clean session (No proctoring warnings)', M + 40, 69);
      doc.setTextColor(20, 20, 20);

      // Score grid banner
      doc.setFillColor(248, 250, 252);
      doc.rect(M, 78, W, 22, 'F');
      doc.rect(M, 78, W, 22);

      const overallVal = ((sub.listening_score + sub.reading_score + (sub.writing_score || 0)) / (sub.writing_score !== null ? 3 : 2));
      const decimal = overallVal - Math.floor(overallVal);
      let roundedOverall = Math.floor(overallVal);
      if (decimal >= 0.25 && decimal < 0.75) roundedOverall += 0.5;
      else if (decimal >= 0.75) roundedOverall += 1.0;

      // Section scores
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(100, 116, 139);
      doc.text('LISTENING', M + 15, 85);
      doc.text('READING', M + 55, 85);
      doc.text('WRITING', M + 95, 85);
      doc.text('OVERALL BAND', M + 140, 85);

      doc.setFontSize(16);
      doc.setTextColor(15, 23, 42);
      doc.text(fmtScore(sub.listening_score), M + 22, 94);
      doc.text(fmtScore(sub.reading_score), M + 62, 94);
      doc.text(sub.writing_score !== null ? fmtScore(sub.writing_score) : 'Pending', M + 102, 94);
      doc.setTextColor(99, 102, 241);
      doc.text(roundedOverall.toFixed(1), M + 148, 94);

      doc.setTextColor(20, 20, 20);
      let y = 112;

      // Writing criteria breakdown if available
      if (sub.writing_scores) {
        const scores = JSON.parse(sub.writing_scores);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.text('Writing Criteria breakdown:', M, y);
        y += 6;

        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        doc.text(`Task Response / Achievement:  ${scores.ta.toFixed(1)}`, M + 5, y);
        doc.text(`Coherence & Cohesion:  ${scores.cc.toFixed(1)}`, M + 95, y);
        y += 6;
        doc.text(`Lexical Resource (Vocabulary):  ${scores.lr.toFixed(1)}`, M + 5, y);
        doc.text(`Grammatical Range & Accuracy:  ${scores.gra.toFixed(1)}`, M + 95, y);
        y += 12;
      }

      // Teacher feedback
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text('Teacher Summary Feedback & Advice:', M, y);
      y += 6;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(50, 50, 50);
      const feedbackLines = doc.splitTextToSize(sub.teacher_feedback || 'No feedback details entered yet.', W - 10);
      for (const line of feedbackLines) {
        if (y > 275) {
          doc.addPage();
          y = 20;
        }
        doc.text(line, M + 5, y);
        y += 5;
      }
      y += 8;

      // Student Essays
      doc.setTextColor(20, 20, 20);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text('Submitted Essays:', M, y);
      y += 8;

      const essays = JSON.parse(sub.writing_answers || '{}');
      
      // Task 1
      doc.setFontSize(9.5);
      doc.text('Writing Task 1:', M + 2, y);
      y += 6;
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(70, 70, 70);
      const t1Lines = doc.splitTextToSize(essays.task1 || '[No response submitted]', W - 10);
      for (const line of t1Lines) {
        if (y > 275) {
          doc.addPage();
          y = 20;
        }
        doc.text(line, M + 5, y);
        y += 5;
      }
      y += 8;

      // Task 2
      doc.setTextColor(20, 20, 20);
      doc.setFont('helvetica', 'bold');
      doc.text('Writing Task 2:', M + 2, y);
      y += 6;
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(70, 70, 70);
      const t2Lines = doc.splitTextToSize(essays.task2 || '[No response submitted]', W - 10);
      for (const line of t2Lines) {
        if (y > 275) {
          doc.addPage();
          y = 20;
        }
        doc.text(line, M + 5, y);
        y += 5;
      }

      // Page footer numbers
      const totalPages = doc.internal.getNumberOfPages();
      for (let p = 1; p <= totalPages; p++) {
        doc.setPage(p);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(150, 150, 150);
        doc.text(`Page ${p} of ${totalPages}`, 210 - M, 287, { align: 'right' });
      }

      doc.save(`IELTS_Report_${sub.student_name.replace(/[^a-zA-Z0-9]/g, '_')}_Mock${sub.test_id}.pdf`);
    } catch (err) {
      console.error('PDF generation failed:', err);
      alert('Could not download PDF report: ' + err.message);
    }
  };

  const getWordCount = (text) => {
    if (!text) return 0;
    return text.trim().split(/\s+/).filter(w => w.length > 0).length;
  };

  const bandOptions = [0, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0];

  const safeSubmissions = Array.isArray(submissions) ? submissions : [];
  const safeSpeakingSubmissions = Array.isArray(speakingSubmissions) ? speakingSubmissions : [];
  const studentGroups = [...new Set(safeSubmissions.map(s => s.student_group).filter(Boolean))];

  // A submission only needs essay grading if its test actually has a Writing
  // component. Standalone Listening/Reading-only tests never do, so they're
  // ready to release the moment they're submitted -- they shouldn't sit
  // stuck in "Pending" waiting for an essay that will never exist.
  const hasWritingTask = (sub) => !!(sub.test_writing_data?.task1?.prompt || sub.test_writing_data?.task2?.prompt);
  const isReadyToRelease = (sub) => sub.writing_score !== null || !hasWritingTask(sub);

  // Dynamic filter logic
  const filteredSubmissions = safeSubmissions.filter(sub => {
    const matchesSearch = sub.student_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          sub.student_id.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          sub.test_title.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus = statusFilter === 'all' ||
                          (statusFilter === 'pending' && !isReadyToRelease(sub)) ||
                          (statusFilter === 'graded' && isReadyToRelease(sub));

    const matchesIntegrity = integrityFilter === 'all' ||
                              (integrityFilter === 'clean' && (sub.violations_count || 0) === 0) ||
                              (integrityFilter === 'flagged' && (sub.violations_count || 0) > 0);

    const matchesGroup = groupFilter === 'all' || sub.student_group === groupFilter;

    return matchesSearch && matchesStatus && matchesIntegrity && matchesGroup;
  });

  const pendingSubmissions = filteredSubmissions.filter(s => !isReadyToRelease(s));
  const gradedSubmissions = filteredSubmissions.filter(s => isReadyToRelease(s));

  return (
    <div style={styles.dashboardLayout}>
      <header style={styles.header}>
        <div style={styles.headerTitle}>
          <h2>IELTS <span>Mock Portal</span></h2>
          <span style={styles.badge}>Teacher Assessment Suite</span>
        </div>
        <div style={styles.userInfo}>
          <div style={styles.userMeta}>
            <span style={styles.userName}>{user.name}</span>
            <span style={styles.userId}>Assessor Profile</span>
          </div>
                    {onSwitchRole && (
            <button 
              onClick={onSwitchRole}
              className="btn btn-secondary"
              style={{ marginRight: '0.75rem', fontSize: '0.85rem', padding: '0.4rem 0.8rem' }}
              title="Switch to Admin Dashboard"
            >
              🛡️ Admin View
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
          <div style={styles.loadingContainer}>Loading student papers...</div>
        ) : selectedSub ? (
          /* GRADING WORKSPACE SCREEN */
          <div style={styles.gradingWorkspace}>
            <div style={styles.workspaceHeader}>
              <div>
                <button onClick={() => setSelectedSub(null)} className="btn btn-secondary" style={{ marginBottom: '0.5rem' }}>
                  ← Back to Submissions
                </button>
                <h3 style={{ color: 'var(--text-primary)' }}>Grading: {selectedSub.student_name} ({selectedSub.student_id})</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.25rem', flexWrap: 'wrap' }}>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Test paper: {selectedSub.test_title}</span>
                  {selectedSub.violations_count > 0 ? (
                    <span style={{ backgroundColor: 'var(--color-rose)', color: '#ffffff', fontSize: '0.75rem', fontWeight: 'bold', padding: '0.2rem 0.5rem', borderRadius: '4px', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                      ⚠️ {selectedSub.violations_count} Tab Switches
                    </span>
                  ) : (
                    <span style={{ backgroundColor: 'var(--color-emerald)', color: '#ffffff', fontSize: '0.75rem', fontWeight: 'bold', padding: '0.2rem 0.5rem', borderRadius: '4px', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                      🔒 Integrity Verified
                    </span>
                  )}
                </div>
              </div>
              {hasWritingTask(selectedSub) && (
                <div style={styles.liveScoreBadge}>
                  <span style={styles.liveScoreNum}>{calculateLiveOverall().toFixed(1)}</span>
                  <span style={styles.liveScoreLabel}>Live Writing Band</span>
                </div>
              )}
            </div>

            {/* View Mode Tabs. The writing tab is offered only when the test
                actually sets a Writing task -- otherwise it leads to an empty
                rubric that grades nothing. */}
            <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', userSelect: 'none' }}>
              {hasWritingTask(selectedSub) && (
              <button
                onClick={() => setViewMode('grading')}
                className="btn"
                style={{
                  ...styles.tabBtn,
                  backgroundColor: viewMode === 'grading' ? 'var(--color-indigo)' : 'var(--bg-secondary)',
                  color: viewMode === 'grading' ? '#ffffff' : 'var(--text-primary)',
                  border: '1px solid var(--glass-border)',
                }}
              >
                ✏️ Grade Writing Tasks
              </button>
              )}
              <button
                onClick={() => setViewMode('detailed_review')}
                className="btn"
                style={{
                  ...styles.tabBtn,
                  backgroundColor: viewMode === 'detailed_review' ? 'var(--color-indigo)' : 'var(--bg-secondary)',
                  color: viewMode === 'detailed_review' ? '#ffffff' : 'var(--text-primary)',
                  border: '1px solid var(--glass-border)',
                }}
              >
                📊 Detailed Listening & Reading Review
              </button>
            </div>

            {viewMode === 'grading' ? (
              <div style={styles.workspaceGrid}>
                {/* Left Essay Panel */}
                <div className="card" style={styles.essayPanel}>
                  <div style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '1rem', marginBottom: '1.5rem' }}>
                    <h4 style={{ color: 'var(--text-primary)' }}>Student Writing Answers</h4>
                  </div>

                  {/* Only offered while the paper is still pending: the server
                      refuses released or already-marked submissions anyway, so
                      showing it then would only produce a confusing error. */}
                  {!selectedSub?.is_revealed && selectedSub?.writing_score == null && (
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.75rem' }}>
                      <button
                        type="button"
                        onClick={handleDeletePendingSubmission}
                        className="btn btn-secondary"
                        style={{ fontSize: '0.75rem', padding: '0.35rem 0.7rem', color: '#f43f5e' }}
                      >
                        Delete this submission
                      </button>
                    </div>
                  )}

                  {gradeTask1 && (
                  <div style={styles.essayBox}>
                    <div style={styles.essayBoxHeader}>
                      <h5>Writing Task 1 Prompt:</h5>
                      <button type="button" onClick={() => copyEssay('Task 1', selectedSub?.writing_answers?.task1)} disabled={!(selectedSub?.writing_answers?.task1 || "").trim()} className="btn btn-secondary" style={{ fontSize: '0.75rem', padding: '0.35rem 0.7rem' }}>{copiedLabel === 'Task 1' ? 'Copied' : 'Copy essay'}</button>
                    </div>
                    <p style={styles.writingPrompt}>Refer to Task 1 instructions assigned in this test.</p>

                    <h5 style={{ color: 'var(--text-secondary)', marginTop: '1rem', marginBottom: '0.5rem' }}>Student Essay (Word count: {getWordCount((selectedSub?.writing_answers?.task1 || ""))}):</h5>
                    <div style={styles.rawEssayText}>{(selectedSub?.writing_answers?.task1 || "") || "No answer submitted"}</div>
                  </div>
                  )}

                  {gradeTask2 && (
                  <div style={{ ...styles.essayBox, marginTop: gradeTask1 ? '2rem' : 0 }}>
                    <div style={styles.essayBoxHeader}>
                      <h5>Writing Task 2 Prompt:</h5>
                      <button type="button" onClick={() => copyEssay('Task 2', selectedSub?.writing_answers?.task2)} disabled={!(selectedSub?.writing_answers?.task2 || "").trim()} className="btn btn-secondary" style={{ fontSize: '0.75rem', padding: '0.35rem 0.7rem' }}>{copiedLabel === 'Task 2' ? 'Copied' : 'Copy essay'}</button>
                    </div>
                    <p style={styles.writingPrompt}>Refer to Task 2 instructions assigned in this test.</p>
                    
                    <h5 style={{ color: 'var(--text-secondary)', marginTop: '1rem', marginBottom: '0.5rem' }}>Student Essay (Word count: {getWordCount((selectedSub?.writing_answers?.task2 || ""))}):</h5>
                    <div style={styles.rawEssayText}>{(selectedSub?.writing_answers?.task2 || "") || "No answer submitted"}</div>
                  </div>
                  )}
                </div>

                {/* Right Grading Panel */}
                <form onSubmit={handleSaveGrade} className="card" style={styles.gradingPanel}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '0.75rem' }}>
                    <h4 style={{ color: 'var(--text-primary)', margin: 0 }}>IELTS Writing Rubric Assessment</h4>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: '600' }}>
                      {gradeTask1 && gradeTask2 ? 'Task 1 (33%) + Task 2 (67%)' : (gradeTask2 ? 'Task 2 only (100%)' : 'Task 1 only (100%)')}
                    </span>
                  </div>

                                    {/* Task 1 / Task 2 Tab Toggle */}
                  <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem', backgroundColor: 'rgba(0,0,0,0.2)', padding: '0.25rem', borderRadius: '6px' }}>
                    {gradeTask1 && (
                    <button
                      type="button"
                      onClick={() => setActiveTaskTab('task1')}
                      style={{
                        flex: 1, padding: '0.5rem 0.75rem', border: 'none', borderRadius: '4px',
                        fontWeight: '600', fontSize: '0.85rem', cursor: 'pointer',
                        backgroundColor: activeTaskTab === 'task1' ? '#2563eb' : 'transparent',
                        color: activeTaskTab === 'task1' ? '#ffffff' : '#94a3b8', transition: 'all 0.2s'
                      }}
                    >
                      📝 Task 1 — Band {calculateTask1Band().toFixed(1)} {gradeTask2 ? '(33%)' : '(100%)'}
                    </button>
                    )}
                    {gradeTask2 && (
                    <button
                      type="button"
                      onClick={() => setActiveTaskTab('task2')}
                      style={{
                        flex: 1, padding: '0.5rem 0.75rem', border: 'none', borderRadius: '4px',
                        fontWeight: '600', fontSize: '0.85rem', cursor: 'pointer',
                        backgroundColor: activeTaskTab === 'task2' ? '#2563eb' : 'transparent',
                        color: activeTaskTab === 'task2' ? '#ffffff' : '#94a3b8', transition: 'all 0.2s'
                      }}
                    >
                      ✍️ Task 2 — Band {calculateTask2Band().toFixed(1)} {gradeTask1 ? '(67%)' : '(100%)'}
                    </button>
                    )}
                  </div>

                  {activeTaskTab === 'task1' ? (
                    <div style={styles.rubricGrid}>
                      <div className="form-group" style={{ display: 'flex', flexDirection: 'column' }}>
                        <label className="form-label">Task Achievement (TA) — Task 1</label>
                        <select className="form-input" value={rubricTask1.ta} onChange={(e) => handleTask1Change('ta', e.target.value)}>
                          {bandOptions.map(val => (<option key={val} value={val}>Band {val.toFixed(1)}</option>))}
                        </select>
                        <p style={styles.descriptorHint}>💡 {descriptors.ta[(rubricTask1.ta || 6.0).toString()] || "No descriptor found."}</p>
                      </div>
                      <div className="form-group" style={{ display: 'flex', flexDirection: 'column' }}>
                        <label className="form-label">Coherence & Cohesion (CC)</label>
                        <select className="form-input" value={rubricTask1.cc} onChange={(e) => handleTask1Change('cc', e.target.value)}>
                          {bandOptions.map(val => (<option key={val} value={val}>Band {val.toFixed(1)}</option>))}
                        </select>
                        <p style={styles.descriptorHint}>💡 {descriptors.cc[(rubricTask1.cc || 6.0).toString()] || "No descriptor found."}</p>
                      </div>
                      <div className="form-group" style={{ display: 'flex', flexDirection: 'column' }}>
                        <label className="form-label">Lexical Resource (LR)</label>
                        <select className="form-input" value={rubricTask1.lr} onChange={(e) => handleTask1Change('lr', e.target.value)}>
                          {bandOptions.map(val => (<option key={val} value={val}>Band {val.toFixed(1)}</option>))}
                        </select>
                        <p style={styles.descriptorHint}>💡 {descriptors.lr[(rubricTask1.lr || 6.0).toString()] || "No descriptor found."}</p>
                      </div>
                      <div className="form-group" style={{ display: 'flex', flexDirection: 'column' }}>
                        <label className="form-label">Grammatical Range & Accuracy (GRA)</label>
                        <select className="form-input" value={rubricTask1.gra} onChange={(e) => handleTask1Change('gra', e.target.value)}>
                          {bandOptions.map(val => (<option key={val} value={val}>Band {val.toFixed(1)}</option>))}
                        </select>
                        <p style={styles.descriptorHint}>💡 {descriptors.gra[(rubricTask1.gra || 6.0).toString()] || "No descriptor found."}</p>
                      </div>
                    </div>
                  ) : (
                    <div style={styles.rubricGrid}>
                      <div className="form-group" style={{ display: 'flex', flexDirection: 'column' }}>
                        <label className="form-label">Task Response (TR) — Task 2</label>
                        <select className="form-input" value={rubricTask2.tr} onChange={(e) => handleTask2Change('tr', e.target.value)}>
                          {bandOptions.map(val => (<option key={val} value={val}>Band {val.toFixed(1)}</option>))}
                        </select>
                        <p style={styles.descriptorHint}>💡 {descriptors.ta[(rubricTask2.tr || 6.0).toString()] || "No descriptor found."}</p>
                      </div>
                      <div className="form-group" style={{ display: 'flex', flexDirection: 'column' }}>
                        <label className="form-label">Coherence & Cohesion (CC)</label>
                        <select className="form-input" value={rubricTask2.cc} onChange={(e) => handleTask2Change('cc', e.target.value)}>
                          {bandOptions.map(val => (<option key={val} value={val}>Band {val.toFixed(1)}</option>))}
                        </select>
                        <p style={styles.descriptorHint}>💡 {descriptors.cc[(rubricTask2.cc || 6.0).toString()] || "No descriptor found."}</p>
                      </div>
                      <div className="form-group" style={{ display: 'flex', flexDirection: 'column' }}>
                        <label className="form-label">Lexical Resource (LR)</label>
                        <select className="form-input" value={rubricTask2.lr} onChange={(e) => handleTask2Change('lr', e.target.value)}>
                          {bandOptions.map(val => (<option key={val} value={val}>Band {val.toFixed(1)}</option>))}
                        </select>
                        <p style={styles.descriptorHint}>💡 {descriptors.lr[(rubricTask2.lr || 6.0).toString()] || "No descriptor found."}</p>
                      </div>
                      <div className="form-group" style={{ display: 'flex', flexDirection: 'column' }}>
                        <label className="form-label">Grammatical Range & Accuracy (GRA)</label>
                        <select className="form-input" value={rubricTask2.gra} onChange={(e) => handleTask2Change('gra', e.target.value)}>
                          {bandOptions.map(val => (<option key={val} value={val}>Band {val.toFixed(1)}</option>))}
                        </select>
                        <p style={styles.descriptorHint}>💡 {descriptors.gra[(rubricTask2.gra || 6.0).toString()] || "No descriptor found."}</p>
                      </div>
                    </div>
                  )}

                  {/* Live Score Summary Bar */}
                  <div style={{ backgroundColor: 'rgba(37,99,235,0.08)', border: '1px solid rgba(37,99,235,0.25)', borderRadius: '6px', padding: '0.6rem 1rem', marginTop: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                    <div style={{ fontSize: '0.83rem', color: 'var(--text-secondary)' }}>
                      {gradeTask1 && gradeTask2 ? (
                        <>Task 1: <strong>Band {calculateTask1Band().toFixed(1)}</strong> (33%) &nbsp;|&nbsp; Task 2: <strong>Band {calculateTask2Band().toFixed(1)}</strong> (67%)</>
                      ) : gradeTask2 ? (
                        <>Task 2: <strong>Band {calculateTask2Band().toFixed(1)}</strong> (100% &mdash; this test sets no Task 1)</>
                      ) : (
                        <>Task 1: <strong>Band {calculateTask1Band().toFixed(1)}</strong> (100% &mdash; this test sets no Task 2)</>
                      )}
                    </div>
                    <div style={{ fontSize: '0.95rem', fontWeight: 'bold', color: '#2563eb' }}>
                      Overall Writing: Band {calculateLiveOverall().toFixed(1)}
                    </div>
                  </div>

                  <div className="form-group" style={{ marginTop: '1rem' }}>
                    <label className="form-label">🎧 Listening Calculated Band (Reference)</label>
                    <input type="text" className="form-input" value={`Band ${fmtScore(selectedSub.listening_score)}`} disabled style={{ opacity: 0.6 }} />
                  </div>

                  <div className="form-group">
                    <label className="form-label">📖 Reading Calculated Band (Reference)</label>
                    <input type="text" className="form-input" value={`Band ${fmtScore(selectedSub.reading_score)}`} disabled style={{ opacity: 0.6 }} />
                  </div>

                  <div className="form-group" style={{ marginTop: '1.5rem' }}>
                    <label className="form-label">Teacher Written Comments & Advice</label>
                    <textarea 
                      className="form-input"
                      style={{ height: '140px', resize: 'none', lineHeight: '1.5' }}
                      placeholder="Write detailed recommendations on how the student can improve vocabulary, coherence, and grammar patterns..."
                      value={feedbackText}
                      onChange={(e) => setFeedbackText(e.target.value)}
                      required
                    />
                  </div>

                  <div className="form-group" style={styles.toggleRow}>
                    <label style={styles.toggleLabel}>
                      <input 
                        type="checkbox"
                        checked={releaseImmediately} 
                        onChange={(e) => setReleaseImmediately(e.target.checked)}
                      />
                      <span>Release Scores and Feedback to Student Dashboard immediately</span>
                    </label>
                  </div>

                  <button 
                    type="submit" 
                    className="btn btn-success" 
                    style={{ width: '100%', justifyContent: 'center', marginTop: '1.5rem' }}
                  >
                    💾 Save and Finalize Grades
                  </button>
                </form>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%' }}>
                <div style={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'center', userSelect: 'none' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.95rem', fontWeight: '600' }}>
                    <input 
                      type="checkbox" 
                      checked={showOnlyMistakes} 
                      onChange={(e) => setShowOnlyMistakes(e.target.checked)} 
                    />
                    <span>⚠️ Show only incorrect or empty answers</span>
                  </label>
                </div>
                <div style={styles.workspaceGrid}>
                  {/* Listening Column */}
                  <div className="card" style={{ maxHeight: '78vh', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ borderBottom: '1px solid var(--glass-border)', paddingBottom: '1rem', marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <h4 style={{ color: 'var(--text-primary)' }}>🎧 Listening Overview</h4>
                      <span style={{ fontSize: '1.1rem', fontWeight: 'bold', color: '#6366f1' }}>
                        Band {fmtScore(selectedSub.listening_score)}
                      </span>
                    </div>
                    
                    <div style={{ overflowY: 'auto', flex: 1 }}>
                      {renderReviewColumn(selectedSub.listening_detail, 'l', selectedSub.listening_answers)}
                    </div>
                  </div>

                  {/* Reading Column */}
                  <div className="card" style={{ maxHeight: '78vh', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ borderBottom: '1px solid var(--glass-border)', paddingBottom: '1rem', marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <h4 style={{ color: 'var(--text-primary)' }}>📖 Reading Overview</h4>
                      <span style={{ fontSize: '1.1rem', fontWeight: 'bold', color: '#10b981' }}>
                        Band {fmtScore(selectedSub.reading_score)}
                      </span>
                    </div>
                    
                    <div style={{ overflowY: 'auto', flex: 1 }}>
                      {renderReviewColumn(selectedSub.reading_detail, 'r', selectedSub.reading_answers)}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem', marginTop: '1.25rem' }}>
                      <button
                        onClick={handleDownloadDetailedReviewPdf}
                        className="btn btn-primary"
                        style={{ width: '100%', justifyContent: 'center' }}
                        title="Downloads the same per-question review shown here as a PDF. The student can download this same report themselves from their own dashboard once results are released."
                      >
                        📄 Download Detailed PDF Report
                      </button>
                      <button
                        onClick={handleCopyScoresOnly}
                        className="btn btn-secondary"
                        style={{ width: '100%', justifyContent: 'center', backgroundColor: 'var(--text-secondary)', borderColor: 'var(--text-secondary)' }}
                      >
                        📋 Copy Band Scores Summary
                      </button>
                      {answerKey && (
                        <button 
                          onClick={handleCopyReport}
                          className="btn btn-success"
                          style={{ width: '100%', justifyContent: 'center' }}
                        >
                          🔍 Copy Detailed Report (with L & R Errors)
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          /* MAIN LISTINGS VIEW */
          <>
            {/* Section Tabs */}
            <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem' }}>
              {[['writing', '✏️ Writing Submissions'], ['speaking', '🎙️ Speaking Submissions'], ['feedback', '📝 Essay Feedback']].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setActiveSection(key)}
                  className="btn"
                  style={{
                    padding: '0.5rem 1.1rem',
                    borderRadius: '8px',
                    border: '1px solid var(--glass-border)',
                    backgroundColor: activeSection === key ? 'var(--color-indigo)' : 'var(--bg-secondary)',
                    // White only while this tab is the indigo one. The inactive
                    // tab sits on --bg-secondary, which is white in light mode,
                    // so fixed white left its label invisible -- the Speaking tab
                    // showed nothing but its microphone.
                    color: activeSection === key ? '#fff' : 'var(--text-primary)',
                    fontWeight: activeSection === key ? '700' : '400',
                    fontSize: '0.9rem',
                    cursor: 'pointer',
                    transition: 'all 0.2s'
                  }}
                >
                  {label}
                  {key === 'speaking' && safeSpeakingSubmissions.filter(s => !s.is_revealed).length > 0 && (
                    <span style={{ marginLeft: '0.5rem', backgroundColor: '#f43f5e', borderRadius: '10px', padding: '0.1rem 0.45rem', fontSize: '0.75rem', fontWeight: '800' }}>
                      {safeSpeakingSubmissions.filter(s => !s.is_revealed).length}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Essay Feedback Panel */}
            {activeSection === 'feedback' && (() => {
              // Papers the teacher can act on, newest first, deduped by test.
              const papers = [];
              const seen = new Set();
              [...submissions].reverse().forEach(s => {
                if (s.test_id && !seen.has(s.test_id)) { seen.add(s.test_id); papers.push({ id: s.test_id, title: s.test_title }); }
              });
              const rows = fbList?.students || [];
              const withEssay = rows.filter(r => r.hasEssay);
              const drafted = withEssay.filter(r => r.feedback);
              const approved = withEssay.filter(r => r.approved);
              const chip = (bg, fg, text) => (
                <span style={{ backgroundColor: bg, color: fg, fontSize: '0.72rem', padding: '0.15rem 0.5rem', borderRadius: '4px', fontWeight: '700', whiteSpace: 'nowrap' }}>{text}</span>
              );

              return (
                <div>
                  <div className="card" style={{ marginBottom: '1.25rem' }}>
                    <h4 style={{ color: 'var(--text-primary)', marginTop: 0, marginBottom: '0.35rem', fontSize: '1.05rem', fontWeight: 'bold' }}>
                      📝 Draft, edit and print essay feedback
                    </h4>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: 0, marginBottom: '1rem' }}>
                      The model writes a first draft in your feedback style. Nothing reaches a student until you approve it.
                    </p>

                    <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', flex: '1 1 260px' }}>
                        <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Test paper</span>
                        <select
                          value={fbTestId}
                          onChange={(e) => { setFbTestId(e.target.value); setFbExpanded(null); loadFeedbackList(e.target.value, fbTaskType); }}
                          style={{ ...styles.dropdownInput, width: '100%' }}
                        >
                          <option value="">Choose a paper…</option>
                          {papers.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
                        </select>
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', flex: '0 1 150px' }}>
                        <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Task</span>
                        <select
                          value={fbTaskType}
                          onChange={(e) => { setFbTaskType(e.target.value); setFbExpanded(null); loadFeedbackList(fbTestId, e.target.value); }}
                          style={{ ...styles.dropdownInput, width: '100%' }}
                        >
                          <option value="task2">Task 2</option>
                          <option value="task1">Task 1</option>
                        </select>
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', flex: '0 1 190px' }}>
                        <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Model</span>
                        <select value={fbModel} onChange={(e) => setFbModel(e.target.value)} style={{ ...styles.dropdownInput, width: '100%' }}>
                          <option value="claude-haiku-4-5">Haiku — fast, cheap</option>
                          <option value="claude-sonnet-5">Sonnet — balanced</option>
                          <option value="claude-opus-5">Opus — deepest</option>
                        </select>
                      </label>
                    </div>

                    {fbList && (
                      <>
                        <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', marginTop: '1rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                          <span><strong style={{ color: 'var(--text-primary)' }}>{withEssay.length}</strong> essays</span>
                          <span><strong style={{ color: 'var(--text-primary)' }}>{drafted.length}</strong> drafted</span>
                          <span><strong style={{ color: '#10b981' }}>{approved.length}</strong> approved</span>
                        </div>
                        <div style={{ display: 'flex', gap: '0.65rem', flexWrap: 'wrap', marginTop: '1rem' }}>
                          <button
                            onClick={handleDraftBatch}
                            className="btn btn-primary"
                            disabled={fbBatchRunning || fbLoading}
                            style={{ opacity: fbBatchRunning ? 0.6 : 1 }}
                          >
                            {fbBatchRunning ? '⏳ Drafting the class…' : '✨ Draft the whole class'}
                          </button>
                          <button
                            onClick={() => window.open('/api/teacher/tests/' + fbTestId + '/feedback-print?includeDrafts=true', '_blank')}
                            className="btn btn-secondary"
                            disabled={!drafted.length}
                          >
                            🖨️ Proof all as PDF
                          </button>
                          <button
                            onClick={() => window.open('/api/teacher/tests/' + fbTestId + '/feedback-print', '_blank')}
                            className="btn btn-success"
                            disabled={!approved.length}
                            title="Only the feedback you have approved"
                          >
                            📄 Approved sheets as PDF
                          </button>
                          <button onClick={() => loadFeedbackList()} className="btn btn-secondary" disabled={fbLoading}>↻ Refresh</button>
                        </div>
                      </>
                    )}

                    {fbNotice && (
                      <div style={{ marginTop: '0.9rem', padding: '0.6rem 0.85rem', borderRadius: '8px', backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontSize: '0.85rem' }}>
                        {fbNotice}
                      </div>
                    )}
                  </div>

                  {fbLoading && <div className="card" style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>Loading…</div>}

                  {!fbLoading && !fbList && (
                    <div className="card" style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
                      <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>📝</div>
                      <p>Choose a test paper above to see its essays.</p>
                    </div>
                  )}

                  {!fbLoading && fbList && rows.map(row => {
                    const isOpen = fbExpanded === row.submissionId;
                    const busy = fbBusyId === row.submissionId;
                    return (
                      <div className="card" key={row.submissionId} style={{ marginBottom: '0.85rem', borderLeft: `4px solid ${row.approved ? '#10b981' : row.feedback ? '#6366f1' : 'var(--glass-border)'}` }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                          <div style={{ flex: 1, minWidth: '200px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                              <strong style={{ color: 'var(--text-primary)', fontSize: '0.98rem' }}>{row.student}</strong>
                              {row.band && chip('rgba(99,102,241,0.15)', '#6366f1', 'Band ' + row.band)}
                              {row.approved
                                ? chip('rgba(16,185,129,0.15)', '#10b981', '✅ Approved')
                                : row.feedback ? chip('rgba(245,158,11,0.15)', '#f59e0b', '⏳ Draft') : null}
                              {row.edited && !row.approved && chip('rgba(99,102,241,0.10)', 'var(--text-secondary)', 'edited')}
                            </div>
                            <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginTop: '0.2rem' }}>
                              {row.group ? row.group + ' · ' : ''}{row.hasEssay ? row.words + ' words' : 'no essay submitted'}
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                            {row.hasEssay && !row.feedback && (
                              <button onClick={() => handleDraftOne(row)} className="btn btn-primary" disabled={busy} style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}>
                                {busy ? '⏳' : '✨ Draft'}
                              </button>
                            )}
                            {row.feedback && (
                              <button
                                onClick={() => { setFbExpanded(isOpen ? null : row.submissionId); setFbDraftText(row.feedback); }}
                                className="btn btn-secondary"
                                style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}
                              >
                                {isOpen ? 'Close' : (row.approved ? '👁️ Review' : '✏️ Edit & approve')}
                              </button>
                            )}
                          </div>
                        </div>

                        {isOpen && (
                          <div style={{ marginTop: '1rem', borderTop: '1px solid var(--glass-border)', paddingTop: '1rem' }}>
                            {row.essay && (
                              <details style={{ marginBottom: '0.85rem' }}>
                                <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '0.85rem', fontWeight: 600 }}>
                                  Show the student's essay
                                </summary>
                                <div style={{ marginTop: '0.6rem', padding: '0.85rem', backgroundColor: 'var(--bg-tertiary)', borderRadius: '8px', color: 'var(--text-primary)', fontSize: '0.88rem', lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: '260px', overflowY: 'auto' }}>
                                  {row.essay}
                                </div>
                              </details>
                            )}
                            <textarea
                              value={fbDraftText}
                              onChange={(e) => setFbDraftText(e.target.value)}
                              rows={20}
                              spellCheck={false}
                              style={{
                                width: '100%', padding: '0.85rem', borderRadius: '8px',
                                border: '1px solid var(--glass-border)', backgroundColor: 'var(--bg-secondary)',
                                color: 'var(--text-primary)', fontSize: '0.88rem', lineHeight: 1.6,
                                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', resize: 'vertical'
                              }}
                            />
                            <div style={{ display: 'flex', gap: '0.6rem', marginTop: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
                              <button onClick={() => handleSaveFeedback(row, true)} className="btn btn-success" disabled={busy}>
                                {busy ? '⏳' : '✅ Save & approve'}
                              </button>
                              <button onClick={() => handleSaveFeedback(row, false)} className="btn btn-secondary" disabled={busy}>
                                💾 Save as draft
                              </button>
                              <button
                                onClick={() => { navigator.clipboard.writeText(fbDraftText); setFbNotice('Copied ' + row.student + '’s feedback.'); }}
                                className="btn btn-secondary"
                              >
                                📋 Copy
                              </button>
                              {row.model && (
                                <span style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', marginLeft: 'auto' }}>drafted by {row.model}</span>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            {/* Speaking Submissions Panel */}
            {activeSection === 'speaking' && (
              <div>
                {speakingSubmissions.length === 0 ? (
                  <div className="card" style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
                    <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>🎙️</div>
                    <p>No speaking submissions yet. Assign speaking tests to students from the Admin Dashboard.</p>
                  </div>
                ) : safeSpeakingSubmissions.map(ss => {
                  const fb = (() => { try { return JSON.parse(ss.ai_feedback || '{}'); } catch { return {}; } })();
                  const bandColor = (s) => s >= 7.5 ? '#10b981' : s >= 6.0 ? '#6366f1' : s >= 4.5 ? '#f59e0b' : '#f43f5e';
                  const isExpanded = expandedSpeaking === ss.id;
                  return (
                    <div className="card" key={ss.id} style={{ marginBottom: '1.25rem', borderLeft: `4px solid ${ss.is_revealed ? '#10b981' : '#6366f1'}` }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                            <strong style={{ color: 'var(--text-primary)', fontSize: '1rem' }}>{ss.student_name}</strong>
                            <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>({ss.student_id})</span>
                            <span style={{ backgroundColor: ss.is_revealed ? 'rgba(16,185,129,0.15)' : 'rgba(99,102,241,0.15)', color: ss.is_revealed ? '#10b981' : '#6366f1', fontSize: '0.75rem', padding: '0.15rem 0.5rem', borderRadius: '4px', fontWeight: '700' }}>
                              {ss.is_revealed ? '✅ Sent to Student' : '⏳ Pending'}
                            </span>
                          </div>
                          <div style={{ color: 'var(--text-secondary)', fontSize: '0.83rem', marginTop: '0.25rem' }}>
                            {ss.prompt_title} · {new Date(ss.submitted_at).toLocaleDateString()} · via {ss.ai_provider || 'AI'}
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                          <div style={{ display: 'flex', gap: '0.4rem' }}>
                            {[['F', ss.fluency_score], ['L', ss.lexical_score], ['G', ss.grammar_score], ['P', ss.pronunciation_score]].map(([l, s]) => (
                              <div key={l} style={{ textAlign: 'center', backgroundColor: 'var(--bg-tertiary)', borderRadius: '6px', padding: '0.25rem 0.4rem', minWidth: '36px' }}>
                                <div style={{ fontSize: '0.6rem', color: 'var(--text-secondary)' }}>{l}</div>
                                <div style={{ fontSize: '0.9rem', fontWeight: '800', color: bandColor(s) }}>{fmtScore(s)}</div>
                              </div>
                            ))}
                            <div style={{ textAlign: 'center', backgroundColor: 'rgba(99,102,241,0.1)', borderRadius: '6px', padding: '0.25rem 0.4rem', minWidth: '44px', border: '1px solid rgba(99,102,241,0.3)' }}>
                              <div style={{ fontSize: '0.6rem', color: 'var(--text-secondary)' }}>OVR</div>
                              <div style={{ fontSize: '0.9rem', fontWeight: '900', color: bandColor(ss.overall_score) }}>{fmtScore(ss?.overall_score)}</div>
                            </div>
                          </div>
                          <button
                            onClick={() => {
                              setEditingSpeakingSub(ss);
                              setEditFluency(ss.fluency_score || 6.0);
                              setEditLexical(ss.lexical_score || 6.0);
                              setEditGrammar(ss.grammar_score || 6.0);
                              setEditPronunciation(ss.pronunciation_score || 6.0);
                              const fbObj = (() => { try { return JSON.parse(ss.ai_feedback || '{}'); } catch { return {}; } })();
                              setEditFeedbackText(fbObj.overall || (typeof ss.ai_feedback === 'string' ? ss.ai_feedback : '') || '');
                            }}
                            className="btn btn-secondary"
                            style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}
                          >
                            ✏️ Grade / Edit
                          </button>
                          <button
                            onClick={() => setExpandedSpeaking(isExpanded ? null : ss.id)}
                            style={{ background: 'none', border: '1px solid var(--glass-border)', borderRadius: '6px', padding: '0.3rem 0.6rem', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '0.8rem' }}
                          >
                            {isExpanded ? 'Hide ▲' : 'Details ▼'}
                          </button>
                          {!ss.is_revealed && (
                            <button
                              onClick={async () => {
                                if (!confirm(`Send speaking results to ${ss.student_name}?`)) return;
                                await fetch(`/api/teacher/speaking/${ss.id}/send`, { method: 'POST' });
                                fetchSubmissions();
                              }}
                              className="btn btn-success"
                              style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}
                            >
                              📤 Send to Student
                            </button>
                          )}
                        </div>
                      </div>

                      {isExpanded && (
                        <div style={{ marginTop: '1.25rem', borderTop: '1px solid var(--glass-border)', paddingTop: '1.25rem' }}>
                          {fb.overall && (
                            <div style={{ backgroundColor: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: '8px', padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: '0.85rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                              <strong style={{ color: 'var(--text-primary)', fontStyle: 'normal' }}>📝 AI Overall Assessment:</strong><br/>{fb.overall}
                            </div>
                          )}
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '0.5rem', marginBottom: '1rem' }}>
                            {[['Fluency', 'fluency'], ['Lexical', 'lexical'], ['Grammar', 'grammar'], ['Pronunciation', 'pronunciation']].map(([label, key]) => (
                              <div key={key} style={{ backgroundColor: 'var(--bg-tertiary)', borderRadius: '6px', padding: '0.6rem 0.75rem', border: '1px solid var(--glass-border)' }}>
                                <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginBottom: '0.2rem' }}>{label}</div>
                                <div style={{ fontWeight: '800', fontSize: '1.1rem', color: bandColor(ss[`${key}_score`]) }}>{ss[`${key}_score`]?.toFixed(1)}</div>
                                {fb[key] && <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.3rem', lineHeight: 1.4 }}>{fb[key]}</div>}
                              </div>
                            ))}
                          </div>
                          {[
                            ['Part 1 Transcript & Audio', ss.part1_transcript, ss.part1_audio],
                            ['Part 2 Transcript & Audio', ss.part2_transcript, ss.part2_audio],
                            ['Part 3 Transcript & Audio', ss.part3_transcript, ss.part3_audio]
                          ].map(([title, text, audioUrl]) => (text || audioUrl) && (
                            <div key={title} style={{ marginBottom: '0.85rem' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                                <span style={{ fontSize: '0.78rem', fontWeight: '700', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{title}</span>
                                {audioUrl && (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                    <span style={{ fontSize: '0.75rem', color: '#10b981', fontWeight: '600' }}>🎧 Play Voice Audio:</span>
                                    <audio controls src={audioUrl} style={{ height: '28px', borderRadius: '4px', outline: 'none' }} />
                                  </div>
                                )}
                              </div>
                              {text && (
                                <div style={{ backgroundColor: 'var(--bg-tertiary)', borderRadius: '6px', padding: '0.75rem', fontSize: '0.83rem', color: 'var(--text-primary)', lineHeight: '1.6', whiteSpace: 'pre-wrap', border: '1px solid var(--glass-border)', maxHeight: '180px', overflowY: 'auto' }}>{text}</div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {activeSection === 'writing' && (
            <><div style={{ display: 'flex', flexDirection: 'column', gap: '2rem', marginBottom: '2.5rem' }}>
              {/* 1. Analytics Summary Row */}
              <div style={styles.statsRow}>
                <div className="card" style={styles.statCard}>
                  <span style={styles.statIcon}>⏳</span>
                  <div>
                    <h4 style={styles.statVal}>{pendingSubmissions.length}</h4>
                    <span style={styles.statLabel}>Pending Reviews</span>
                  </div>
                </div>
                <div className="card" style={styles.statCard}>
                  <span style={styles.statIcon}>✅</span>
                  <div>
                    <h4 style={styles.statVal}>{gradedSubmissions.length}</h4>
                    <span style={styles.statLabel}>Graded Portfolio</span>
                  </div>
                </div>
                <div className="card" style={styles.statCard}>
                  <span style={styles.statIcon}>📈</span>
                  <div>
                    <h4 style={styles.statVal}>{calculateAverageClassBand()}</h4>
                    <span style={styles.statLabel}>Avg Class Band</span>
                  </div>
                </div>
                <div className="card" style={styles.statCard}>
                  <span style={styles.statIcon}>⚠️</span>
                  <div>
                    <h4 style={styles.statVal}>{filteredSubmissions.reduce((acc, s) => acc + (s.violations_count || 0), 0)}</h4>
                    <span style={styles.statLabel}>Total Violations</span>
                  </div>
                </div>
              </div>

              {/* 2. Visualizations and Filters Container */}
              <div style={styles.vizAndFiltersPanel}>
                {/* Score Distribution Chart */}
                <div className="card" style={styles.chartCard}>
                  <h4 style={{ color: 'var(--text-primary)', marginBottom: '1rem', fontSize: '1.05rem', fontWeight: 'bold' }}>📊 Class Band Score Distribution</h4>
                  <div style={{ width: '100%', display: 'flex', justifyContent: 'center', height: '140px' }}>
                    {filteredSubmissions.filter(s => s.writing_score !== null).length === 0 ? (
                      <div style={{ color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, fontSize: '0.9rem', fontStyle: 'italic' }}>
                        No graded papers available for score distribution chart.
                      </div>
                    ) : (() => {
                      const scoreFreq = {};
                      for (let i = 4.0; i <= 9.0; i += 0.5) {
                        scoreFreq[i.toFixed(1)] = 0;
                      }
                      filteredSubmissions.filter(s => s.writing_score !== null).forEach(s => {
                        const overallVal = (s.listening_score + s.reading_score + s.writing_score) / 3;
                        const decimal = overallVal - Math.floor(overallVal);
                        let roundedOverall = Math.floor(overallVal);
                        if (decimal >= 0.25 && decimal < 0.75) roundedOverall += 0.5;
                        else if (decimal >= 0.75) roundedOverall += 1.0;
                        const key = roundedOverall.toFixed(1);
                        scoreFreq[key] = (scoreFreq[key] || 0) + 1;
                      });
                      const maxFreq = Math.max(...Object.values(scoreFreq), 1);
                      const bandKeys = Object.keys(scoreFreq).sort((a,b) => parseFloat(a) - parseFloat(b));

                      return (
                        <svg viewBox="0 0 500 130" style={{ width: '100%', height: '100%', overflow: 'visible' }}>
                          {bandKeys.map((key, i) => {
                            const freq = scoreFreq[key];
                            const barHeight = (freq / maxFreq) * 80;
                            const x = 30 + (i * 42);
                            const y = 95 - barHeight;
                            return (
                              <g key={key}>
                                {/* Bar with rounded top */}
                                <rect 
                                  x={x} 
                                  y={y} 
                                  width="26" 
                                  height={barHeight} 
                                  rx="3"
                                  fill={freq > 0 ? '#6366f1' : 'var(--bg-tertiary)'}
                                />
                                {/* Value label on top of bar */}
                                {freq > 0 && (
                                  <text 
                                    x={x + 13} 
                                    y={y - 4} 
                                    textAnchor="middle" 
                                    fontSize="8.5" 
                                    fontWeight="bold"
                                    fill="var(--text-primary)"
                                  >
                                    {freq}
                                  </text>
                                )}
                                {/* X-axis label */}
                                <text 
                                  x={x + 13} 
                                  y="112" 
                                  textAnchor="middle" 
                                  fontSize="8" 
                                  fontWeight="600"
                                  fill="var(--text-secondary)"
                                >
                                  {key}
                                </text>
                              </g>
                            );
                          })}
                          {/* Horizontal base line */}
                          <line x1="15" y1="98" x2="490" y2="98" stroke="var(--glass-border)" strokeWidth="1" />
                        </svg>
                      );
                    })()}
                  </div>
                </div>

                {/* Advanced Search & Filtering Bar */}
                <div className="card" style={styles.filtersCard}>
                  <h4 style={{ color: 'var(--text-primary)', marginBottom: '1rem', fontSize: '1.05rem', fontWeight: 'bold' }}>🔍 Search & Filters</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
                    <div style={styles.searchContainer}>
                      <input 
                        type="text" 
                        placeholder="Search student name, ID, or test paper..." 
                        value={searchTerm} 
                        onChange={(e) => setSearchTerm(e.target.value)}
                        style={styles.searchInput}
                      />
                    </div>
                    <div style={styles.dropdownsRow}>
                      <select 
                        value={statusFilter} 
                        onChange={(e) => setStatusFilter(e.target.value)}
                        style={styles.dropdownInput}
                      >
                        <option value="all">📁 All Statuses</option>
                        <option value="pending">⏳ Pending Reviews</option>
                        <option value="graded">✅ Graded Portfolios</option>
                      </select>
                      <select 
                        value={integrityFilter} 
                        onChange={(e) => setIntegrityFilter(e.target.value)}
                        style={styles.dropdownInput}
                      >
                        <option value="all">🛡️ All Integrity</option>
                        <option value="clean">🟢 Clean Sessions</option>
                        <option value="flagged">🔴 Proctoring Warnings</option>
                      </select>
                      <select 
                        value={groupFilter} 
                        onChange={(e) => setGroupFilter(e.target.value)}
                        style={styles.dropdownInput}
                      >
                        <option value="all">👥 All Groups</option>
                        {studentGroups.map(g => (
                          <option key={g} value={g}>👥 Group: {g}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div style={styles.dashboardGrid}>
            {/* Left Col: Pending Review */}
            <div>
              <h3 style={{ ...styles.columnTitle, color: '#f59e0b' }}>⏳ Pending Writing Reviews ({pendingSubmissions.length})</h3>
              {pendingSubmissions.length === 0 ? (
                <div className="card" style={styles.emptyCard}>
                  <p>✅ All submissions graded! High five!</p>
                </div>
              ) : (
                pendingSubmissions.map(sub => (
                  <div className="card" style={styles.subCard} key={sub.id}>
                    <div style={styles.subCardHeader}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <h4 style={styles.studentTitle}>{sub.student_name}</h4>
                        {sub.student_group && (
                          <span style={{ 
                            backgroundColor: 'rgba(99, 102, 241, 0.12)', 
                            color: '#6366f1', 
                            fontSize: '0.7rem', 
                            padding: '0.1rem 0.35rem', 
                            borderRadius: '4px', 
                            fontWeight: '600'
                          }}>
                            {sub.student_group}
                          </span>
                        )}
                      </div>
                      <span style={styles.subMeta}>ID: {sub.student_id} | {sub.test_title}</span>
                      <span style={styles.dateLabel}>{new Date(sub.submitted_at).toLocaleDateString()}</span>
                    </div>
                    <div style={styles.miniScoresRow}>
                      <span>🎧 Listening: <strong>{fmtScore(sub.listening_score)}</strong></span>
                      <span>📖 Reading: <strong>{fmtScore(sub.reading_score)}</strong></span>
                    </div>
                    <button 
                      onClick={() => handleSelectSubmission(sub)}
                      className="btn btn-primary"
                      style={{ marginTop: '1rem', width: '100%', justifyContent: 'center' }}
                    >
                      ✏️ Evaluate Essays
                    </button>
                    {/* Straight on the card: spoiled papers are spotted while
                        scanning this queue, not after opening one to mark it. */}
                    <button
                      onClick={() => handleDeletePendingSubmission(sub)}
                      className="btn btn-secondary"
                      style={{ marginTop: '0.5rem', width: '100%', justifyContent: 'center', fontSize: '0.75rem', color: '#f43f5e' }}
                    >
                      Delete this submission
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* Right Col: Graded & Released */}
            <div>
              <h3 style={{ ...styles.columnTitle, color: '#10b981' }}>📊 Graded & Released Portfolio ({gradedSubmissions.length})</h3>
              {gradedSubmissions.length === 0 ? (
                <div className="card" style={styles.emptyCard}>
                  <p>No graded test portfolio found. Begin grading student writing to populate.</p>
                </div>
              ) : (
                gradedSubmissions.map(sub => (
                  <div className="card" style={styles.subCard} key={sub.id}>
                    <div style={styles.subCardHeader}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <h4 style={styles.studentTitle}>{sub.student_name}</h4>
                        {sub.student_group && (
                          <span style={{ 
                            backgroundColor: 'rgba(99, 102, 241, 0.12)', 
                            color: '#6366f1', 
                            fontSize: '0.7rem', 
                            padding: '0.1rem 0.35rem', 
                            borderRadius: '4px', 
                            fontWeight: '600'
                          }}>
                            {sub.student_group}
                          </span>
                        )}
                      </div>
                      <span style={styles.subMeta}>ID: {sub.student_id} | {sub.test_title}</span>
                      {hasWritingTask(sub) && (
                        <div style={styles.miniBadgeBox}>
                          <span style={styles.overallScoreNumMini}>{fmtScore(sub.writing_score)}</span>
                          <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>Writing Band</span>
                        </div>
                      )}
                    </div>

                    <div style={{ ...styles.miniScoresRow, marginTop: '0.5rem' }}>
                      <span>🎧 List: <strong>{fmtScore(sub.listening_score)}</strong></span>
                      <span>📖 Read: <strong>{fmtScore(sub.reading_score)}</strong></span>
                      {hasWritingTask(sub) && <span>✍️ Writ: <strong>{fmtScore(sub.writing_score)}</strong></span>}
                    </div>

                    <div style={styles.revealControlBox}>
                      <span style={{
                        color: sub.is_revealed === 1 ? '#10b981' : '#f59e0b',
                        fontSize: '0.85rem',
                        fontWeight: '600'
                      }}>
                        {sub.is_revealed === 1 ? '🟢 Scores Released' : '🟡 Hidden from Student'}
                      </span>
                      <button 
                        onClick={() => toggleRevealStatus(sub.id, sub.is_revealed === 1)}
                        className="btn btn-secondary"
                        style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}
                      >
                        {sub.is_revealed === 1 ? 'Hide Scores' : 'Release Scores'}
                      </button>
                    </div>

                    {/* Opening a submission was gated on it having a Writing task,
                        because this button used to lead only to writing grading.
                        The workspace it opens also holds the per-question
                        Listening & Reading review -- so for a standalone Reading
                        or Listening test, where there is no Writing, the teacher
                        had no way in at all: just a band number and a PDF, with
                        the question-by-question breakdown unreachable. */}
                    <button
                      onClick={() => handleSelectSubmission(sub)}
                      className="btn btn-secondary"
                      style={{ width: '100%', justifyContent: 'center', marginTop: '0.75rem' }}
                    >
                      {hasWritingTask(sub) ? '🔍 Edit Grade & Feedback' : '🔍 View Detailed Answers'}
                    </button>
                    <button
                      onClick={() => downloadPdfReport(sub)}
                      className="btn btn-primary"
                      style={{ width: '100%', justifyContent: 'center', marginTop: '0.5rem', backgroundColor: '#6366f1', borderColor: '#6366f1' }}
                    >
                      📥 Download PDF Report
                    </button>
                  </div>
                ))
              )}
            </div>
            </div>
            </>
            )}
          </>
        )}
      </main>

      {showPwdModal && (
        <ChangePasswordModal 
          userId={user.id} 
          onClose={() => setShowPwdModal(false)} 
        />
      )}

      {/* Speaking Evaluation & Edit Modal */}
      {editingSpeakingSub && (
        <div style={styles.modalOverlay}>
          <div className="glass-panel" style={{ ...styles.modalContent, backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', maxWidth: '640px' }}>
            <div style={{ ...styles.modalHeader, borderBottom: '1px solid var(--glass-border)' }}>
              <h3 style={{ color: 'var(--text-primary)', fontWeight: '700' }}>✏️ Evaluate Speaking Test — {editingSpeakingSub.student_name}</h3>
              <button onClick={() => setEditingSpeakingSub(null)} style={styles.closeBtn}>×</button>
            </div>

            <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                <strong>Prompt:</strong> {editingSpeakingSub.prompt_title} | Candidate ID: <strong>{editingSpeakingSub.student_id}</strong>
              </div>

              {/* Criterion Score Selectors */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                {[
                  ['Fluency & Coherence', editFluency, setEditFluency],
                  ['Lexical Resource', editLexical, setEditLexical],
                  ['Grammatical Range', editGrammar, setEditGrammar],
                  ['Pronunciation', editPronunciation, setEditPronunciation]
                ].map(([label, val, setter]) => (
                  <div key={label} style={{ backgroundColor: 'var(--bg-tertiary)', padding: '0.85rem', borderRadius: '8px', border: '1px solid var(--glass-border)' }}>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '0.4rem' }}>{label}</label>
                    <select
                      value={val}
                      onChange={e => setter(parseFloat(e.target.value))}
                      style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--glass-border)', color: 'var(--text-primary)', fontWeight: 'bold' }}
                    >
                      {[4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0].map(s => (
                        <option key={s} value={s}>Band {s.toFixed(1)}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>

              {/* Overall Band Auto calculation */}
              <div style={{ backgroundColor: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '8px', padding: '0.85rem', textAlign: 'center' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: '700' }}>Calculated Overall Band</span>
                <div style={{ fontSize: '2.25rem', fontWeight: '900', color: '#6366f1' }}>
                  {(() => {
                    const avg = (editFluency + editLexical + editGrammar + editPronunciation) / 4;
                    const dec = avg - Math.floor(avg);
                    let ovr = Math.floor(avg);
                    if (dec >= 0.25 && dec < 0.75) ovr += 0.5;
                    else if (dec >= 0.75) ovr += 1.0;
                    return ovr.toFixed(1);
                  })()}
                </div>
              </div>

              {/* Feedback Textarea */}
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '0.4rem' }}>📝 Teacher Summary Assessment & Feedback</label>
                <textarea
                  rows={4}
                  value={editFeedbackText}
                  onChange={e => setEditFeedbackText(e.target.value)}
                  placeholder="Add personalized comments or tips for the student..."
                  style={{ width: '100%', padding: '0.75rem', borderRadius: '8px', backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--glass-border)', color: 'var(--text-primary)', fontSize: '0.88rem', resize: 'vertical' }}
                />
              </div>

              {/* Save Buttons */}
              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
                <button
                  onClick={async () => {
                    const avg = (editFluency + editLexical + editGrammar + editPronunciation) / 4;
                    const dec = avg - Math.floor(avg);
                    let ovr = Math.floor(avg);
                    if (dec >= 0.25 && dec < 0.75) ovr += 0.5;
                    else if (dec >= 0.75) ovr += 1.0;

                    const fbObj = { overall: editFeedbackText };

                    await fetch(`/api/teacher/speaking/${editingSpeakingSub.id}/update`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        fluency: editFluency,
                        lexical: editLexical,
                        grammar: editGrammar,
                        pronunciation: editPronunciation,
                        overall: ovr,
                        feedback: fbObj
                      })
                    });

                    setEditingSpeakingSub(null);
                    fetchSubmissions();
                  }}
                  className="btn btn-primary"
                  style={{ flex: 1, justifyContent: 'center' }}
                >
                  💾 Save Grades
                </button>
                <button
                  onClick={async () => {
                    const avg = (editFluency + editLexical + editGrammar + editPronunciation) / 4;
                    const dec = avg - Math.floor(avg);
                    let ovr = Math.floor(avg);
                    if (dec >= 0.25 && dec < 0.75) ovr += 0.5;
                    else if (dec >= 0.75) ovr += 1.0;

                    const fbObj = { overall: editFeedbackText };

                    await fetch(`/api/teacher/speaking/${editingSpeakingSub.id}/update`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        fluency: editFluency,
                        lexical: editLexical,
                        grammar: editGrammar,
                        pronunciation: editPronunciation,
                        overall: ovr,
                        feedback: fbObj
                      })
                    });

                    await fetch(`/api/teacher/speaking/${editingSpeakingSub.id}/send`, { method: 'POST' });
                    setEditingSpeakingSub(null);
                    fetchSubmissions();
                  }}
                  className="btn btn-success"
                  style={{ flex: 1, justifyContent: 'center' }}
                >
                  📤 Save & Release to Student
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  statsRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: '1.25rem',
  },
  statCard: {
    display: 'flex',
    alignItems: 'center',
    gap: '1.25rem',
    padding: '1.25rem 1.5rem',
    flexDirection: 'row',
  },
  statIcon: {
    fontSize: '2rem',
  },
  statVal: {
    fontSize: '1.75rem',
    fontWeight: '700',
    color: 'var(--text-primary)',
    margin: 0,
    lineHeight: '1.2',
  },
  statLabel: {
    fontSize: '0.85rem',
    color: 'var(--text-secondary)',
    fontWeight: '500',
  },
  vizAndFiltersPanel: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '1.5rem',
  },
  chartCard: {
    padding: '1.25rem 1.5rem',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
  },
  filtersCard: {
    padding: '1.25rem 1.5rem',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
  },
  searchContainer: {
    width: '100%',
  },
  searchInput: {
    width: '100%',
    padding: '0.65rem 1rem',
    borderRadius: '6px',
    border: '1px solid var(--glass-border)',
    backgroundColor: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    fontSize: '0.9rem',
    outline: 'none',
  },
  dropdownsRow: {
    display: 'flex',
    gap: '0.75rem',
  },
  dropdownInput: {
    flex: 1,
    padding: '0.65rem',
    borderRadius: '6px',
    border: '1px solid var(--glass-border)',
    backgroundColor: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    fontSize: '0.85rem',
    cursor: 'pointer',
    outline: 'none',
  },
  descriptorHint: {
    fontSize: '0.8rem',
    color: 'var(--text-secondary)',
    marginTop: '0.35rem',
    lineHeight: '1.4',
    fontStyle: 'italic',
    padding: '0.35rem 0.5rem',
    backgroundColor: 'var(--bg-secondary)',
    borderLeft: '3px solid #6366f1',
    borderRadius: '0 4px 4px 0',
  },
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
    backgroundColor: '#10b981',
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
  dashboardGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '2.5rem',
  },
  columnTitle: {
    fontSize: '1.15rem',
    fontWeight: '600',
    marginBottom: '1.25rem',
    color: 'var(--text-primary)',
  },
  emptyCard: {
    textAlign: 'center',
    padding: '3rem 2rem',
    color: 'var(--text-secondary)',
  },
  subCard: {
    marginBottom: '1rem',
    backgroundColor: 'var(--bg-secondary)',
  },
  subCardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    borderBottom: '1px solid var(--glass-border)',
    paddingBottom: '0.75rem',
    marginBottom: '0.75rem',
  },
  studentTitle: {
    fontSize: '1.05rem',
    fontWeight: '600',
    color: 'var(--text-primary)',
  },
  subMeta: {
    fontSize: '0.8rem',
    color: 'var(--text-secondary)',
  },
  dateLabel: {
    fontSize: '0.8rem',
    color: 'var(--text-secondary)',
  },
  miniScoresRow: {
    display: 'flex',
    gap: '1rem',
    fontSize: '0.85rem',
    color: 'var(--text-secondary)',
  },
  miniBadgeBox: {
    backgroundColor: 'var(--bg-tertiary)',
    borderRadius: '6px',
    padding: '0.25rem 0.5rem',
    textAlign: 'center',
    border: '1px solid var(--glass-border)',
  },
  overallScoreNumMini: {
    display: 'block',
    fontSize: '1.1rem',
    fontWeight: '700',
    color: '#10b981',
  },
  revealControlBox: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'var(--bg-tertiary)',
    padding: '0.5rem 0.75rem',
    borderRadius: '6px',
    marginTop: '0.75rem',
  },

  /* Grading Workspace Layout */
  gradingWorkspace: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.5rem',
    paddingBottom: '3rem',
  },
  workspaceHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'var(--bg-secondary)',
    padding: '1.25rem 2rem',
    borderRadius: '12px',
    border: '1px solid var(--glass-border)',
  },
  liveScoreBadge: {
    backgroundColor: 'var(--bg-tertiary)',
    border: '1.5px solid #6366f1',
    borderRadius: '10px',
    padding: '0.75rem 1.25rem',
    textAlign: 'center',
    minWidth: '120px',
  },
  liveScoreNum: {
    display: 'block',
    fontSize: '2rem',
    fontWeight: '800',
    color: '#6366f1',
  },
  liveScoreLabel: {
    fontSize: '0.7rem',
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    fontWeight: '600',
  },
  workspaceGrid: {
    display: 'grid',
    gridTemplateColumns: '1.2fr 0.8fr',
    gap: '2rem',
    alignItems: 'start',
  },
  essayPanel: {
    maxHeight: '75vh',
    overflowY: 'auto',
  },
  essayBox: {
    backgroundColor: 'var(--bg-secondary)',
    border: '1px solid var(--glass-border)',
    borderRadius: '8px',
    padding: '1.25rem',
  },
  essayBoxHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottom: '1px solid var(--glass-border)',
    paddingBottom: '0.5rem',
    marginBottom: '0.75rem'
  },
  writingPrompt: {
    fontSize: '0.85rem',
    color: 'var(--text-secondary)',
    fontStyle: 'italic',
  },
  rawEssayText: {
    backgroundColor: 'var(--bg-primary)',
    border: '1px solid var(--glass-border)',
    padding: '1.25rem',
    borderRadius: '6px',
    fontSize: '0.95rem',
    lineHeight: '1.6',
    whiteSpace: 'pre-wrap',
    color: 'var(--text-primary)',
    marginTop: '0.5rem',
  },
  gradingPanel: {
    // Stick to top while scrolling essays
    position: 'sticky',
    top: '20px',
  },
  rubricGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '1rem',
  },
  toggleRow: {
    marginTop: '1.25rem',
    backgroundColor: 'var(--bg-secondary)',
    padding: '0.75rem 1rem',
    borderRadius: '6px',
    border: '1px solid var(--glass-border)',
  },
  toggleLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    fontSize: '0.85rem',
    color: 'var(--text-primary)',
    cursor: 'pointer',
  },
  tabBtn: {
    padding: '0.6rem 1.2rem',
    fontSize: '0.9rem',
    fontWeight: '600',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
  },
  reviewTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.85rem',
  },
  reviewTh: {
    textAlign: 'left',
    padding: '0.5rem',
    borderBottom: '2px solid var(--glass-border)',
    color: 'var(--text-secondary)',
    fontWeight: '600',
  },
  reviewTd: {
    padding: '0.5rem',
    verticalAlign: 'middle',
    color: 'var(--text-primary)',
  }
};
