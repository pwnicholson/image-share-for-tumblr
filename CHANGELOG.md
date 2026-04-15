# Changelog

All notable changes to this project will be documented in this file.

## 1.1.0 - 2026-04-14

### Added
- New WYSIWYG caption editor in the share dialog with toolbar controls for bold, italic, link, and unlink.
- Keyboard shortcuts in the caption editor: Ctrl/Cmd+B for bold and Ctrl/Cmd+I for italic.
- Link insertion mini-bar with URL input and apply/cancel behavior.
- Conservative broad context-menu compatibility fix that runs on most sites but only intercepts image-like right-clicks.
- YouPic coverage for the context-menu suppression workaround via broader content-script matching.

### Changed
- Caption input switched from plain textarea to HTML-capable contenteditable editor output suitable for Tumblr caption HTML.
- Enter-key handling in the editor improved so pressing Enter at end-of-line creates a visible blank line.
- Source link label now uses normalized root host/domain from the source URL (for example, `youpic.com`) instead of page title text.
- Metadata prefill now renders caption text into safe HTML line breaks for the editor.
- Internal project instructions updated to reflect expanded context-menu behavior and supported sites.

### Fixed
- WYSIWYG newline/carriage-return bug where Enter at the end of a line did not create a new blank line as expected.
- Context-menu suppression issue on YouPic pages where the browser menu (and extension menu item) could be blocked by site handlers.
