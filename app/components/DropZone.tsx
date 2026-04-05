import { useState, useCallback, useRef } from "react";

interface DropZoneProps {
  onFiles: (files: File[]) => void;
}

export function DropZone({ onFiles }: DropZoneProps) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) onFiles(files);
    },
    [onFiles]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      if (files.length) onFiles(files);
      if (e.target) e.target.value = "";
    },
    [onFiles]
  );

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      style={{
        border: `2px dashed ${over ? "var(--ring-active)" : "var(--border-idle)"}`,
        borderRadius: 16,
        padding: "32px 24px",
        textAlign: "center",
        cursor: "pointer",
        transition: "border-color 200ms, background 200ms",
        background: over ? "rgba(99,102,241,0.04)" : "transparent",
      }}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={handleChange}
      />
      <svg
        width="32"
        height="32"
        viewBox="0 0 24 24"
        fill="none"
        style={{ margin: "0 auto 8px" }}
      >
        <path
          d="M12 16V4m0 0L8 8m4-4l4 4"
          stroke="var(--text-tertiary)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M20 16v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2"
          stroke="var(--text-tertiary)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <p style={{ fontSize: 14, color: "var(--text-secondary)", fontWeight: 500 }}>
        Drop audiobooks here or click to browse
      </p>
      <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 4 }}>
        .aax, .mp3, .m4b, and more
      </p>
    </div>
  );
}
