# Task 9: Layout Route

## Description

Create the shared layout route with navigation in `app/routes/_layout.tsx`.

## Implementation

Create `app/routes/_layout.tsx`:
- Renders navigation links: Upload (/) Archive (/archive) Jobs (/jobs)
- Uses React Router's Outlet for child routes
- Shared styling from app.css (Tailwind)

Routes structure in `app/routes.ts`:
```
layout(_layout.tsx)
  ├── _index(_layout._index.tsx) - Upload
  ├── archive(_layout.archive.tsx) - Archive browser
  └── jobs(_layout.jobs.tsx) - Job queue
```
