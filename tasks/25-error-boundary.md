# Task 25: Error Boundary in UI

## Problem

- No error boundary for routes
- Loader/action errors show default browser/page errors
- User sees unhelpful messages on failures

## Solution

Wrap layout with React Router ErrorBoundary.

## Steps

1. Modify `app/routes/_layout.tsx`:
   - Import `useRouteError` from "react-router"
   - Add ErrorBoundary component:
     ```tsx
     export function ErrorBoundary() {
       const error = useRouteError();
       return (
         <div className="p-8 max-w-lg mx-auto">
           <h1 className="text-xl font-bold text-red-600">Something went wrong</h1>
           <p className="mt-2 text-gray-700">
             {error instanceof Error ? error.message : "An unexpected error occurred."}
           </p>
           <a href="/" className="mt-4 inline-block text-blue-600 underline">
             Back to upload
           </a>
         </div>
       );
     }
     ```

2. Test error boundary:
   - Throw error in a loader to verify display

## Files to Modify
- `app/routes/_layout.tsx`

## References
- PRD Section 6e: Error boundaries in the UI