import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs
vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock Docker
vi.mock('dockerode', () => {
  const mockContainer = {
    attach: vi.fn().mockResolvedValue({
      on: vi.fn((event, callback) => {
        if (event === 'data') {
          setTimeout(() => callback(Buffer.from('42\n')), 10);
        }
        if (event === 'end') {
          setTimeout(() => callback(), 20);
        }
      }),
      destroy: vi.fn(),
    }),
    start: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };

  const mockImage = {
    id: 'mock-image-id',
  };

  return {
    default: vi.fn().mockImplementation(() => ({
      createContainer: vi.fn().mockResolvedValue(mockContainer),
      getImage: vi.fn().mockReturnValue({
        inspect: vi.fn().mockResolvedValue(mockImage),
      }),
      pull: vi.fn().mockImplementation((_image, callback) => {
        callback(null, { pipe: vi.fn() });
      }),
      modem: {
        followProgress: vi.fn((_stream, callback) => callback(null, [])),
      },
    })),
  };
});

// Mock metrics
vi.mock('../shared/metrics.js', () => ({
  metrics: {
    activeContainers: { inc: vi.fn(), dec: vi.fn() },
    codeExecutionsTotal: { inc: vi.fn() },
    codeExecutionDuration: { observe: vi.fn() },
  },
}));

// Mock circuit breaker
vi.mock('../shared/circuitBreaker.js', () => ({
  createExecutionCircuitBreaker: vi.fn((fn) => ({
    fire: vi.fn((options) => fn(options)),
    fallback: vi.fn(),
  })),
  createFallback: vi.fn(() => () => ({
    status: 'system_error',
    error: 'Service temporarily unavailable',
  })),
}));

describe('CodeExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Language Configuration', () => {
    it('should support Python language', async () => {
      const { codeExecutor } = await import('./codeExecutor.js');
      await codeExecutor.init();

      // Test that execute returns without throwing for Python
      const result = await codeExecutor.execute(
        'print(42)',
        'python',
        '',
        5000,
        256
      );

      expect(result).toBeDefined();
      expect(result.status).toBeDefined();
    });

    it('should support JavaScript language', async () => {
      const { codeExecutor } = await import('./codeExecutor.js');
      await codeExecutor.init();

      const result = await codeExecutor.execute(
        'console.log(42)',
        'javascript',
        '',
        5000,
        256
      );

      expect(result).toBeDefined();
      expect(result.status).toBeDefined();
    });

    it('should return error for unsupported language', async () => {
      const { codeExecutor } = await import('./codeExecutor.js');
      await codeExecutor.init();

      const result = await codeExecutor.execute(
        'fn main() {}',
        'rust',
        '',
        5000,
        256
      );

      expect(result.status).toBe('system_error');
      expect(result.error).toContain('Unsupported language');
    });
  });

  describe('Output Comparison', () => {
    it('should compare outputs with whitespace normalization', async () => {
      const { compareOutput } = await import('./codeExecutor.js');

      // Exact match
      expect(compareOutput('42', '42')).toBe(true);

      // Trailing newline
      expect(compareOutput('42\n', '42')).toBe(true);
      expect(compareOutput('42', '42\n')).toBe(true);

      // Trailing spaces
      expect(compareOutput('42  ', '42')).toBe(true);

      // Different values
      expect(compareOutput('42', '43')).toBe(false);
    });

    it('should compare JSON arrays regardless of order', async () => {
      const { compareOutput } = await import('./codeExecutor.js');

      // Same order
      expect(compareOutput('[1, 2, 3]', '[1, 2, 3]')).toBe(true);

      // Different order (should match)
      expect(compareOutput('[1, 2, 3]', '[3, 2, 1]')).toBe(true);

      // Different values
      expect(compareOutput('[1, 2, 3]', '[1, 2, 4]')).toBe(false);
    });

    it('should handle floating point comparison', async () => {
      const { compareOutput } = await import('./codeExecutor.js');

      // Within tolerance
      expect(compareOutput('3.141592', '3.141593')).toBe(true);

      // Outside tolerance
      expect(compareOutput('3.14', '3.15')).toBe(false);
    });

    it('should handle multi-line output', async () => {
      const { compareOutput } = await import('./codeExecutor.js');

      expect(compareOutput('line1\nline2', 'line1\nline2')).toBe(true);
      expect(compareOutput('line1\r\nline2', 'line1\nline2')).toBe(true);
      expect(compareOutput('line1\nline2', 'line1\nline3')).toBe(false);
    });
  });

  describe('Security Configuration', () => {
    it('should create container with security restrictions', async () => {
      const Docker = (await import('dockerode')).default;
      const mockDocker = new Docker();
      const { codeExecutor } = await import('./codeExecutor.js');

      await codeExecutor.init();

      // Execute code which should create container
      await codeExecutor.execute('print(1)', 'python', '', 5000, 256);

      // Verify createContainer was called with security config
      expect(mockDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          HostConfig: expect.objectContaining({
            NetworkMode: 'none', // No network access
            ReadonlyRootfs: true, // Read-only root
            CapDrop: ['ALL'], // Drop all capabilities
            SecurityOpt: ['no-new-privileges'], // No privilege escalation
          }),
        })
      );
    });
  });
});

describe('Output Comparison Edge Cases', () => {
  it('should handle empty strings', async () => {
    const { compareOutput } = await import('./codeExecutor.js');

    expect(compareOutput('', '')).toBe(true);
    expect(compareOutput('', 'something')).toBe(false);
  });

  it('should handle whitespace-only output', async () => {
    const { compareOutput } = await import('./codeExecutor.js');

    expect(compareOutput('   ', '')).toBe(true);
    expect(compareOutput('\n\n', '')).toBe(true);
  });

  it('should handle nested arrays', async () => {
    const { compareOutput } = await import('./codeExecutor.js');

    expect(compareOutput('[[1,2],[3,4]]', '[[1,2],[3,4]]')).toBe(true);
  });
});
