/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { useId } from 'react';
import { VariableInput, type VariableInputProps } from '../editor/VariableInput';
import { Input } from '../kit';

interface Props extends Omit<VariableInputProps, 'id'> {
    label: string;
    description?: string;
    error?: string;
}

/** A labelled variable-aware input for `.hr-form` forms: authorization, settings, SSH and tunnels. */
export function Field({ label, description, error, ...input }: Props) {
    const id = useId();
    return (
        <Input.Wrapper
            label={label}
            description={description}
            error={error}
            labelProps={{ htmlFor: id }}
        >
            <VariableInput id={id} invalid={!!error} {...input} />
        </Input.Wrapper>
    );
}
