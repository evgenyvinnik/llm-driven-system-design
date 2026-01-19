import { simpleGit, SimpleGit, BranchSummary, TagResult, LogResult, DiffResultTextFile } from 'simple-git';
import fs from 'fs/promises';
import path from 'path';

const REPOS_BASE_PATH = process.env.REPOS_PATH || path.join(process.cwd(), 'repositories');

// Ensure repositories directory exists
await fs.mkdir(REPOS_BASE_PATH, { recursive: true });

export interface CommitInfo {
  sha: string;
  message: string;
  author: {
    name: string;
    email: string;
  };
  date: string;
}

export interface TreeItem {
  mode: string;
  type: 'file' | 'dir';
  sha: string;
  size: number | null;
  name: string;
  path: string;
}

export interface DiffResult {
  diff: string;
  stats: {
    additions: number;
    deletions: number;
    files: Array<{
      path: string;
      additions: number;
      deletions: number;
      changes: number;
    }>;
  };
}

export interface MergeResult {
  success: boolean;
  sha?: string;
  error?: string;
}

export interface GetCommitsOptions {
  branch?: string;
  maxCount?: number;
  skip?: number;
}

/**
 * Get the storage path for a repository
 */
export function getRepoPath(owner: string, repoName: string): string {
  return path.join(REPOS_BASE_PATH, owner, `${repoName}.git`);
}

/**
 * Initialize a bare Git repository
 */
export async function initRepository(owner: string, repoName: string, defaultBranch = 'main'): Promise<string> {
  const repoPath = getRepoPath(owner, repoName);

  // Create directory structure
  await fs.mkdir(path.dirname(repoPath), { recursive: true });

  // Initialize bare repository
  const git: SimpleGit = simpleGit();
  await git.init(true, repoPath);

  // Set default branch
  const repoGit: SimpleGit = simpleGit(repoPath);
  await repoGit.raw(['symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`]);

  return repoPath;
}

/**
 * Delete a repository
 */
export async function deleteRepository(owner: string, repoName: string): Promise<void> {
  const repoPath = getRepoPath(owner, repoName);
  await fs.rm(repoPath, { recursive: true, force: true });
}

/**
 * Clone a repository to a working directory
 */
export async function cloneRepository(owner: string, repoName: string, targetPath: string): Promise<string> {
  const repoPath = getRepoPath(owner, repoName);
  const git: SimpleGit = simpleGit();
  await git.clone(repoPath, targetPath);
  return targetPath;
}

/**
 * Get list of branches
 */
export async function getBranches(owner: string, repoName: string): Promise<Array<{ name: string; current: boolean }>> {
  const repoPath = getRepoPath(owner, repoName);
  const git: SimpleGit = simpleGit(repoPath);

  try {
    const branchSummary: BranchSummary = await git.branch(['-a']);
    return Object.keys(branchSummary.branches).map((name) => ({
      name: name.replace('remotes/origin/', ''),
      current: branchSummary.current === name,
    }));
  } catch {
    // Empty repo
    return [];
  }
}

/**
 * Get list of tags
 */
export async function getTags(owner: string, repoName: string): Promise<string[]> {
  const repoPath = getRepoPath(owner, repoName);
  const git: SimpleGit = simpleGit(repoPath);

  try {
    const tags: TagResult = await git.tags();
    return tags.all;
  } catch {
    return [];
  }
}

/**
 * Get commit log
 */
export async function getCommits(owner: string, repoName: string, options: GetCommitsOptions = {}): Promise<CommitInfo[]> {
  const repoPath = getRepoPath(owner, repoName);
  const git: SimpleGit = simpleGit(repoPath);

  const { branch = 'HEAD', maxCount = 30, skip = 0 } = options;

  try {
    const log: LogResult = await git.log({
      [branch]: true,
      maxCount,
      '--skip': skip,
    });

    return log.all.map((commit) => ({
      sha: commit.hash,
      message: commit.message,
      author: {
        name: commit.author_name,
        email: commit.author_email,
      },
      date: commit.date,
    }));
  } catch {
    return [];
  }
}

/**
 * Get single commit details
 */
export async function getCommit(owner: string, repoName: string, sha: string): Promise<(CommitInfo & { diff: string }) | null> {
  const repoPath = getRepoPath(owner, repoName);
  const git: SimpleGit = simpleGit(repoPath);

  try {
    const log: LogResult = await git.log({ [sha]: true, maxCount: 1 });
    if (log.all.length === 0) return null;

    const commit = log.all[0];
    const diff: string = await git.show([sha, '--stat']);

    return {
      sha: commit.hash,
      message: commit.message,
      author: {
        name: commit.author_name,
        email: commit.author_email,
      },
      date: commit.date,
      diff,
    };
  } catch {
    return null;
  }
}

/**
 * Get file tree at a specific ref
 */
export async function getTree(owner: string, repoName: string, ref = 'HEAD', treePath = ''): Promise<TreeItem[]> {
  const repoPath = getRepoPath(owner, repoName);
  const git: SimpleGit = simpleGit(repoPath);

  try {
    const fullPath = treePath ? `${ref}:${treePath}` : ref;
    const result: string = await git.raw(['ls-tree', '-l', fullPath]);

    if (!result) return [];

    return result
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [mode, type, hash, sizeAndName] = line.split(/\s+/);
        const [size, ...nameParts] = sizeAndName.split('\t');
        const name = nameParts.join('\t');

        return {
          mode,
          type: type === 'tree' ? 'dir' : 'file',
          sha: hash,
          size: type === 'tree' ? null : parseInt(size),
          name,
          path: treePath ? `${treePath}/${name}` : name,
        } as TreeItem;
      });
  } catch {
    return [];
  }
}

/**
 * Get file content
 */
export async function getFileContent(owner: string, repoName: string, ref = 'HEAD', filePath: string): Promise<string | null> {
  const repoPath = getRepoPath(owner, repoName);
  const git: SimpleGit = simpleGit(repoPath);

  try {
    const content: string = await git.show([`${ref}:${filePath}`]);
    return content;
  } catch {
    return null;
  }
}

/**
 * Get diff between two refs
 */
export async function getDiff(owner: string, repoName: string, base: string, head: string): Promise<DiffResult> {
  const repoPath = getRepoPath(owner, repoName);
  const git: SimpleGit = simpleGit(repoPath);

  try {
    const diff: string = await git.diff([`${base}...${head}`]);
    const stats = await git.diffSummary([`${base}...${head}`]);

    return {
      diff,
      stats: {
        additions: stats.insertions,
        deletions: stats.deletions,
        files: stats.files.map((f: DiffResultTextFile) => ({
          path: f.file,
          additions: f.insertions,
          deletions: f.deletions,
          changes: f.changes,
        })),
      },
    };
  } catch (err) {
    console.error('Diff error:', err);
    return { diff: '', stats: { additions: 0, deletions: 0, files: [] } };
  }
}

/**
 * Get commits between two refs
 */
export async function getCommitsBetween(owner: string, repoName: string, base: string, head: string): Promise<CommitInfo[]> {
  const repoPath = getRepoPath(owner, repoName);
  const git: SimpleGit = simpleGit(repoPath);

  try {
    const log: LogResult = await git.log({ from: base, to: head });
    return log.all.map((commit) => ({
      sha: commit.hash,
      message: commit.message,
      author: {
        name: commit.author_name,
        email: commit.author_email,
      },
      date: commit.date,
    }));
  } catch {
    return [];
  }
}

/**
 * Get current HEAD sha
 */
export async function getHeadSha(owner: string, repoName: string, branch = 'HEAD'): Promise<string | null> {
  const repoPath = getRepoPath(owner, repoName);
  const git: SimpleGit = simpleGit(repoPath);

  try {
    const sha: string = await git.revparse([branch]);
    return sha.trim();
  } catch {
    return null;
  }
}

/**
 * Check if branch exists
 */
export async function branchExists(owner: string, repoName: string, branchName: string): Promise<boolean> {
  const repoPath = getRepoPath(owner, repoName);
  const git: SimpleGit = simpleGit(repoPath);

  try {
    await git.revparse([`refs/heads/${branchName}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Merge branches (for PR merge)
 */
export async function mergeBranches(
  owner: string,
  repoName: string,
  baseBranch: string,
  headBranch: string,
  strategy: 'merge' | 'squash' | 'rebase' = 'merge',
  message?: string
): Promise<MergeResult> {
  const repoPath = getRepoPath(owner, repoName);

  // Create a temporary working directory
  const workDir = path.join(REPOS_BASE_PATH, '.tmp', `${owner}-${repoName}-${Date.now()}`);
  await fs.mkdir(workDir, { recursive: true });

  try {
    // Clone the bare repo
    const git: SimpleGit = simpleGit();
    await git.clone(repoPath, workDir);

    const workGit: SimpleGit = simpleGit(workDir);
    await workGit.checkout(baseBranch);

    if (strategy === 'merge') {
      await workGit.merge([headBranch, '-m', message || `Merge branch '${headBranch}' into ${baseBranch}`]);
    } else if (strategy === 'squash') {
      await workGit.merge([headBranch, '--squash']);
      await workGit.commit(message || `Squash merge '${headBranch}' into ${baseBranch}`);
    } else if (strategy === 'rebase') {
      await workGit.checkout(headBranch);
      await workGit.rebase([baseBranch]);
      await workGit.checkout(baseBranch);
      await workGit.merge([headBranch, '--ff-only']);
    }

    // Push back to bare repo
    await workGit.push('origin', baseBranch);

    const sha: string = await workGit.revparse(['HEAD']);
    return { success: true, sha: sha.trim() };
  } catch (err) {
    console.error('Merge error:', err);
    return { success: false, error: (err as Error).message };
  } finally {
    // Cleanup
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Create a working directory with initial commit for new repos
 */
export async function initWithReadme(owner: string, repoName: string, description = ''): Promise<boolean> {
  const repoPath = getRepoPath(owner, repoName);

  // Create temporary working directory
  const workDir = path.join(REPOS_BASE_PATH, '.tmp', `${owner}-${repoName}-init-${Date.now()}`);
  await fs.mkdir(workDir, { recursive: true });

  try {
    const git: SimpleGit = simpleGit(workDir);
    await git.init();

    // Create README.md
    const readmeContent = `# ${repoName}\n\n${description}`;
    await fs.writeFile(path.join(workDir, 'README.md'), readmeContent);

    // Configure git user for commit
    await git.addConfig('user.email', 'system@github-clone.local');
    await git.addConfig('user.name', 'System');

    // Add and commit
    await git.add('.');
    await git.commit('Initial commit');

    // Push to bare repo
    await git.addRemote('origin', repoPath);
    await git.push(['origin', 'main']);

    return true;
  } catch (err) {
    console.error('Init error:', err);
    return false;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
