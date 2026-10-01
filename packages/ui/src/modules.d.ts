/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/** Vite's `?worker` suffix imports a script as a constructor for a dedicated Web Worker. */
declare module '*?worker' {
    const WorkerFactory: new () => Worker;
    export default WorkerFactory;
}
