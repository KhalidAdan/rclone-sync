# Task 11: Archive Browser Route

## Description

Create the archive browser in `app/routes/_layout.archive.tsx`.

## Implementation

Create `app/routes/_layout.archive.tsx`:

**Loader**:
- Calls rclone `operations/list` for the `audiobooks:` remote
- Returns file tree (directories and files with decrypted names)

**UI**:
- Displays file tree with folders and files
- Shows file sizes and dates if available
- Navigation to browse subdirectories
- Note: v1 intentionally read-only (no download/delete)

Reference: PRD section "Intentionally Excluded from v1"
