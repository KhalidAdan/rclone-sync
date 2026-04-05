# Task 29: rclone Mock HTTP Server

## Problem

- Tests calling real rclone RC is unreliable
- Can't simulate failures or slow responses
- Need to control job completion timing

## Solution

Create mock HTTP server that simulates rclone RC API.

## Steps

1. Create `tests/helpers/rclone-mock.ts`:
   ```ts
   import { createServer } from "node:http";
   
   interface RcloneMockOptions {
     pollsBeforeComplete?: number;
     shouldFail?: boolean;
   }
   
   export function createRcloneMock(opts: RcloneMockOptions = {}) {
     let jobIdCounter = 1;
     let pollCount = 0;
     const pollsNeeded = opts.pollsBeforeComplete ?? 2;
   
     const server = createServer((req, res) => {
       let body = "";
       req.on("data", (chunk) => (body += chunk));
       req.on("end", () => {
         const url = req.url ?? "";
         res.setHeader("Content-Type", "application/json");
   
         if (url === "/operations/copyfile") {
           const jobid = jobIdCounter++;
           pollCount = 0;
           res.end(JSON.stringify({ jobid }));
         } else if (url === "/job/status") {
           pollCount++;
           const finished = pollCount >= pollsNeeded;
           res.end(JSON.stringify({
             finished,
             success: finished && !opts.shouldFail,
             error: finished && opts.shouldFail ? "simulated rclone error" : "",
           }));
         } else if (url === "/operations/list") {
           res.end(JSON.stringify({ list: [{ Name: "test.m4b", Size: 1024 }] }));
         } else if (url === "/core/stats") {
           res.end(JSON.stringify({ bytes: 512, speed: 1024, eta: 5 }));
         } else if (url === "/core/version") {
           res.end(JSON.stringify({ version: "v1.65.0" }));
         } else {
           res.statusCode = 404;
           res.end(JSON.stringify({ error: "unknown endpoint" }));
         }
       });
     });
   
     return {
       start: () => new Promise<number>((resolve) => {
         server.listen(0, () => {
           const addr = server.address();
           resolve(typeof addr === "object" ? addr!.port : 0);
         });
       }),
       close: () => new Promise<void>((resolve) => server.close(() => resolve())),
       server,
     };
   }
   ```

2. Use in tests:
   ```ts
   const rcloneMock = createRcloneMock({ pollsBeforeComplete: 2 });
   const port = await rcloneMock.start();
   process.env.RCLONE_URL = `http://localhost:${port}`;
   // ... run tests
   await rcloneMock.close();
   ```

## Files to Create
- `tests/helpers/rclone-mock.ts`

## Dependencies
- None (uses built-in node:http)

## References
- PRD Section 5c: Mock rclone RC server