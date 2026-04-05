# Task 2: Configure TypeScript Paths

## Description

Add path aliases to tsconfig.json so imports like `@/db/schema` and `@/lib/archiver.server` resolve correctly.

## Implementation

Update `tsconfig.json` to include:

```json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./app/*"]
    }
  }
}
```
