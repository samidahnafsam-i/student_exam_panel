import { getStore } from "@netlify/blobs";
import { createHandler } from "../lib/handler.mjs";

export const config = { path: "/api/*" };

// All logic lives in netlify/lib/ (handler.mjs, grading.mjs) so it can be unit-tested
// without Netlify. This file is just the Netlify entry point.
export default createHandler({ getStore });
