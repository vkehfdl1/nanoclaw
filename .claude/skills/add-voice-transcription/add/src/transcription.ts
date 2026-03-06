import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';

interface TranscriptionConfig {
  model: string;
  enabled: boolean;
}

export interface SlackAudioFileLike {
  mimetype?: string;
  filetype?: string;
  name?: string;
}

const DEFAULT_CONFIG: TranscriptionConfig = {
  model: 'whisper-1',
  enabled: true,
};

const AUDIO_EXTENSIONS = new Set([
  'aac',
  'm4a',
  'mp3',
  'mp4',
  'mpeg',
  'mpga',
  'oga',
  'ogg',
  'wav',
  'webm',
]);

function getFileExtension(filename?: string): string | null {
  if (!filename) return null;
  const ext = path.extname(filename).replace(/^\./, '').toLowerCase();
  return ext || null;
}

function guessMimeType(filename?: string, explicitMimeType?: string): string {
  if (explicitMimeType?.startsWith('audio/')) return explicitMimeType;

  switch (getFileExtension(filename)) {
    case 'aac':
      return 'audio/aac';
    case 'm4a':
      return 'audio/mp4';
    case 'mp3':
    case 'mpeg':
    case 'mpga':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'webm':
      return 'audio/webm';
    case 'oga':
    case 'ogg':
    default:
      return 'audio/ogg';
  }
}

export function isSlackAudioFile(file: SlackAudioFileLike): boolean {
  if (file.mimetype?.startsWith('audio/')) return true;
  if (file.filetype && AUDIO_EXTENSIONS.has(file.filetype.toLowerCase())) return true;
  const ext = getFileExtension(file.name);
  return !!ext && AUDIO_EXTENSIONS.has(ext);
}

async function transcribeWithOpenAI(
  audioBuffer: Buffer,
  fileName: string,
  mimeType: string,
  config: TranscriptionConfig,
): Promise<string | null> {
  const env = readEnvFile(['OPENAI_API_KEY']);
  const apiKey = env.OPENAI_API_KEY;

  if (!apiKey) {
    console.warn('OPENAI_API_KEY not set in .env');
    return null;
  }

  try {
    const openaiModule = await import('openai');
    const OpenAI = openaiModule.default;
    const toFile = openaiModule.toFile;

    const openai = new OpenAI({ apiKey });

    const file = await toFile(audioBuffer, fileName, { type: mimeType });
    const transcription = await openai.audio.transcriptions.create({
      file,
      model: config.model,
      response_format: 'text',
    });

    return transcription as unknown as string;
  } catch (err) {
    console.error('OpenAI transcription failed:', err);
    return null;
  }
}

export async function transcribeSlackAudioFile(
  filePath: string,
  options?: { mimeType?: string; fileName?: string },
): Promise<string | null> {
  const config = DEFAULT_CONFIG;
  if (!config.enabled) return null;

  let audioBuffer: Buffer;
  try {
    audioBuffer = fs.readFileSync(filePath);
  } catch (err) {
    console.error('Failed to read Slack audio file:', err);
    return null;
  }

  if (audioBuffer.length === 0) {
    console.error('Slack audio file was empty');
    return null;
  }

  const fileName = options?.fileName || path.basename(filePath);
  const mimeType = guessMimeType(fileName, options?.mimeType);
  const transcript = await transcribeWithOpenAI(
    audioBuffer,
    fileName,
    mimeType,
    config,
  );

  return transcript ? transcript.trim() : null;
}
