# Task 26: Health Check Endpoint

## Problem

- No way to check app health for monitoring
- Docker/systemd health checks need HTTP endpoint
- Need to verify DB and rclone connectivity

## Solution

Create `/health` route that returns JSON status.

## Steps

1. Create `app/routes/health.tsx`:
   - Export loader function
   - Perform checks:
     - DB: `db.select().from(jobs).limit(1)` - verify connection
     - rclone: `POST ${config.rcloneUrl}/core/version` with timeout
   - Build checks object: { database: "ok" | "error", rclone: "ok" | "error" }
   - Return 200 with { status: "healthy", checks } if all ok
   - Return 503 with { status: "degraded", checks } if any failed
   - Set Content-Type: application/json

2. Configure health check in:
   - Docker: `HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 curl -f http://localhost:3001/health`
   - systemd: Use same curl command

## Files to Create
- `app/routes/health.tsx`

## References
- PRD Section 6f: Health check endpoint