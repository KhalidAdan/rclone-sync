import { Outlet, Link, useLocation } from "react-router";

export default function Layout() {
  const location = useLocation();
  const isActive = (path: string) =>
    path === "/" ? location.pathname === "/" : location.pathname.startsWith(path);

  return (
    <div className="min-h-dvh bg-white antialiased">
      <nav className="border-b border-gray-950/5 bg-white">
        <div className="container mx-auto px-4">
          <div className="flex h-14 items-center gap-6">
            <Link to="/" className="text-base font-semibold text-gray-900">
              Audiobook Archive
            </Link>
            <div className="flex gap-1">
              <Link
                to="/"
                className={`rounded-md px-3 py-2 text-sm font-medium ${
                  isActive("/")
                    ? "bg-gray-950/5 text-gray-900"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                Library
              </Link>
              <Link
                to="/jobs"
                className={`rounded-md px-3 py-2 text-sm font-medium ${
                  isActive("/jobs")
                    ? "bg-gray-950/5 text-gray-900"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                Jobs
              </Link>
            </div>
          </div>
        </div>
      </nav>
      <main className="container mx-auto px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
