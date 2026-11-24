export const config = {
  runtime: "nodejs",
};

// Import the source module so Vercel's function bundler always deploys the
// current API implementation. Relying on a checked-in generated bundle can
// leave production running an older server after source-only fixes.
export { default } from "./_server.ts";
