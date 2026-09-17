/**
 * Site-side render components for this plugin's Portable Text blocks.
 *
 * EmDash auto-merges `blockComponents` into <PortableText> at build time (via
 * the descriptor's `componentsEntry`), so a site author never imports anything —
 * dropping the "AI Chat" block in the editor is enough.
 *
 * The export name `blockComponents` is required by EmDash.
 */
import ChatWidget from "./ChatWidget.astro";

export const blockComponents = {
  "chat-widget": ChatWidget,
};

// Also re-exported for direct <ChatWidget /> use in a template.
export { default as ChatWidget } from "./ChatWidget.astro";
