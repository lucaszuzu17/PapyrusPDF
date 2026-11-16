import type { PapiroApi } from "../../preload/index.ts";

declare global {
  interface Window {
    papiro: PapiroApi;
  }
}
export {};
