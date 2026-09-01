if (process.env.VERCEL_ENV === "production") {
  await import("./smoke-providers.mjs");
}
