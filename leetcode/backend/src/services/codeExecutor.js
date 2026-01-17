const Docker = require('dockerode');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const docker = new Docker();

// Resource limits per language
const LANGUAGE_CONFIG = {
  python: {
    image: 'python:3.11-alpine',
    extension: '.py',
    command: (file) => ['python3', file],
    timeout: 10000,
    memoryMb: 256
  },
  javascript: {
    image: 'node:20-alpine',
    extension: '.js',
    command: (file) => ['node', file],
    timeout: 8000,
    memoryMb: 256
  }
};

class CodeExecutor {
  constructor() {
    this.tempDir = path.join(os.tmpdir(), 'leetcode-sandbox');
  }

  async init() {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
      console.log(`Code executor initialized, temp dir: ${this.tempDir}`);
    } catch (error) {
      console.error('Failed to initialize code executor:', error);
    }
  }

  async execute(code, language, input, timeLimit = 5000, memoryLimit = 256) {
    const config = LANGUAGE_CONFIG[language];
    if (!config) {
      return {
        status: 'system_error',
        error: `Unsupported language: ${language}`
      };
    }

    const executionId = uuidv4();
    const workDir = path.join(this.tempDir, executionId);
    const codeFile = `solution${config.extension}`;
    const codePath = path.join(workDir, codeFile);
    const inputPath = path.join(workDir, 'input.txt');

    try {
      // Create work directory
      await fs.mkdir(workDir, { recursive: true });

      // Write code and input files
      await fs.writeFile(codePath, code);
      await fs.writeFile(inputPath, input);

      const startTime = Date.now();

      // Execute in Docker container
      const result = await this.runInContainer({
        image: config.image,
        workDir,
        codeFile,
        command: config.command(`/code/${codeFile}`),
        timeout: Math.min(timeLimit, config.timeout),
        memoryMb: Math.min(memoryLimit, config.memoryMb)
      });

      const executionTime = Date.now() - startTime;

      return {
        ...result,
        executionTime
      };
    } catch (error) {
      console.error('Execution error:', error);
      return {
        status: 'system_error',
        error: error.message,
        executionTime: 0
      };
    } finally {
      // Cleanup
      try {
        await fs.rm(workDir, { recursive: true, force: true });
      } catch (e) {
        console.error('Cleanup error:', e);
      }
    }
  }

  async runInContainer({ image, workDir, codeFile, command, timeout, memoryMb }) {
    let container = null;

    try {
      // Pull image if not exists (with timeout)
      try {
        await docker.getImage(image).inspect();
      } catch {
        console.log(`Pulling image: ${image}`);
        await new Promise((resolve, reject) => {
          docker.pull(image, (err, stream) => {
            if (err) return reject(err);
            docker.modem.followProgress(stream, (err, output) => {
              if (err) return reject(err);
              resolve(output);
            });
          });
        });
      }

      // Create container with security restrictions
      container = await docker.createContainer({
        Image: image,
        Cmd: command,
        WorkingDir: '/code',
        HostConfig: {
          Binds: [`${workDir}:/code:ro`],
          Memory: memoryMb * 1024 * 1024,
          MemorySwap: memoryMb * 1024 * 1024, // No swap
          CpuPeriod: 100000,
          CpuQuota: 50000, // 50% of one CPU
          PidsLimit: 50,
          NetworkMode: 'none',
          ReadonlyRootfs: false,
          SecurityOpt: ['no-new-privileges'],
          CapDrop: ['ALL'],
          AutoRemove: true
        },
        OpenStdin: true,
        StdinOnce: true,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false
      });

      // Read input file
      const input = await fs.readFile(path.join(workDir, 'input.txt'), 'utf8');

      // Start container
      const stream = await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true
      });

      await container.start();

      // Send input
      stream.write(input);
      stream.end();

      // Collect output with timeout
      const { stdout, stderr, timedOut } = await this.collectOutput(container, stream, timeout);

      if (timedOut) {
        return {
          status: 'time_limit_exceeded',
          stdout: stdout.substring(0, 1000),
          stderr: stderr.substring(0, 1000)
        };
      }

      // Wait for container to finish
      const waitResult = await container.wait();

      if (waitResult.StatusCode !== 0) {
        return {
          status: 'runtime_error',
          stdout: stdout.substring(0, 1000),
          stderr: stderr.substring(0, 1000),
          exitCode: waitResult.StatusCode
        };
      }

      return {
        status: 'success',
        stdout: stdout.trim(),
        stderr: stderr.substring(0, 1000)
      };
    } catch (error) {
      console.error('Container error:', error);

      // Check for OOM
      if (error.message && error.message.includes('OOMKilled')) {
        return {
          status: 'memory_limit_exceeded',
          error: 'Out of memory'
        };
      }

      return {
        status: 'system_error',
        error: error.message
      };
    } finally {
      // Ensure container is stopped and removed
      if (container) {
        try {
          await container.stop({ t: 0 }).catch(() => {});
          await container.remove({ force: true }).catch(() => {});
        } catch (e) {
          // Container might already be removed due to AutoRemove
        }
      }
    }
  }

  async collectOutput(container, stream, timeout) {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timeoutId = setTimeout(async () => {
        timedOut = true;
        try {
          await container.stop({ t: 0 });
        } catch (e) {
          // Ignore
        }
        resolve({ stdout, stderr, timedOut: true });
      }, timeout);

      // Docker multiplexed stream format
      stream.on('data', (chunk) => {
        // First 8 bytes are header (stream type + size)
        // For simplicity, treat all as stdout
        const text = chunk.toString('utf8');
        // Remove Docker stream headers (non-printable chars at start)
        const cleaned = text.replace(/^[\x00-\x08]/g, '');
        stdout += cleaned;
      });

      container.wait().then(() => {
        clearTimeout(timeoutId);
        if (!timedOut) {
          resolve({ stdout, stderr, timedOut: false });
        }
      }).catch(() => {
        clearTimeout(timeoutId);
        if (!timedOut) {
          resolve({ stdout, stderr, timedOut: false });
        }
      });
    });
  }

  compareOutput(actual, expected) {
    // Normalize whitespace
    const normalize = (s) => s.trim().replace(/\r\n/g, '\n').replace(/\s+$/gm, '');

    const actualNorm = normalize(actual);
    const expectedNorm = normalize(expected);

    if (actualNorm === expectedNorm) {
      return true;
    }

    // Try parsing as JSON for array comparison
    try {
      const actualJson = JSON.parse(actualNorm);
      const expectedJson = JSON.parse(expectedNorm);

      // For arrays, sort if order doesn't matter (for problems like Two Sum)
      if (Array.isArray(actualJson) && Array.isArray(expectedJson)) {
        // Try both sorted and unsorted comparison
        if (JSON.stringify(actualJson) === JSON.stringify(expectedJson)) {
          return true;
        }
        // Sort and compare for problems where order doesn't matter
        const sortedActual = [...actualJson].sort((a, b) => a - b);
        const sortedExpected = [...expectedJson].sort((a, b) => a - b);
        if (JSON.stringify(sortedActual) === JSON.stringify(sortedExpected)) {
          return true;
        }
      }
    } catch {
      // Not JSON, continue with string comparison
    }

    // Handle floating point comparison
    const actualNum = parseFloat(actualNorm);
    const expectedNum = parseFloat(expectedNorm);
    if (!isNaN(actualNum) && !isNaN(expectedNum)) {
      return Math.abs(actualNum - expectedNum) < 1e-6;
    }

    return false;
  }
}

module.exports = new CodeExecutor();
