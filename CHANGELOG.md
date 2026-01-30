# Changelog

All notable changes to this project will be documented in this file.

> This project is forked from [samzong/clawdbot-plugin-feishu](https://github.com/samzong/clawdbot-plugin-feishu). Thanks to the original author for the foundation.

## [0.1.7] - 2025-01-30

### Fixed

- **File path resolution**: Now searches multiple directories for relative paths
  - Searches: current working directory, home directory, ~/.clawdbot, /workspaces
  - Better error messages showing which paths were searched
  - Fixes "Local file not found" errors when Agent uses relative paths

## [0.1.6] - 2025-01-30

### Changed

- **File sending format**: Use explicit `![name](file:///path)` format instead of auto-detecting paths
  - Avoids false positives with normal text that looks like paths
  - Similar to Markdown image syntax, easy for Agent to learn
  - Examples:
    - `![图片](file:///home/user/image.png)` - absolute path
    - `![报告](file://./docs/report.pdf)` - relative path  
    - `![Photo](https://example.com/photo.jpg)` - URL
  - Agent prompt updated with file sending instructions

## [0.1.5] - 2025-01-30

### Added

- **Auto-detect and send media files in replies**: Agent can now send files by outputting file paths
  - Automatically detects file paths (e.g., `/path/to/image.png`, `./file.pdf`, `https://example.com/file.jpg`)
  - Uploads and sends as native Feishu image/file message
  - Falls back to text link if upload fails
  - Supports: images, documents, audio, video, archives, and more

### Fixed

- **Mention formatting in replies**: Agent replies now properly convert mentions to Feishu native format

## [0.1.4] - 2025-01-30

### Added

- **Full message type support for receiving**: Now parses all Feishu message types
  - `image` → `[图片: image_key]`
  - `file` → `[文件: filename (file_key)]`
  - `audio` → `[语音消息: file_key]`
  - `media` → `[媒体: filename]`
  - `sticker` → `[表情包: file_key]`
  - `interactive` → `[卡片: title]` or `[交互卡片]`
  - `share_chat` → `[分享群聊: chat_id]`
  - `share_user` → `[分享用户: user_id]`
  - `post` → Extracts text content or `[富文本: title]`
  - `location` → `[位置: name]`
  - `video_chat` → `[视频会议]`
  - `system` → `[系统消息]`
  - Unknown types → `[type消息]`

### Fixed

- **sendMedia error logging**: Now logs errors when media upload fails instead of silently falling back to URL text

## [0.1.3] - 2025-01-30

### Fixed

- **Batch Processing Debounce**: Fixed rapid message triggering issue
  - Increased debounce from 500ms to 2000ms - wait for user to finish typing before responding
  - Added max wait timer (10s) - ensures response even if messages keep coming
  - Previously, each @mention would trigger a separate response; now batches all messages properly
  - Added detailed logging for debugging batch processor behavior

## [0.1.2] - 2025-01-30

### Fixed

- **WebSocket Auto-Reconnect**: Gateway now automatically reconnects when connection drops
  - Exponential backoff: 1s → 2s → 4s → ... → 60s (max)
  - Up to 20 retry attempts before giving up
  - Detailed logging for connection state changes

### Changed

- **Mention Format**: Now uses Feishu native format throughout

## [0.1.1] - 2025-01-30

### Fixed

- **Mention Format Conversion**: `@[Name](open_id)` now correctly converts to Feishu native `<at user_id="...">` tags

## [0.1.0] - 2025-01-29

### Added

- **Batch Message Processing**: Human-like message handling for group chats
- **History Messages API**: `listMessages()` for fetching chat history with pagination

## [0.0.9] - 2025-01-29

### Fixed

- **Message History Order**: `feishu_list_messages` now returns newest messages first

## [0.0.3 - 0.0.8] - 2025-01-27 to 2025-01-28

- Initial fork and various fixes
