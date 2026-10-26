// Geliştirme: API (tsx watch) ve web (vite) süreçlerini birlikte başlatır, biri düşerse ikisini de kapatır.
import { spawn } from 'node:child_process';

const procs = [
  { name: 'api', color: '\x1b[32m', args: ['run', 'dev:api'] },
  { name: 'web', color: '\x1b[36m', args: ['run', 'dev:web'] },
].map(({ name, color, args }) => {
  const child = spawn('npm', args, { stdio: ['inherit', 'pipe', 'pipe'], env: process.env });
  const prefix = `${color}[${name}]\x1b[0m `;
  const pipe = (stream, out) =>
    stream.on('data', (buf) => {
      for (const line of buf.toString().split('\n')) if (line.trim()) out.write(prefix + line + '\n');
    });
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    console.log(`${prefix}çıktı (kod ${code}), diğer süreç kapatılıyor`);
    for (const p of procs) if (p !== child && p.exitCode === null) p.kill('SIGTERM');
    process.exitCode = code ?? 0;
  });
  return child;
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const p of procs) if (p.exitCode === null) p.kill('SIGTERM');
  });
}
