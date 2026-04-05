# Task 10: Upload Route

## Description

Create the upload page with drag-and-drop zone in `app/routes/_layout._index.tsx`.

## Implementation

Create `app/routes/_layout._index.tsx`:

**Loader**: Returns list of staged/queued files

**Action**:
- Uses `@remix-run/form-data-parser` to stream uploaded file to `/data/staging/{uuid}/`
- Creates DB row with status STAGED
- Calls `startOrQueueArchive(id)` to begin archive or queue
- Returns { id, filename, sizeBytes, destinationPath }

**UI**:
- Drag-and-drop zone for file upload
- Text input for destination path (optional)
- Submit button
- Shows upload progress

Uses `<Form encType="multipart/form-data">` from React Router.
