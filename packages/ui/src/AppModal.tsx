import { Group, Modal, type ModalRootProps } from '@mantine/core';
import type { ReactNode } from 'react';
import classes from './AppModal.module.css';

export interface AppModalProps extends Omit<ModalRootProps, 'title' | 'children' | 'classNames'> {
  title: ReactNode;
  /** The body: the message, content or form fields. It scrolls when the dialog is taller than the window. */
  children?: ReactNode;
  /**
   * The action buttons (Cancel, Save, Delete…), right-aligned in a footer pinned below the body,
   * so a long form never scrolls its actions out of view.
   */
  footer?: ReactNode;
  /** Secondary actions at the left end of the footer, such as “Test connection”. */
  footerStart?: ReactNode;
  withCloseButton?: boolean;
}

const partClasses = {
  content: classes.content,
  header: classes.header,
  title: classes.title,
  body: classes.body,
};

/**
 * Every dialog in the app: a header with the title and close button, a scrolling body and a footer
 * of actions, divided by rules. Use this instead of a bare `Modal` so popups stay consistent.
 */
export function AppModal({
  title,
  children,
  footer,
  footerStart,
  withCloseButton = true,
  // Centred in the window at any size, rather than hanging from the top edge (Mantine's default).
  centered = true,
  ...props
}: AppModalProps) {
  return (
    // Styled through `classNames` rather than `className` on the parts: Mantine also hands the
    // content's `className` to the positioning wrapper around it, which would break the layout.
    <Modal.Root {...props} centered={centered} classNames={partClasses}>
      <Modal.Overlay />
      <Modal.Content>
        <Modal.Header>
          <Modal.Title>{title}</Modal.Title>
          {withCloseButton && <Modal.CloseButton aria-label="Close" />}
        </Modal.Header>
        <Modal.Body>{children}</Modal.Body>
        {(footer || footerStart) && (
          <footer className={classes.footer}>
            {footerStart && <Group gap="xs">{footerStart}</Group>}
            <Group gap="xs" ml="auto">
              {footer}
            </Group>
          </footer>
        )}
      </Modal.Content>
    </Modal.Root>
  );
}
