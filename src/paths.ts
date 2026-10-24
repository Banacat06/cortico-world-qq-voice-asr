import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** 本地 ASR 需要的路径；找不到的项为 null，错误信息里会列出找过的地方。 */
export interface ResolvedAsrPaths {
  python: string | null;
  modelDir: string | null;
  script: string;
  pythonCandidates: string[];
  modelCandidates: string[];
}

const MODEL_FILES = ['model_q8.onnx', 'model.onnx', 'model.int8.onnx'];

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 一个可用的 SenseVoice 目录：tokens.txt + 任意一种 onnx 权重。 */
export function isSenseVoiceDir(dir: string): boolean {
  if (!isDir(dir) || !existsSync(join(dir, 'tokens.txt'))) return false;
  return MODEL_FILES.some((name) => existsSync(join(dir, name)));
}

/**
 * 找 Python、模型和 asr_server.py。
 *
 * Coopanion 的布局（实测）：
 *   ctx.dataDir   = <data>\home\<bot>\data
 *   ctx.packageDir= <data>\extensions\vendor\<pkg>   （手动安装）
 *                   <data>\extensions\node_modules\<pkg>（依赖安装）
 * 所以 `<data>\extensions` 既可以从 packageDir 往上两级得到，也可以从 dataDir 往上三级得到。
 * 两个都试，不扫盘。
 */
export function resolveAsrPaths(opts: {
  packageDir: string;
  dataDir: string;
  pythonPath?: string;
  modelPath?: string;
}): ResolvedAsrPaths {
  const dataRoots = unique([
    resolve(opts.dataDir, '..', '..', '..'),
    resolve(opts.dataDir, '..', '..'),
  ]);
  const extensionRoots = unique([
    resolve(opts.packageDir, '..', '..'),
    ...dataRoots.map((root) => join(root, 'extensions')),
  ]);

  const pythonCandidates = unique([
    ...(opts.pythonPath ? [opts.pythonPath] : []),
    ...extensionRoots.map((root) => join(root, 'venv_vox', 'Scripts', 'python.exe')),
    ...extensionRoots.map((root) => join(root, 'venv', 'Scripts', 'python.exe')),
    join(opts.packageDir, '.venv', 'Scripts', 'python.exe'),
    'python',
  ]);
  const python = pythonCandidates.find((p) => p === 'python' || existsSync(p)) ?? null;

  const modelCandidates = unique([
    ...(opts.modelPath ? [opts.modelPath] : []),
    ...extensionRoots.map((root) => join(root, 'vendor', 'asr-model', 'sherpa-onnx-sense-voice')),
    ...dataRoots.map((root) => join(root, 'home', 'models', 'desktop-pet', 'sensevoice-small-int8-2024-07-17')),
    join(opts.packageDir, 'models', 'sherpa-onnx-sense-voice'),
  ]);
  const modelDir = modelCandidates.find(isSenseVoiceDir) ?? null;

  return {
    python,
    modelDir,
    script: join(opts.packageDir, 'asr_server.py'),
    pythonCandidates,
    modelCandidates,
  };
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
