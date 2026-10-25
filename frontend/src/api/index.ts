// Picks the backend: VITE_API_URL set at build time -> the real API; not set -> demo mode in the browser.

import { DemoApi } from "./demoApi";
import { HttpApi } from "./httpApi";
import type { StoreApi } from "./types";

export function createApi(): StoreApi {
  const url = import.meta.env.VITE_API_URL as string | undefined;
  return url ? new HttpApi(url.replace(/\/$/, "")) : new DemoApi();
}
