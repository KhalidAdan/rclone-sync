const STAGES = ["UPLOADING", "STAGED", "ARCHIVING", "VERIFYING", "COMPLETED"];
const FAIL_STAGES = ["UPLOAD_FAILED", "ARCHIVE_FAILED", "VERIFY_FAILED"];
const STAGE_INDEX: Record<string, number> = { UPLOADING: 0, STAGED: 1, ARCHIVING: 2, VERIFYING: 3, COMPLETED: 4 };

interface ProgressRingProps {
  stage: string;
  uploadPercent?: number;
  size?: number;
  stroke?: number;
}

export function ProgressRing({ stage, uploadPercent = 0, size = 88, stroke = 5 }: ProgressRingProps) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const isFailed = FAIL_STAGES.includes(stage);
  const isDone = stage === "COMPLETED";

  let progress = 0;
  if (isDone) {
    progress = 1;
  } else if (isFailed) {
    const base = stage === "UPLOAD_FAILED" ? 0 : stage === "ARCHIVE_FAILED" ? 0.5 : 0.75;
    progress = base;
  } else {
    const idx = STAGE_INDEX[stage] ?? 0;
    const stageBase = idx * 0.25;
    if (stage === "UPLOADING") {
      progress = stageBase + (uploadPercent / 100) * 0.25;
    } else {
      progress = stageBase;
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
    UPLOADING: "Uploading…",
    STAGED: "Staged",
    ARCHIVING: "Archiving…",
    VERIFYING: "Verifying…",
    COMPLETED: "Done",
    UPLOAD_FAILED: "Upload failed",
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
