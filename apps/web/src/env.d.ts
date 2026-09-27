/** Application version from the root package.json, injected by Vite at build time. */
declare const __APP_VERSION__: string;

/** Version, commit and build time of this bundle (see `build-info.ts`). */
declare const __APP_BUILD__: { version: string; commit: string; builtAt: string };
