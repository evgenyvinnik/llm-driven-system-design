// Frees ports 3000 (web) and 3001 (API) before `npm run dev`. It only stops processes started
// from this project, so another project using port 3000 is reported rather than killed.
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTS = [3000, 3001];

function run(command) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

let blocked = false;
for (const port of PORTS) {
  const pids = run(`lsof -ti tcp:${port} -sTCP:LISTEN`).split('\n').filter(Boolean);
  for (const pid of pids) {
    const cwd = run(`lsof -a -p ${pid} -d cwd -Fn`).split('\n').find((line) => line.startsWith('n'))?.slice(1) ?? '';
    const command = run(`ps -o command= -p ${pid}`);
    if (cwd.startsWith(PROJECT_DIR) || command.includes(PROJECT_DIR)) {
      process.kill(Number(pid), 'SIGTERM');
      console.log(`[stop] stopped pid ${pid} on port ${port}`);
    } else {
      blocked = true;
      console.warn(`[stop] port ${port} is used by another project (pid ${pid}: ${command}). Stop it first.`);
    }
  }
}
process.exit(blocked ? 1 : 0);
