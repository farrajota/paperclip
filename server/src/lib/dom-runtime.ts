import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let jsdomConstructor: typeof import("jsdom").JSDOM | undefined;
let domPurifyFactory: typeof import("dompurify").default | undefined;

// Keep the DOM dependency graph off startup; callers still own each window and purifier.
export function getJSDOM(): typeof import("jsdom").JSDOM {
  return jsdomConstructor ??= (require("jsdom") as typeof import("jsdom")).JSDOM;
}

export function getDOMPurify(): typeof import("dompurify").default {
  return domPurifyFactory ??= require("dompurify") as typeof import("dompurify").default;
}
