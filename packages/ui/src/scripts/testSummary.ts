/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { ScriptReport } from '@httpreq/shared';

/** The tab label's summary: passed of total, or nothing when no test ran. */
export const testSummary = (report: ScriptReport | undefined): string => {
    if (!report || report.tests.length === 0) return '';
    const passed = report.tests.filter((test) => test.passed).length;
    return `${passed}/${report.tests.length}`;
};

/** Whether the scripts of a send have anything to show. */
export const hasScriptOutput = (report: ScriptReport | undefined): report is ScriptReport =>
    !!report &&
    (report.tests.length > 0 ||
        report.logs.length > 0 ||
        report.stages.some((stage) => !stage.ok) ||
        Object.keys(report.environmentChanges.set).length > 0 ||
        report.environmentChanges.unset.length > 0);
