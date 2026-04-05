import { Outlet, Link, useLocation } from "react-router";

export default function Layout() {
  const location = useLocation();
  const isActive = (path: string) =>
    path === "/" ? location.pathname === "/" : location.pathname.startsWith(path);

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white shadow-sm border-b">
        <div className="container mx-auto px-4">
          <div className="flex items-center gap-6 h-14">
            <Link to="/" className="text-xl font-semibold text-gray-900">
              Audiobook Archive
            </Link>
            <div className="flex gap-4">
              <Link
                to="/"
                className={`px-3 py-2 rounded-md text-sm font-medium ${
                  isActive("/") && location.pathname === "/"
                    ? "bg-gray-100 text-gray-900"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                Upload
              </Link>
              <Link
                to="/archive"
                className={`px-3 py-2 rounded-md text-sm font-medium ${
                  isActive("/archive")
                    ? "bg-gray-100 text-gray-900"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                Archive
              </Link>
              <Link
                to="/jobs"
                className={`px-3 py-2 rounded-md text-sm font-medium ${
                  isActive("/jobs")
                    ? "bg-gray-100 text-gray-900"
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
