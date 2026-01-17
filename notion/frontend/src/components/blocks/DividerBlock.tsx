/**
 * @fileoverview Divider block renderer component.
 * Renders a horizontal rule/divider to separate content sections.
 */

/**
 * DividerBlock renders a horizontal divider line.
 * Used to visually separate content sections within a page.
 * This is a non-editable block type.
 *
 * @returns A styled horizontal rule element
 *
 * @example
 * ```tsx
 * <DividerBlock />
 * ```
 */
export function DividerBlock() {
  return <hr className="notion-divider" />;
}
