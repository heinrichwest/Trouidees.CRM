import { handleRequest } from "../server.mjs";

export default async function handler(request, response) {
  const incoming = new URL(request.url, `https://${request.headers.host || "localhost"}`);
  const path = String(incoming.searchParams.get("path") || "").replace(/^\/+/, "");
  incoming.searchParams.delete("path");
  request.url = `/api/${path}${incoming.searchParams.size ? `?${incoming.searchParams}` : ""}`;
  return handleRequest(request, response, { serveFiles: false });
}
