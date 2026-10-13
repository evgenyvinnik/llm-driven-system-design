import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { ApiError, newIdempotencyKey, problemsApi, submissionsApi, type SubmissionStatusResponse } from '../services/api';
import { CodeEditor } from '../components/CodeEditor';
import { DifficultyBadge } from '../components/DifficultyBadge';
import { TestResults } from '../components/TestResults';
import { StatusBadge } from '../components/StatusBadge';
import { useAuthStore } from '../stores/authStore';
import { draftKey, useEditorStore, type Language } from '../stores/editorStore';
import { useSubmissionStatus } from '../hooks/useSubmissionStatus';
import { RunResult } from '../types';

/** How long typing must pause before the draft is written to localStorage. */
const DRAFT_SAVE_DELAY_MS = 500;
/** Retries of one submit attempt after a network error or 5xx; all reuse the same key. */
const SUBMIT_RETRY_DELAYS_MS = [500, 1500];

function describeStatus(status: SubmissionStatusResponse): string {
  switch (status.status) {
    case 'pending':
      return status.error_message || 'Waiting for a judge...';
    case 'running':
      return `Running test ${status.current_test || '?'} of ${status.test_cases_total || '?'}...`;
    case 'accepted':
      return `Accepted! Runtime: ${status.runtime_ms}ms`;
    default:
      return status.error_message || status.status.replace(/_/g, ' ');
  }
}

/** Retries only failures that may succeed on a second try; the server dedupes on the key. */
function isRetryable(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof ApiError && error.status >= 500);
}

interface Problem {
  id: string;
  title: string;
  slug: string;
  description: string;
  examples: string;
  constraints: string;
  difficulty: 'easy' | 'medium' | 'hard';
  time_limit_ms: number;
  memory_limit_mb: number;
  starter_code_python: string;
  starter_code_javascript: string;
  sampleTestCases: Array<{ input: string; expected_output: string }>;
  accepted_count: number;
  total_submissions: number;
}

interface Submission {
  id: string;
  status: string;
  runtime_ms: number | null;
  test_cases_passed: number;
  test_cases_total: number;
  created_at: string;
}

/** Renders the problem workspace with description, code editor, test runner, and submission history. */
export function ProblemPage() {
  const { slug } = useParams<{ slug: string }>();
  const { isAuthenticated } = useAuthStore();

  const [problem, setProblem] = useState<Problem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const language = useEditorStore((state) => state.language);
  const setLanguage = useEditorStore((state) => state.setLanguage);
  const saveDraft = useEditorStore((state) => state.saveDraft);
  const clearDraft = useEditorStore((state) => state.clearDraft);
  const [code, setCode] = useState('');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [activeTab, setActiveTab] = useState<'description' | 'submissions'>('description');
  const [submissions, setSubmissions] = useState<Submission[]>([]);

  const [testResults, setTestResults] = useState<RunResult[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submissionId, setSubmissionId] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setLoading(true);
    problemsApi.get(slug)
      .then((data) => {
        if (cancelled) return;
        setProblem(data as Problem);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError('Failed to load problem');
        console.error(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const starterFor = useCallback((lang: Language) => {
    if (!problem) return '';
    return (lang === 'python' ? problem.starter_code_python : problem.starter_code_javascript) || '';
  }, [problem]);

  // Load the saved draft for this problem and language, falling back to the starter code.
  // Reads the store directly so typing (which updates drafts) does not re-run this effect.
  useEffect(() => {
    if (!problem) return;
    const saved = useEditorStore.getState().drafts[draftKey(problem.slug, language)];
    setCode(saved ?? starterFor(language));
  }, [problem, language, starterFor]);

  const handleCodeChange = (value: string) => {
    setCode(value);
    if (!problem) return;
    clearTimeout(saveTimer.current);
    const problemSlug = problem.slug;
    saveTimer.current = setTimeout(() => saveDraft(problemSlug, language, value), DRAFT_SAVE_DELAY_MS);
  };

  const handleLanguageChange = (next: Language) => {
    // Flush the pending save so the draft for the current language is not lost.
    clearTimeout(saveTimer.current);
    if (problem) saveDraft(problem.slug, language, code);
    setLanguage(next);
  };

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const loadSubmissions = useCallback(async () => {
    if (!isAuthenticated || !slug) return;
    try {
      const data = await problemsApi.getSubmissions(slug);
      setSubmissions(data.submissions as Submission[]);
    } catch (err) {
      console.error('Failed to load submissions:', err);
    }
  }, [isAuthenticated, slug]);

  useEffect(() => {
    if (activeTab === 'submissions' && isAuthenticated) {
      loadSubmissions();
    }
  }, [activeTab, isAuthenticated, loadSubmissions]);

  const handleRun = async () => {
    if (!problem) return;

    setIsRunning(true);
    setTestResults([]);

    try {
      const response = await submissionsApi.run(problem.slug, language, code);
      setTestResults(response.results);
    } catch (err) {
      console.error('Run failed:', err);
      setTestResults([{
        input: '',
        expectedOutput: null,
        actualOutput: null,
        status: 'system_error',
        passed: false,
        executionTime: 0,
        error: err instanceof Error ? err.message : 'Run failed'
      }]);
    } finally {
      setIsRunning(false);
    }
  };

  const handleSubmit = async () => {
    if (!problem || !isAuthenticated) return;

    setIsSubmitting(true);
    setSubmitError(null);
    setSubmissionId(null);

    // One key per submit attempt: a retry after a timeout returns the same submission
    // instead of judging the code twice.
    const idempotencyKey = newIdempotencyKey();
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await submissionsApi.submit(problem.slug, language, code, idempotencyKey);
        setSubmissionId(response.submissionId);
        return;
      } catch (err) {
        if (attempt < SUBMIT_RETRY_DELAYS_MS.length && isRetryable(err)) {
          await new Promise((resolve) => setTimeout(resolve, SUBMIT_RETRY_DELAYS_MS[attempt]));
          continue;
        }
        console.error('Submit failed:', err);
        setSubmitError(err instanceof Error ? err.message : 'Submission failed');
        setIsSubmitting(false);
        return;
      }
    }
  };

  const onVerdict = useCallback(() => {
    setIsSubmitting(false);
    loadSubmissions();
  }, [loadSubmissions]);

  const polled = useSubmissionStatus(submissionId, onVerdict);

  useEffect(() => {
    if (polled.stalled) setIsSubmitting(false);
  }, [polled.stalled]);

  const submissionStatus = submitError
    ? { status: 'error', message: submitError }
    : submissionId
    ? polled.data
      ? { status: polled.data.status, message: describeStatus(polled.data) }
      : { status: 'pending', message: 'Submission received, waiting for a judge...' }
    : null;
  // Polling gives up after a few minutes; the verdict still lands in the Submissions tab.
  const stalledNote = polled.stalled ? ' Still judging - check the Submissions tab for the verdict.' : '';

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-64px)]">
        <div className="animate-spin w-8 h-8 border-2 border-current border-t-transparent text-primary-500 rounded-full"></div>
      </div>
    );
  }

  if (error || !problem) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-64px)]">
        <p className="text-red-400 mb-4">{error || 'Problem not found'}</p>
        <Link to="/problems" className="text-primary-400 hover:text-primary-300">
          Back to Problems
        </Link>
      </div>
    );
  }

  const acceptanceRate = problem.total_submissions > 0
    ? ((problem.accepted_count / problem.total_submissions) * 100).toFixed(1)
    : '0';

  return (
    <div className="h-[calc(100vh-64px)] flex">
      {/* Left Panel - Problem Description */}
      <div className="w-1/2 flex flex-col border-r border-dark-100">
        {/* Tabs */}
        <div className="flex border-b border-dark-100">
          <button
            onClick={() => setActiveTab('description')}
            className={`px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'description'
                ? 'text-white border-b-2 border-primary-500'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            Description
          </button>
          {isAuthenticated && (
            <button
              onClick={() => setActiveTab('submissions')}
              className={`px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === 'submissions'
                  ? 'text-white border-b-2 border-primary-500'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              Submissions
            </button>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6">
          {activeTab === 'description' ? (
            <>
              <div className="flex items-center gap-3 mb-4">
                <h1 className="text-2xl font-bold text-white">{problem.title}</h1>
                <DifficultyBadge difficulty={problem.difficulty} />
              </div>

              <div className="flex items-center gap-4 text-sm text-gray-400 mb-6">
                <span>Acceptance: {acceptanceRate}%</span>
                <span>Time Limit: {problem.time_limit_ms}ms</span>
                <span>Memory: {problem.memory_limit_mb}MB</span>
              </div>

              <div className="markdown-content text-gray-300">
                <ReactMarkdown>{problem.description}</ReactMarkdown>
                {problem.examples && (
                  <>
                    <h3 className="text-lg font-semibold text-white mt-6 mb-3">Examples</h3>
                    <ReactMarkdown>{problem.examples}</ReactMarkdown>
                  </>
                )}
                {problem.constraints && (
                  <>
                    <h3 className="text-lg font-semibold text-white mt-6 mb-3">Constraints</h3>
                    <ReactMarkdown>{problem.constraints}</ReactMarkdown>
                  </>
                )}
              </div>
            </>
          ) : (
            <div>
              <h2 className="text-xl font-semibold text-white mb-4">Your Submissions</h2>
              {submissions.length === 0 ? (
                <p className="text-gray-400">No submissions yet</p>
              ) : (
                <div className="space-y-2">
                  {submissions.map((sub) => (
                    <div
                      key={sub.id}
                      className="p-4 bg-dark-300 rounded-lg flex items-center justify-between"
                    >
                      <div className="flex items-center gap-4">
                        <StatusBadge status={sub.status} />
                        <span className="text-gray-400 text-sm">
                          {sub.test_cases_passed}/{sub.test_cases_total} tests passed
                        </span>
                      </div>
                      <div className="text-gray-500 text-sm">
                        {sub.runtime_ms && `${sub.runtime_ms}ms`}
                        <span className="ml-4">
                          {new Date(sub.created_at).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Right Panel - Code Editor */}
      <div className="w-1/2 flex flex-col">
        {/* Editor Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-dark-100">
          <select
            value={language}
            onChange={(e) => handleLanguageChange(e.target.value as Language)}
            aria-label="Language"
            className="px-3 py-1.5 bg-dark-300 border border-dark-100 rounded text-sm text-white focus:outline-none focus:border-primary-500"
          >
            <option value="python">Python</option>
            <option value="javascript">JavaScript</option>
          </select>

          <button
            onClick={() => {
              clearTimeout(saveTimer.current);
              clearDraft(problem.slug, language);
              setCode(starterFor(language));
            }}
            className="text-sm text-gray-400 hover:text-white transition-colors"
          >
            Reset Code
          </button>
        </div>

        {/* Code Editor */}
        <div className="flex-1 overflow-hidden">
          <CodeEditor
            value={code}
            onChange={handleCodeChange}
            language={language}
            height="100%"
          />
        </div>

        {/* Test Results */}
        <div className="h-64 border-t border-dark-100 overflow-auto bg-dark-400">
          <div className="sticky top-0 bg-dark-400 px-4 py-2 border-b border-dark-100">
            <span className="text-sm font-medium text-gray-300">Test Results</span>
          </div>
          <TestResults results={testResults} isLoading={isRunning} />

          {/* Polite live region: screen readers announce progress and the verdict without a focus change */}
          <div role="status" aria-live="polite">
            {submissionStatus && (
              <div className={`p-4 ${
                submissionStatus.status === 'accepted' ? 'bg-green-900/20' :
                submissionStatus.status === 'running' || submissionStatus.status === 'pending' ? 'bg-yellow-900/20' :
                'bg-red-900/20'
              }`}>
                <div className="flex items-center gap-2">
                  <StatusBadge status={submissionStatus.status} />
                  <span className="text-sm text-gray-300">{submissionStatus.message}{stalledNote}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-end gap-3 px-4 py-3 border-t border-dark-100">
          <button
            onClick={handleRun}
            disabled={isRunning || !code.trim()}
            className="px-4 py-2 bg-dark-200 text-white rounded hover:bg-dark-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRunning ? 'Running...' : 'Run'}
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSubmitting || !code.trim() || !isAuthenticated}
            className="px-4 py-2 bg-primary-500 text-white rounded hover:bg-primary-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? 'Submitting...' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  );
}
