export interface User {
  id: string;
  username: string;
  email?: string;
  role: 'user' | 'admin';
}

export interface Problem {
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
  solution_python?: string;
  solution_javascript?: string;
  sampleTestCases: TestCase[];
  accepted_count: number;
  total_submissions: number;
  userStatus?: {
    status: 'solved' | 'attempted' | 'unsolved';
    best_runtime_ms?: number;
    attempts: number;
  };
}

export interface ProblemListItem {
  id: string;
  title: string;
  slug: string;
  difficulty: 'easy' | 'medium' | 'hard';
  userStatus?: 'solved' | 'attempted' | 'unsolved';
}

export interface TestCase {
  id: string;
  input: string;
  expected_output: string;
  order_index: number;
}

export interface Submission {
  id: string;
  user_id: string;
  problem_id: string;
  language: 'python' | 'javascript';
  code: string;
  status: SubmissionStatus;
  runtime_ms: number | null;
  memory_kb: number | null;
  test_cases_passed: number;
  test_cases_total: number;
  error_message: string | null;
  created_at: string;
  problem_slug?: string;
  problem_title?: string;
}

export type SubmissionStatus =
  | 'pending'
  | 'running'
  | 'accepted'
  | 'wrong_answer'
  | 'time_limit_exceeded'
  | 'memory_limit_exceeded'
  | 'runtime_error'
  | 'compile_error'
  | 'system_error';

export interface RunResult {
  input: string;
  expectedOutput: string | null;
  actualOutput: string | null;
  status: string;
  passed: boolean | null;
  executionTime: number;
  error: string | null;
}

export interface UserStats {
  solved_count: string;
  attempted_count: string;
  total_submissions: string;
  accepted_submissions: string;
  difficultyBreakdown: {
    easy: number;
    medium: number;
    hard: number;
  };
}

export interface UserProgress {
  problem_id: string;
  slug: string;
  title: string;
  difficulty: 'easy' | 'medium' | 'hard';
  status: 'solved' | 'attempted' | 'unsolved';
  attempts: number;
  best_runtime_ms: number | null;
}
