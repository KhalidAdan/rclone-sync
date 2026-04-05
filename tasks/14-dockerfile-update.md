# Task 14: Dockerfile Update

## Description

Update Dockerfile to support the audiobook archive application with proper volume mounts and startup.

## Implementation

Update `Dockerfile` to:
- Add volume mounts for `/data/` (for SQLite DB and staging directory)
- Ensure rclone config is available (via volume or env var)
- Set working directory appropriately
- Update CMD to run migrations then start the app
- Expose port 3001 for the React Router server

Update `.dockerignore` if needed.

Note: rclone daemon runs separately (not in container) - see PRD deployment section.
