// How-to page: make your connection URL and add it to Claude.
import { handleHome } from "../dist/remote/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handleHome;
