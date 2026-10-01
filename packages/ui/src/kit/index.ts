/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * The application's component kit: small, Tailwind-styled building blocks that give every
 * screen the same controls without an external component library.
 */
import { InputWrapper } from './fields';

export { cx } from './cx';
export {
    Alert,
    Anchor,
    Badge,
    Center,
    Code,
    Divider,
    Group,
    Kbd,
    Loader,
    Progress,
    SimpleGrid,
    Skeleton,
    Stack,
    Table,
    Text,
    ThemeIcon,
    Title,
    VisuallyHidden,
} from './layout';
export {
    ActionIcon,
    Button,
    CloseButton,
    CopyButton,
    FileButton,
    UnstyledButton,
    type ButtonProps,
    type ButtonSize,
} from './buttons';
export {
    Checkbox,
    InputWrapper,
    NumberInput,
    PasswordInput,
    Radio,
    SegmentedControl,
    Switch,
    TextInput,
    Textarea,
} from './fields';
export { Autocomplete, Select, TagsInput } from './Select';
export { Notifications } from './Notifications';
export { Menu, Modal, Popover, Tooltip, type ModalRootProps } from './overlays';
export { StatusDot } from './StatusDot';
export { Tabs } from './Tabs';
export { notifications } from './notificationStore';
export {
    initColorScheme,
    setColorScheme,
    toggleColorScheme,
    useColorSchemePreference,
    useComputedColorScheme,
    type ColorSchemePreference,
} from './colorScheme';
export { PICKER_TRIGGER, STATUS_ROW, TRUNCATE_NAME } from './styles';
export { FORM_DENSITY, type Tone } from './tones';

/** Namespace so callers write `Input.Wrapper`, the way the labelled-field pieces read. */
export const Input = { Wrapper: InputWrapper };
