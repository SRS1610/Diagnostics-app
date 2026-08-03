// Minimal ambient declaration for the env vars this app reads.
//
// Metro/Babel inline `process.env.X` at build time, so these work in
// React Native — but TypeScript needs to be told. Declared narrowly
// rather than installing @types/node, which would make the whole Node
// standard library appear available in a runtime that doesn't have it,
// and invite imports that fail only once the app is on a device.

declare const process: {
  env: {
    /** Hosted damage-detection model for cosmetic grading. Not set yet —
     *  training it is Sprint 7 work. See lib/cosmeticCapture.ts. */
    COSMETIC_INFERENCE_ENDPOINT?: string;
    [key: string]: string | undefined;
  };
};
