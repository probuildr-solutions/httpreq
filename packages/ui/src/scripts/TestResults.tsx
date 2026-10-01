/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconCircleCheck, IconCircleX } from '@tabler/icons-react';
import { SCRIPT_STAGE_LABELS, type ScriptReport } from '@httpreq/shared';
import { Badge, Text, cx } from '../kit';

/** Test results, script errors, console output and environment changes of the last send. */
export function TestResults({ report }: { report: ScriptReport }) {
    const failedStages = report.stages.filter((stage) => !stage.ok);
    const set = Object.keys(report.environmentChanges.set);
    return (
        <div className="min-h-0 flex-1 overflow-auto p-2.5" aria-label="Script results">
            {failedStages.map((stage) => (
                <div
                    key={stage.stage}
                    role="alert"
                    className="mb-2 rounded-sm border border-red-6/40 bg-danger-soft p-2 text-xs"
                >
                    <strong>{SCRIPT_STAGE_LABELS[stage.stage]} script failed:</strong>{' '}
                    {stage.error?.message}
                </div>
            ))}

            {report.tests.length > 0 && (
                <ul className="m-0 list-none p-0" aria-label="Tests">
                    {report.tests.map((test, index) => (
                        <li
                            key={`${test.name}-${index}`}
                            className="flex items-start gap-2 border-b border-line py-1.5 text-sm last:border-b-0"
                        >
                            {test.passed ? (
                                <IconCircleCheck
                                    size={16}
                                    className="mt-px text-teal-6"
                                    aria-label="Passed"
                                />
                            ) : (
                                <IconCircleX
                                    size={16}
                                    className="mt-px text-red-6"
                                    aria-label="Failed"
                                />
                            )}
                            <div className="min-w-0">
                                <div className={cx(!test.passed && 'font-medium')}>{test.name}</div>
                                {test.error && (
                                    <div className="font-mono text-xs break-words text-red-6">
                                        {test.error}
                                    </div>
                                )}
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            {(set.length > 0 || report.environmentChanges.unset.length > 0) && (
                <div className="mt-3">
                    <Text size="xs" className="font-semibold text-dimmed">
                        Environment changes
                    </Text>
                    <div className="mt-1 flex flex-wrap gap-1">
                        {set.map((key) => (
                            <Badge key={key} size="xs" variant="light" color="teal">
                                set {key}
                            </Badge>
                        ))}
                        {report.environmentChanges.unset.map((key) => (
                            <Badge key={key} size="xs" variant="light" color="red">
                                removed {key}
                            </Badge>
                        ))}
                    </div>
                </div>
            )}

            {report.logs.length > 0 && (
                <div className="mt-3">
                    <Text size="xs" className="font-semibold text-dimmed">
                        Console
                    </Text>
                    <pre className="m-0 mt-1 font-mono text-xs whitespace-pre-wrap">
                        {report.logs.map((entry, index) => (
                            <div
                                key={index}
                                className={cx(
                                    entry.level === 'error' && 'text-red-6',
                                    entry.level === 'warn' && 'text-yellow-7',
                                )}
                            >
                                [{SCRIPT_STAGE_LABELS[entry.stage]}] {entry.message}
                            </div>
                        ))}
                    </pre>
                </div>
            )}
        </div>
    );
}
