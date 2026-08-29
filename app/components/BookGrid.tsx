import { PlayIcon, ArrowDownTrayIcon } from "@heroicons/react/16/solid";
import {
  bookTitle,
  formatDuration,
  type StreamedJob,
} from "../lib/useJobStream";

/**
 * The bookshelf. Square cover tiles (Audible art is 1:1) with title and
 * author below — whitespace separation, no card chrome. The cover itself
 * is the play button; download rides along as a quiet secondary action.
 */
export function BookGrid({
  books,
  onPlay,
}: {
  books: StreamedJob[];
  onPlay: (book: StreamedJob) => void;
}) {
  return (
    <ul
      role="list"
      className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
    >
      {books.map((book) => (
        <li key={book.id}>
          <div className="group relative">
            <button
              type="button"
              onClick={() => onPlay(book)}
              aria-label={`Play ${bookTitle(book)}`}
              className="block w-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
            >
              <Cover book={book} />
              <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-gray-950/0 group-hover:bg-gray-950/30">
                <span className="flex size-12 items-center justify-center rounded-full bg-white/90 opacity-0 shadow-md group-hover:opacity-100">
                  <PlayIcon className="size-4 shrink-0 translate-x-px fill-gray-900" />
                </span>
              </span>
              {formatDuration(book.durationSec) && (
                <span className="absolute right-1.5 bottom-1.5 rounded-md bg-gray-950/70 px-1.5 py-0.5 text-xs font-medium text-white tabular-nums">
                  {formatDuration(book.durationSec)}
                </span>
              )}
            </button>
          </div>
          <div className="mt-2 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p
                className="truncate text-sm font-medium text-gray-900"
                title={bookTitle(book)}
              >
                {bookTitle(book)}
              </p>
              {book.author && (
                <p className="truncate text-sm text-gray-500">{book.author}</p>
              )}
            </div>
            <a
              href={`/api/download/${book.id}`}
              aria-label={`Download ${bookTitle(book)}`}
              className="relative mt-0.5 shrink-0 rounded-md p-1 text-gray-400 hover:bg-gray-950/5 hover:text-gray-700"
            >
              <ArrowDownTrayIcon className="size-4 shrink-0" />
              <span
                className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
                aria-hidden="true"
              />
            </a>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Cover({ book }: { book: StreamedJob }) {
  if (book.coverAt) {
    return (
      <img
        src={`/api/cover/${book.id}`}
        alt=""
        loading="lazy"
        className="aspect-square w-full rounded-lg object-cover outline-1 -outline-offset-1 outline-black/10"
      />
    );
  }

  // No embedded art (or not yet probed) — a quiet monogram placeholder.
  const title = bookTitle(book);
  const initials = title
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div className="flex aspect-square w-full items-center justify-center rounded-lg bg-linear-to-br from-teal-800 via-gray-800 to-gray-950 outline-1 -outline-offset-1 outline-black/10">
      <span className="text-2xl font-semibold text-white/80">{initials}</span>
    </div>
  );
}
