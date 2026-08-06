const FAIL_STAGES = [
  "UPLOAD_FAILED",
  "DECODE_FAILED",
  "ARCHIVE_FAILED",
  "VERIFY_FAILED",
];

// The ring tells the whole story: 0–25% upload, 25–50% decode,
// 50–75% archive to B2, 75–100% verify. A book is only "done" when it is
// verified safe in the archive.
const STAGE_BASE: Record<string, number> = {
  PENDING: 0,
  UPLOADING: 0,
  STAGED: 0.25,
  DECODING: 0.375,
  DECODED: 0.5,
  QUEUED: 0.5,
  ARCHIVING: 0.5,
  VERIFYING: 0.75,
  COMPLETED: 1,
};

const FAIL_PROGRESS: Record<string, number> = {
  UPLOAD_FAILED: 0.25,
  DECODE_FAILED: 0.5,
  ARCHIVE_FAILED: 0.75,
  VERIFY_FAILED: 0.9,
};

interface ProgressRingProps {
  stage: string;
  uploadPercent?: number;
  archivePercent?: number;
  size?: number;
  stroke?: number;
}

export function ProgressRing({
  stage,
  uploadPercent = 0,
  archivePercent,
  size = 88,
  stroke = 5,
}: ProgressRingProps) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const isFailed = FAIL_STAGES.includes(stage);
  const isDone = stage === "COMPLETED";

  let progress: number;
  if (isFailed) {
    progress = FAIL_PROGRESS[stage] ?? 0.5;
  } else {
    progress = STAGE_BASE[stage] ?? 0;
    if (stage === "UPLOADING") {
      progress += (uploadPercent / 100) * 0.25;
    } else if (stage === "ARCHIVING" && archivePercent !== undefined) {
      progress += (Math.min(100, archivePercent) / 100) * 0.25;
    }
  }

  const dashoffset = circumference * (1 - progress);

  const ringColor = isFailed
    ? "var(--ring-fail)"
    : isDone
    ? "var(--ring-done)"
    : "var(--ring-active)";

  const trackColor = isFailed ? "var(--ring-fail-track)" : "var(--ring-track)";

  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={trackColor}
        strokeWidth={stroke}
        strokeLinecap="round"
        opacity="0.25"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={ringColor}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashoffset}
        style={{ transition: "stroke-dashoffset 400ms ease, stroke 300ms ease" }}
      />
    </svg>
  );
}

interface StageIconProps {
  stage: string;
}

export function StageIcon({ stage }: StageIconProps) {
  const isFailed = FAIL_STAGES.includes(stage);
  if (stage === "COMPLETED") {
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <path
          d="M5 10.5L8.5 14L15 7"
          stroke="var(--ring-done)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (isFailed) {
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <path d="M6 6L14 14M14 6L6 14" stroke="var(--ring-fail)" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: "var(--ring-active)",
        display: "block",
        animation: "pulse-dot 1.5s ease-in-out infinite",
      }}
    />
  );
}

export function stageLabel(stage: string): string {
  const map: Record<string, string> = {
    PENDING: "Waiting…",
    UPLOADING: "Uploading…",
    STAGED: "Staged",
    DECODING: "Decoding…",
    DECODED: "Decoded",
    QUEUED: "Queued",
    ARCHIVING: "Archiving…",
    VERIFYING: "Verifying…",
    COMPLETED: "Safe in B2",
    UPLOAD_FAILED: "Upload failed",
    DECODE_FAILED: "Decode failed",
    ARCHIVE_FAILED: "Archive failed",
    VERIFY_FAILED: "Verify failed",
  };
  return map[stage] || stage;
}

export function formatSize(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}
