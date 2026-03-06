# Intent: src/channels/slack.test.ts modifications

## What changed
Added a transcription mock and three Slack-specific tests covering audio attachment transcription.

## Key sections

### Mocks
- Added: `vi.mock('../transcription.js', ...)`
- Added: `transcribeSlackAudioFile` import for assertions
- Added: `fetch` stub setup for file download responses

### File handling tests
- Added: `transcribes audio attachments into message content`
- Added: `falls back when audio transcription returns null`
- Added: `falls back when audio transcription throws`

## Invariants (must-keep)
- Existing connection lifecycle tests unchanged
- Existing thread tracking tests unchanged
- Existing sendMessage tests unchanged
- Existing message filtering tests unchanged
- Existing syncChannels tests unchanged
