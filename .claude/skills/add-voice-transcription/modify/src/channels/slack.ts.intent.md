# Intent: src/channels/slack.ts modifications

## What changed
Added audio attachment transcription support for Slack. When a Slack message includes an audio file, the file is downloaded, transcribed with OpenAI Whisper, and the transcript is appended to the inbound message as `[Voice: <transcript>]`.

## Key sections

### Imports (top of file)
- Added: `isSlackAudioFile`, `transcribeSlackAudioFile` from `../transcription.js`
- Added: `SlackFileAttachment` interface for file metadata

### File download loop
- Added audio file detection via `isSlackAudioFile(file)`
- Added transcription call after the file is saved locally
- Added transcript accumulation in `transcriptBlocks`
  - Success: append `[Voice: <transcript>]`
  - Null result: append `[Voice Message - transcription unavailable]`
  - Error: append `[Voice Message - transcription failed]`

### Content assembly
- Changed: message content now includes transcript blocks before the `[file: ...]` references

## Invariants (must-keep)
- Existing Slack auth and Socket Mode flow unchanged
- Existing bot-message filtering unchanged
- Existing file download behavior unchanged for non-audio files
- Existing thread handling unchanged
- Existing sendMessage/sendFile/syncChannels behavior unchanged
