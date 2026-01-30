# Changelog

All notable changes to this project will be documented in this file.

> This project is forked from [samzong/clawdbot-plugin-feishu](https://github.com/samzong/clawdbot-plugin-feishu). Thanks to the original author for the foundation.

## [0.1.8] - 2025-01-30

### Changed

- **Simplified media handling**: Removed custom `![name](file://path)` format from reply-dispatcher
  - Media sending now only handled through Clawdbot's standard `outbound.sendMedia` interface
  - This aligns with Clawdbot's architecture - channel adapts to framework, not vice versa
  - Cleaner codebase, less confusion for Agent

### Fixed

- **File path resolution** (from v0.1.7): Searches multiple directories for relative paths
  - Searches: cwd, home, ~/.clawdbot, /workspaces
  - Better error messages

## [0.1.7] - 2025-01-30

### Fixed

- **File path resolution**: Now searches multiple directories for relative paths

## [0.1.6] - 2025-01-30

### Changed

- **File sending format**: Added `![name](file:///path)` format (now removed in v0.1.8)

## [0.1.5] - 2025-01-30

### Added

- **Auto-detect media files in replies** (now removed in v0.1.8)

### Fixed

- **Mention formatting in replies**: Agent replies now properly convert mentions to Feishu native format

## [0.1.4] - 2025-01-30

### Added

- **Full message type support for receiving**: Now parses all Feishu message types
  - image, file, audio, media, sticker, interactive, share_chat, share_user, post, location, video_chat, system

### Fixed

- **sendMedia error logging**: Now logs errors when media upload fails

## [0.1.3] - 2025-01-30

### Fixed

- **Batch Processing Debounce**: Increased debounce from 500ms to 2000ms, added max wait timer (10s)

## [0.1.2] - 2025-01-30

### Fixed

- **WebSocket Auto-Reconnect**: Exponential backoff reconnection (1s-60s, 20 attempts)

### Changed

- **Mention Format**: Uses Feishu native format throughout

## [0.1.1] - 2025-01-30

### Fixed

- **Mention Format Conversion**: `@[Name](open_id)` converts to Feishu native `<at>` tags

## [0.1.0] - 2025-01-29

### Added

- **Batch Message Processing**: Human-like message handling for group chats
- **History Messages API**: `listMessages()` for fetching chat history

## [0.0.3 - 0.0.9] - 2025-01-27 to 2025-01-29

- Initial fork and various fixes
