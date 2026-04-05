import { useLoaderData } from "react-router";
import type { Route } from "./+types/_layout.archive";
import { listFiles } from "../lib/rclone.server";
import { config } from "../lib/config.server";

interface FileEntry {
  Name: string;
  Size: string;
  ModTime: string;
  IsDir: boolean;
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const dir = url.searchParams.get("dir") || "";

  try {
    // Build the fs path: remote/subdir (NO trailing colon!)
    // B2 app keys fail with trailing colon due to bucket restriction
    const fsPath = dir 
      ? `${config.rcloneRemote}${dir}`
      : config.rcloneRemote;
    
    console.log("[archive.loader] Calling listFiles with:", { fs: fsPath, remote: "" });
    
    const { list } = await listFiles(fsPath, "");
    console.log("[archive.loader] List result:", list);
    
    return { entries: list || [], remote: dir };
  } catch (err) {
    console.error("[archive.loader] Error:", err);
    return { entries: [], remote: dir, error: String(err) };
  }
}

export default function Archive({ loaderData }: Route.ComponentProps) {
  const { entries, remote, error } = loaderData;

  const formatSize = (size: string) => {
    const bytes = parseInt(size, 10);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString();
    } catch {
      return dateStr;
    }
  };

  const navigateUp = () => {
    const parts = remote.split("/").filter(Boolean);
    parts.pop();
    const newDir = parts.join("/");
    window.location.href = `/archive${newDir ? `?dir=${newDir}` : ""}`;
  };

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Archive Browser</h1>
        {remote && (
          <button
            onClick={navigateUp}
            className="text-blue-600 hover:text-blue-800 text-sm"
          >
            ← Go up
          </button>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
          Failed to load archive: {error}
        </div>
      )}

      {entries.length === 0 && !error ? (
        <p className="text-gray-500">No files in this directory.</p>
      ) : (
        <div className="bg-white shadow-sm rounded-lg border overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Name
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Size
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Modified
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {entries.map((entry: FileEntry) => {
                const fullPath = remote ? `${remote}/${entry.Name}` : entry.Name;
                const href = entry.IsDir 
                  ? `/archive?dir=${fullPath}` 
                  : "#";
                
                return (
                  <tr key={entry.Name} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      {entry.IsDir ? (
                        <a
                          href={href}
                          className="text-blue-600 hover:text-blue-800 font-medium"
                        >
                          📁 {entry.Name}
                        </a>
                      ) : (
                        <span className="text-gray-900">
                          📄 {entry.Name}
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-500">
                      {entry.IsDir ? "-" : formatSize(entry.Size)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-500">
                      {formatDate(entry.ModTime)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
