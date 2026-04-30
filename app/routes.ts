import { type RouteConfig, index, route, layout } from "@react-router/dev/routes";

export default [
  route("api/upload", "routes/api.upload.ts"),
  route("api/download-all", "routes/api.download-all.ts"),
  route("api/download-selected", "routes/api.download-selected.ts"),
  layout("routes/_layout.tsx", [
    index("routes/_layout._index.tsx"),
    route("archive", "routes/_layout.archive.tsx"),
    route("jobs", "routes/_layout.jobs.tsx"),
  ]),
] satisfies RouteConfig;
