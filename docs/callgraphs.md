# Callgraphs

_Audit date: 2026-08-06. Mermaid diagrams — GitHub renders these natively._

## 1. Module dependency graph

```mermaid
graph TD
    subgraph routes
        UP[api.upload.ts]
        DA[api.download-all.ts]
        DS[api.download-selected.ts]
        JOBS[_layout.jobs.tsx]
        ARCH[_layout.archive.tsx]
        IDX[_layout._index.tsx]
    end

    subgraph lib
        PIPE[pipeline.server.ts]
        DEC[decoder.server.ts]
        ARC[archiver.server.ts]
        WATCH[jobWatcher.server.ts]
        RC[rclone.server.ts]
        CFG[config.server.ts]
        ENV[env.server.ts]
        LOG[logger.server.ts]
        START[startup.server.ts]:::dead
    end

    subgraph external
        CULVERT["@culvert/stream + zip"]
        ARCHIVER["npm archiver (redundant)"]:::smell
        FFMPEG[ffmpeg subprocess]
        RCLONE[rclone rcd HTTP]
        DB[(SQLite / Drizzle)]
    end

    UP --> CULVERT
    UP --> PIPE
    PIPE --> DEC --> FFMPEG
    PIPE --> ARC
    ARC --> RC
    ARC --> WATCH
    WATCH --> RC
    WATCH --> ARC
    RC --> RCLONE
    DA --> CULVERT
    DS --> ARCHIVER
    DA --> WATCH
    DS --> WATCH
    JOBS --> ARC
    JOBS --> RC
    ARCH --> RC
    UP & PIPE & ARC & WATCH & JOBS & IDX & DA & DS --> DB
    CFG --> ENV
    START -.->|"never called by anyone"| WATCH

    classDef dead fill:#fdd,stroke:#c00,stroke-dasharray: 5 5;
    classDef smell fill:#ffd,stroke:#a80;
```

Notes:
- `startup.server.ts` (crash recovery) and `config.validateConfig()` have **no
  callers** — the red dashed node is dead code.
- `archiver.server.ts ↔ jobWatcher.server.ts` is a genuine cycle, papered over
  with a dynamic `import()` of `rclone.server` inside `archiver.server.ts`.
- Two ZIP implementations coexist (`@culvert/zip` in download-all, npm
  `archiver` in download-selected).

## 2. Upload → decode → archive pipeline (happy path)

```mermaid
sequenceDiagram
    participant B as Browser (XHR)
    participant U as api.upload action
    participant P as pipeline.processJob
    participant F as ffmpeg
    participant A as archiver.startOrQueueArchive
    participant R as rclone rcd
    participant W as jobWatcher.watchJob

    B->>U: POST /api/upload?destinationPath=…
    U->>U: insert job UPLOADING
    U->>U: pipe(fromReadableStream, tap(progress), writeTo(staging/<id>/<file>.aax))
    U->>U: update job STAGED (sizeBytes)
    U--)P: processJob(jobId)  [fire-and-forget]
    U-->>B: { jobId }  (client marks card "done" here!)

    P->>P: update DECODING
    P->>F: spawn ffmpeg -activation_bytes … -c copy → .m4b
    F-->>P: exit 0
    P->>P: update DECODED
    P->>A: startOrQueueArchive(jobId)
    A->>A: any job ARCHIVING? → yes: set QUEUED & return
    A->>R: POST operations/copyfile {_async} (copies the .aax)
    R-->>A: { jobid }
    A->>A: update ARCHIVING + rcloneJobId
    A--)W: watchJob(id, rcloneJobId) [in-memory setInterval 5s]

    loop every 5s until finished
        W->>R: POST job/status
    end
    R-->>W: finished, success
    W->>W: update VERIFYING
    W->>R: POST operations/list (destination dir)
    R-->>W: list contains filename?
    W->>W: update COMPLETED, log event
    W->>W: cleanupAax (keep .m4b for download)
    W->>W: startNextQueued()
```

The dotted async arrows are the fragile joints: `processJob` and `watchJob`
survive only as long as the Node process does, and nothing reconstructs them
after a restart (recovery module is never wired).

## 3. Failure & retry paths

```mermaid
flowchart TD
    ANY[any step] -->|server restart| STUCK["job frozen in UPLOADING /\nDECODING / ARCHIVING / VERIFYING\n(recoverOrphanedJobs never runs)"]
    DECODE[DECODING] -->|ffmpeg exit != 0| DF[DECODE_FAILED]
    ARCH[ARCHIVING] -->|rclone job error| AF[ARCHIVE_FAILED]
    ARCH -->|any watcher fetch error,\neven transient| AF
    VER[VERIFYING] -->|filename not in listing| VF[VERIFY_FAILED]

    DF -->|"retry → sets STAGED,\ncalls processJob"| RD["re-decode\n(ffmpeg has no -y →\nfails if partial .m4b exists)"]
    AF & VF -->|"retry → sets STAGED,\ncalls startOrQueueArchive"| RA["re-archive .aax\n(status STAGED is a lie;\njobs-page loader may also\nkick STAGED jobs to archive,\nskipping decode)"]
```

## 4. Download flows

```mermaid
flowchart LR
    subgraph download-all ["/api/download-all (culvert)"]
        A1[findReadyJobs:\nDECODED..COMPLETED,\nnot downloaded] --> A2[filter: .m4b exists on disk]
        A2 --> A3["createZip(addFile per job)\n⚠ default deflate, should be store"]
        A3 --> A4[onSuccessfulDrain:\nmark downloadedAt +\ncleanupFull for COMPLETED\nonly after client drains fully]
        A4 --> A5[stream Response]
    end

    subgraph download-selected ["/api/download-selected (npm archiver)"]
        B1[jobs by ids, same statuses] --> B2[filter: .m4b exists]
        B2 --> B3["archiver zip level 0\n⚠ buffers ENTIRE zip in memory\nvia controller.enqueue"]
        B3 --> B4["⚠ marks downloadedAt +\ndeletes staging BEFORE\nresponse streams"]
        B4 --> B5[Response]
    end
```

## 5. UI data flow (the progress split-brain)

```mermaid
flowchart TD
    subgraph upload page ["/ (upload page)"]
        Q[local React queue state] -->|XHR percent| CARDS[FileCard ring 0–25%]
        CARDS -->|"card says DONE at\nserver-received —\ndecode/archive invisible"| GAP1[⚠ page refresh loses queue]
        LOADER1[loader: 50 recent jobs] -->|only used for\ncounts in banner| BANNER[View Jobs banner]
    end

    subgraph jobs page ["/jobs"]
        LOADER2[loader: paginated jobs\n+ events + rclone core/stats] --> TABLE[status groups + timelines]
        LOADER2 -->|"⚠ side effect in GET:\nstartOrQueueArchive(staged[0])"| MUT[state mutation]
        STATS["core/stats.bytes is GLOBAL\ncumulative since daemon start\n⚠ % wrong after first job"] --> TABLE
    end

    POLL[setInterval revalidate 3s] --> LOADER1 & LOADER2
```

The ProgressRing component supports `ARCHIVING/VERIFYING/COMPLETED` stages,
but the upload page only ever feeds it local XHR state — the server pipeline
stages are dead UI states. That is the root of the "data pipeline across
pages" pain.
