import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Duplex } from 'stream';
import { encodeDockerFrame } from './dockerStream.js';

// Mock fs
vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    chmod: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock metrics
vi.mock('../shared/metrics.js', () => ({
  metrics: {
    activeContainers: { inc: vi.fn(), dec: vi.fn() },
    codeExecutionsTotal: { inc: vi.fn() },
    codeExecutionDuration: { observe: vi.fn() },
  },
}));

// Circuit breaker that calls straight through, unless a test opens it
const breakerState = { open: false };
vi.mock('../shared/circuitBreaker.js', () => ({
  createExecutionCircuitBreaker: vi.fn((fn: (spec: unknown) => Promise<unknown>) => ({
    fire: vi.fn((spec: unknown) => {
      if (breakerState.open) {
        return Promise.reject(Object.assign(new Error('Breaker is open'), { code: 'EOPENBREAKER' }));
      }
      return fn(spec);
    }),
    opened: false,
    halfOpen: false,
    stats: { fires: 0, successes: 0, failures: 0, rejects: 0, timeouts: 0 },
  })),
}));

interface FakeRun {
  frames?: Buffer[];
  exitCode?: number;
  oomKilled?: boolean;
  /** Never exit on its own: only kill() ends it (infinite loop, or flooding output). */
  hang?: boolean;
}

/** A container whose attach stream speaks Docker's multiplexed frame format. */
function fakeContainer(run: FakeRun) {
  const stream = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
  let exit!: (code: number) => void;
  const exited = new Promise<{ StatusCode: number }>((resolve) => {
    exit = (code) => resolve({ StatusCode: code });
  });
  const finish = (code: number) => {
    stream.push(null);
    exit(code);
  };
  const container = {
    attach: vi.fn().mockResolvedValue(stream),
    start: vi.fn(async () => {
      setImmediate(() => {
        for (const frame of run.frames ?? []) stream.push(frame);
        if (!run.hang) finish(run.exitCode ?? 0);
      });
    }),
    wait: vi.fn(() => exited),
    kill: vi.fn(async () => finish(137)),
    inspect: vi.fn(async () => ({ State: { OOMKilled: run.oomKilled ?? false } })),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  return container;
}

const mockDocker = {
  createContainer: vi.fn(),
  getImage: vi.fn(),
  getContainer: vi.fn(),
  listContainers: vi.fn(),
  pull: vi.fn(),
  modem: { followProgress: vi.fn() },
};

vi.mock('dockerode', () => ({
  default: vi.fn().mockImplementation(() => mockDocker),
}));

async function freshExecutor() {
  vi.resetModules();
  const module = await import('./codeExecutor.js');
  await module.default.init('test-owner');
  return module;
}

const LIMITS = { timeLimitMs: 2000, memoryLimitMb: 256 };

beforeEach(() => {
  vi.clearAllMocks();
  breakerState.open = false;
  mockDocker.getImage.mockReturnValue({ inspect: vi.fn().mockResolvedValue({ Id: 'image' }) });
  mockDocker.listContainers.mockResolvedValue([]);
});

describe('classifyRun', () => {
  it('maps container outcomes to verdicts, most specific first', async () => {
    const { classifyRun } = await import('./codeExecutor.js');
    const base = { outputLimitExceeded: false, timedOut: false, oomKilled: false, exitCode: 0, stderr: '' };

    expect(classifyRun(base)).toBe('success');
    expect(classifyRun({ ...base, exitCode: 1 })).toBe('runtime_error');
    expect(classifyRun({ ...base, exitCode: 137, timedOut: true })).toBe('time_limit_exceeded');
    expect(classifyRun({ ...base, exitCode: 137, oomKilled: true })).toBe('memory_limit_exceeded');
    expect(classifyRun({ ...base, exitCode: 1, stderr: 'Exception in thread "main" java.lang.OutOfMemoryError' })).toBe('memory_limit_exceeded');
    expect(classifyRun({ ...base, exitCode: 137, timedOut: true, outputLimitExceeded: true })).toBe('output_limit_exceeded');
  });
});

describe('CodeExecutor', () => {
  it('returns stdout without Docker frame headers and keeps stderr separate', async () => {
    const container = fakeContainer({
      frames: [encodeDockerFrame('stderr', 'warning: deprecated\n'), encodeDockerFrame('stdout', '[0,1]\n')],
    });
    mockDocker.createContainer.mockResolvedValue(container);
    const { default: executor } = await freshExecutor();

    const program = await executor.prepare('print([0, 1])', 'python');
    const result = await executor.run(program, '[2,7,11,15]\n9', LIMITS);

    expect(result.status).toBe('success');
    expect(result.stdout).toBe('[0,1]\n');
    expect(result.stderr).toBe('warning: deprecated\n');
    expect(container.remove).toHaveBeenCalledWith({ force: true });
  });

  it('creates locked-down containers: non-root, no network, read-only root and code, no auto-remove', async () => {
    mockDocker.createContainer.mockImplementation(async () => fakeContainer({ frames: [encodeDockerFrame('stdout', '1')] }));
    const { default: executor } = await freshExecutor();

    const program = await executor.prepare('print(1)', 'python');
    await executor.run(program, '', LIMITS);

    const options = mockDocker.createContainer.mock.calls[0][0];
    expect(options.User).toBe('65534:65534');
    expect(options.NetworkDisabled).toBe(true);
    expect(options.Labels).toEqual({ 'leetcode.sandbox': 'true', 'leetcode.owner': 'test-owner' });
    expect(options.HostConfig).toMatchObject({
      NetworkMode: 'none',
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': expect.stringContaining('size=64m') },
      PidsLimit: 50,
      Memory: 256 * 1024 * 1024,
      MemorySwap: 256 * 1024 * 1024,
    });
    expect(options.HostConfig.Binds[0]).toMatch(/:\/code:ro$/);
    expect(options.HostConfig.AutoRemove).toBeUndefined();
  });

  it('compiles once and reuses the build for every test case', async () => {
    mockDocker.createContainer.mockImplementation(async () => fakeContainer({ frames: [encodeDockerFrame('stdout', 'ok')] }));
    const { default: executor } = await freshExecutor();

    const program = await executor.prepare('int main() {}', 'cpp');
    for (const input of ['1', '2', '3']) {
      await executor.run(program, input, LIMITS);
    }

    const commands = mockDocker.createContainer.mock.calls.map(([options]) => options.Cmd[0]);
    expect(commands).toEqual(['g++', '/code/solution', '/code/solution', '/code/solution']);
    // Only the compile step may write to /code
    expect(mockDocker.createContainer.mock.calls[0][0].HostConfig.Binds[0]).toMatch(/:\/code:rw$/);
    expect(mockDocker.createContainer.mock.calls[1][0].HostConfig.Binds[0]).toMatch(/:\/code:ro$/);
  });

  it('reports compiler errors as a compile error, not as a failed run', async () => {
    mockDocker.createContainer.mockResolvedValue(fakeContainer({
      frames: [encodeDockerFrame('stderr', "solution.cpp:1:1: error: 'x' was not declared")],
      exitCode: 1,
    }));
    const { default: executor } = await freshExecutor();

    const program = await executor.prepare('x', 'cpp');

    expect(program.compileError).toContain("'x' was not declared");
    await expect(executor.run(program, '', LIMITS)).rejects.toThrow('failed to compile');
  });

  it('detects the OOM killer through inspect()', async () => {
    mockDocker.createContainer.mockResolvedValue(fakeContainer({ exitCode: 137, oomKilled: true }));
    const { default: executor } = await freshExecutor();

    const program = await executor.prepare('a = [0] * 10**10', 'python');
    const result = await executor.run(program, '', LIMITS);

    expect(result.status).toBe('memory_limit_exceeded');
  });

  it('kills a container that runs past the time limit', async () => {
    const container = fakeContainer({ hang: true });
    mockDocker.createContainer.mockResolvedValue(container);
    const { default: executor } = await freshExecutor();

    const program = await executor.prepare('while True: pass', 'python');
    const result = await executor.run(program, '', { timeLimitMs: 50, memoryLimitMb: 256 });

    expect(container.kill).toHaveBeenCalled();
    expect(result.status).toBe('time_limit_exceeded');
  });

  it('kills a container that floods stdout and reports output limit exceeded', async () => {
    const twoMegabytes = Buffer.alloc(2 * 1024 * 1024, 'x');
    const container = fakeContainer({ frames: [encodeDockerFrame('stdout', twoMegabytes)], hang: true });
    mockDocker.createContainer.mockResolvedValue(container);
    const { default: executor } = await freshExecutor();

    const program = await executor.prepare('while True: print("x")', 'python');
    const result = await executor.run(program, '', LIMITS);

    expect(container.kill).toHaveBeenCalled();
    expect(result.status).toBe('output_limit_exceeded');
    expect(result.stdout.length).toBe(1024 * 1024);
  });

  it('treats an unreachable Docker daemon as a sandbox failure, not a verdict', async () => {
    mockDocker.getImage.mockReturnValue({
      inspect: vi.fn().mockRejectedValue(new Error('connect ENOENT /var/run/docker.sock')),
    });
    const { default: executor, SandboxUnavailableError } = await freshExecutor();

    await expect(executor.prepare('int main() {}', 'cpp')).rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(mockDocker.createContainer).not.toHaveBeenCalled();
  });

  it('fails fast with a retryable error while the circuit breaker is open', async () => {
    mockDocker.createContainer.mockImplementation(async () => fakeContainer({}));
    const { default: executor } = await freshExecutor();
    const program = await executor.prepare('print(1)', 'python');
    breakerState.open = true;

    const failure = await executor.run(program, '', LIMITS).catch((error: unknown) => error);

    expect(failure).toMatchObject({ name: 'SandboxUnavailableError', breakerOpen: true, retryAfterMs: 30000 });
  });

  it('rejects unsupported languages before touching Docker', async () => {
    const { default: executor } = await freshExecutor();

    await expect(executor.prepare('fn main() {}', 'rust')).rejects.toThrow('Unsupported language');
    expect(mockDocker.createContainer).not.toHaveBeenCalled();
  });

  it('removes containers left behind by a previous run of the same owner', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    mockDocker.listContainers.mockResolvedValue([{ Id: 'orphan-1' }, { Id: 'orphan-2' }]);
    mockDocker.getContainer.mockReturnValue({ remove });

    await freshExecutor();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(2));

    expect(mockDocker.listContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: ['leetcode.sandbox=true', 'leetcode.owner=test-owner'] },
    });
  });
});
