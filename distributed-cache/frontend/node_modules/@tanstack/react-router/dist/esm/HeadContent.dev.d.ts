/**
 * Render route-managed head tags (title, meta, links, styles, head scripts).
 * Place inside the document head of your app shell.
 *
 * Development version: filters out dev styles link after hydration and
 * includes a fallback cleanup effect for hydration mismatch cases.
 *
 * @link https://tanstack.com/router/latest/docs/framework/react/guide/document-head-management
 */
export declare function HeadContent(): import("react/jsx-runtime").JSX.Element;
