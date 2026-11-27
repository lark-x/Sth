import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = new URL('./main.ts', import.meta.url);
const built = new URL('./dist/index.html', import.meta.url);

if (existsSync(source)) {
  if (!process.env.npm_execpath) throw new Error('请通过 npm start 启动源码安装。');
  const result = spawnSync(process.execPath, [process.env.npm_execpath, 'run', 'build'], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else if (!existsSync(built)) {
  throw new Error('安装包缺少网页构建产物，请重新安装完整的 Sth 包。');
}
