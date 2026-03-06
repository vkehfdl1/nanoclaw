import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('voice-transcription skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: voice-transcription');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('openai');
    expect(content).toContain('OPENAI_API_KEY');
  });

  it('has all files declared in adds', () => {
    const transcriptionFile = path.join(skillDir, 'add', 'src', 'transcription.ts');
    expect(fs.existsSync(transcriptionFile)).toBe(true);

    const content = fs.readFileSync(transcriptionFile, 'utf-8');
    expect(content).toContain('transcribeSlackAudioFile');
    expect(content).toContain('isSlackAudioFile');
    expect(content).toContain('transcribeWithOpenAI');
    expect(content).toContain('fs.readFileSync');
    expect(content).toContain('readEnvFile');
  });

  it('has all files declared in modifies', () => {
    const slackFile = path.join(skillDir, 'modify', 'src', 'channels', 'slack.ts');
    const slackTestFile = path.join(skillDir, 'modify', 'src', 'channels', 'slack.test.ts');

    expect(fs.existsSync(slackFile)).toBe(true);
    expect(fs.existsSync(slackTestFile)).toBe(true);
  });

  it('has intent files for modified files', () => {
    expect(fs.existsSync(path.join(skillDir, 'modify', 'src', 'channels', 'slack.ts.intent.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'modify', 'src', 'channels', 'slack.test.ts.intent.md'))).toBe(true);
  });

  it('modified slack.ts preserves core structure', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'slack.ts'),
      'utf-8',
    );

    // Core class and methods preserved
    expect(content).toContain('class SlackChannel');
    expect(content).toContain('implements Channel');
    expect(content).toContain('async connect()');
    expect(content).toContain('async sendMessage(');
    expect(content).toContain('isConnected()');
    expect(content).toContain('ownsJid(');
    expect(content).toContain('async disconnect()');
    expect(content).toContain('async sendFile(');
    expect(content).toContain('async syncChannels(');

    // Core imports preserved
    expect(content).toContain('ASSISTANT_NAME');
    expect(content).toContain("import { App, LogLevel } from '@slack/bolt'");
  });

  it('modified slack.ts includes transcription integration', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'slack.ts'),
      'utf-8',
    );

    // Transcription imports
    expect(content).toContain("import { isSlackAudioFile, transcribeSlackAudioFile } from '../transcription.js'");

    // Voice attachment handling
    expect(content).toContain('isSlackAudioFile(file)');
    expect(content).toContain('transcribeSlackAudioFile(filePath');
    expect(content).toContain('transcriptBlocks');
    expect(content).toContain('[Voice:');
    expect(content).toContain('[Voice Message - transcription unavailable]');
    expect(content).toContain('[Voice Message - transcription failed]');
  });

  it('modified slack.test.ts includes transcription mock and tests', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'slack.test.ts'),
      'utf-8',
    );

    // Transcription mock
    expect(content).toContain("vi.mock('../transcription.js'");
    expect(content).toContain('isSlackAudioFile');
    expect(content).toContain('transcribeSlackAudioFile');

    // Voice transcription test cases
    expect(content).toContain('transcribes audio attachments into message content');
    expect(content).toContain('falls back when audio transcription returns null');
    expect(content).toContain('falls back when audio transcription throws');
    expect(content).toContain('[Voice: hello from slack audio]');
  });

  it('modified slack.test.ts preserves all existing test sections', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'slack.test.ts'),
      'utf-8',
    );

    // All existing test describe blocks preserved
    expect(content).toContain("describe('connection lifecycle'");
    expect(content).toContain("describe('thread tracking via message events'");
    expect(content).toContain("describe('sendMessage — thread-aware response posting'");
    expect(content).toContain("describe('message filtering'");
    expect(content).toContain("describe('file handling'");
    expect(content).toContain("describe('syncChannels'");
  });
});
