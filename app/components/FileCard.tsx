import { ProgressRing, StageIcon, stageLabel, formatSize } from "./ProgressRing";

export interface CardJob {
  localId: string;
  filename: string;
  sizeBytes: number;
  stage: string;
  uploadPercent: number;
  error?: string | null;
}

interface FileCardProps {
  job: CardJob;
}

export function FileCard({ job }: FileCardProps) {
  const { filename, sizeBytes, stage, uploadPercent, error } = job;
  const isFailed = ["UPLOAD_FAILED", "ARCHIVE_FAILED", "VERIFY_FAILED"].includes(stage);
  const isDone = stage === "COMPLETED";

  const borderVar = isFailed
    ? "var(--ring-fail)"
    : isDone
    ? "var(--ring-done)"
    : "var(--border-idle)";

  return (
    <div
      style={{
        background: "var(--card-bg)",
        borderRadius: 16,
        border: `1.5px solid ${borderVar}`,
        padding: "20px 16px 16px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        position: "relative",
        transition: "border-color 300ms ease, box-shadow 300ms ease",
        boxShadow: isDone
          ? "0 0 0 1px rgba(74,222,128,0.1)"
          : isFailed
          ? "0 0 0 1px rgba(248,113,113,0.1)"
          : "0 1px 3px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.03)",
        minHeight: 180,
      }}
    >
      <div style={{ position: "relative", width: 88, height: 88, flexShrink: 0 }}>
        <ProgressRing stage={stage} uploadPercent={uploadPercent} />
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {stage === "UPLOADING" ? (
            <span
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 13,
                fontWeight: 600,
                color: "var(--text-secondary)",
                letterSpacing: "-0.02em",
              }}
            >
              {uploadPercent}%
            </span>
          ) : (
            <StageIcon stage={stage} />
          )}
        </div>
      </div>

      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: isFailed ? "var(--ring-fail)" : isDone ? "var(--ring-done)" : "var(--text-tertiary)",
        }}
      >
        {stageLabel(stage)}
      </span>

      <p
        title={filename}
        style={{
          fontSize: 12,
          color: "var(--text-secondary)",
          textAlign: "center",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          width: "100%",
          marginTop: "auto",
        }}
      >
        {filename}
      </p>

      <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{formatSize(sizeBytes)}</span>

      {error && (
        <p style={{ fontSize: 10, color: "var(--ring-fail)", textAlign: "center", lineHeight: 1.3 }}>
          {error}
        </p>
      )}
    </div>
  );
}
