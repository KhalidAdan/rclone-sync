import { useEffect, useRef, useState } from "react";
import { XMarkIcon, BackwardIcon, ForwardIcon } from "@heroicons/react/16/solid";
import {
  parseChapters,
  bookTitle,
  type StreamedJob,
  type Chapter,
} from "../lib/useJobStream";

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

export interface PlayerBook
  extends Pick<
    StreamedJob,
    "id" | "filename" | "title" | "author" | "chapters" | "coverAt"
  > {}

function currentChapterIndex(chapters: Chapter[], t: number): number {
  let idx = -1;
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i].startSec <= t) idx = i;
    else break;
  }
  return idx;
}

/**
 * Sticky bottom playback bar. Streams the M4B over ranged reads; remembers
 * position (localStorage, every 5s) and playback speed across books.
 */
export function Player({ book, onClose }: { book: PlayerBook; onClose: () => void }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const lastSavedRef = useRef(0);
  const [chapterIdx, setChapterIdx] = useState(-1);
  const [speed, setSpeed] = useState(() =>
    typeof localStorage === "undefined"
      ? 1
      : Number(localStorage.getItem("playspeed")) || 1,
  );

  const chapters = parseChapters(book);
  const positionKey = `playpos:${book.id}`;

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed, book.id]);

  const skip = (delta: number) => {
    const el = audioRef.current;
    if (el) el.currentTime = Math.max(0, el.currentTime + delta);
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-950/5 bg-white/95 shadow-[0_-4px_16px_rgba(0,0,0,0.06)] backdrop-blur">
      <div className="container mx-auto flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-3 sm:flex-none sm:basis-64">
          {book.coverAt ? (
            <img
              src={`/api/cover/${book.id}`}
              alt=""
              className="size-11 shrink-0 rounded-md object-cover outline-1 -outline-offset-1 outline-black/10"
            />
          ) : (
            <div className="size-11 shrink-0 rounded-md bg-linear-to-br from-teal-700 to-gray-900" />
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-gray-900" title={bookTitle(book)}>
              {bookTitle(book)}
            </p>
            {book.author && (
              <p className="truncate text-sm text-gray-500">{book.author}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => skip(-30)}
            aria-label="Back 30 seconds"
            className="relative rounded-full p-2 text-gray-500 hover:bg-gray-950/5 hover:text-gray-900"
          >
            <BackwardIcon className="size-4 shrink-0" />
            <span
              className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            onClick={() => skip(30)}
            aria-label="Forward 30 seconds"
            className="relative rounded-full p-2 text-gray-500 hover:bg-gray-950/5 hover:text-gray-900"
          >
            <ForwardIcon className="size-4 shrink-0" />
            <span
              className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
              aria-hidden="true"
            />
          </button>
        </div>

        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- audiobook stream; no caption track exists */}
        <audio
          ref={audioRef}
          controls
          autoPlay
          preload="metadata"
          src={`/api/stream/${book.id}`}
          className="h-10 min-w-0 flex-1 basis-full sm:basis-auto"
          onLoadedMetadata={() => {
            const el = audioRef.current;
            if (!el) return;
            el.playbackRate = speed;
            const saved = Number(localStorage.getItem(positionKey) || 0);
            if (saved > 5) el.currentTime = saved;
          }}
          onTimeUpdate={() => {
            const el = audioRef.current;
            if (!el) return;
            const t = el.currentTime;
            if (Math.abs(t - lastSavedRef.current) >= 5) {
              lastSavedRef.current = t;
              localStorage.setItem(positionKey, String(Math.floor(t)));
            }
            setChapterIdx(currentChapterIndex(chapters, t));
          }}
        />

        <div className="flex items-center gap-2">
          {chapters.length > 0 && (
            <span className="inline-grid grid-cols-[1fr_--spacing(8)]">
              <select
                aria-label="Chapter"
                name="chapter"
                value={chapterIdx}
                onChange={(e) => {
                  const idx = Number(e.target.value);
                  const el = audioRef.current;
                  if (el && chapters[idx]) el.currentTime = chapters[idx].startSec;
                }}
                className="col-span-full row-start-1 max-w-40 appearance-none truncate rounded-md py-1.5 pr-8 pl-2.5 text-sm text-gray-700 ring-1 ring-black/10 focus-visible:outline-2 focus-visible:outline-teal-600"
              >
                <option value={-1} disabled>
                  Chapters
                </option>
                {chapters.map((c, i) => (
                  <option key={i} value={i}>
                    {c.title}
                  </option>
                ))}
              </select>
              <svg
                viewBox="0 0 8 5"
                width="8"
                height="5"
                fill="none"
                className="pointer-events-none col-start-2 row-start-1 place-self-center"
              >
                <path d="M.5.5 4 4 7.5.5" stroke="currentcolor" />
              </svg>
            </span>
          )}

          <span className="inline-grid grid-cols-[1fr_--spacing(8)]">
            <select
              aria-label="Playback speed"
              name="speed"
              value={speed}
              onChange={(e) => {
                const s = Number(e.target.value);
                setSpeed(s);
                localStorage.setItem("playspeed", String(s));
              }}
              className="col-span-full row-start-1 appearance-none rounded-md py-1.5 pr-8 pl-2.5 text-sm text-gray-700 tabular-nums ring-1 ring-black/10 focus-visible:outline-2 focus-visible:outline-teal-600"
            >
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}x
                </option>
              ))}
            </select>
            <svg
              viewBox="0 0 8 5"
              width="8"
              height="5"
              fill="none"
              className="pointer-events-none col-start-2 row-start-1 place-self-center"
            >
              <path d="M.5.5 4 4 7.5.5" stroke="currentcolor" />
            </svg>
          </span>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close player"
            className="relative rounded-full p-2 text-gray-400 hover:bg-gray-950/5 hover:text-gray-600"
          >
            <XMarkIcon className="size-4 shrink-0" />
            <span
              className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
              aria-hidden="true"
            />
          </button>
        </div>
      </div>
    </div>
  );
}
