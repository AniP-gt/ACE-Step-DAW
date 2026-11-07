import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.flac', '.ogg', '.opus', '.m4a', '.aac', '.aif', '.aiff']);
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;

export async function prepareAudioImport(params: Record<string, unknown>) {
  const { path, ...options } = params;
  if (typeof path !== 'string' || !AUDIO_EXTENSIONS.has(extname(path).toLowerCase())) {
    throw new Error('Provide a local audio file path with a supported audio extension.');
  }
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_AUDIO_BYTES) {
    throw new Error('The audio file must be a regular file no larger than 64 MiB.');
  }
  const bytes = await readFile(path);
  return { ...options, fileName: basename(path), audioBase64: bytes.toString('base64') };
}
