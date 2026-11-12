/**
 * Policy text is stored as plain text with a little Markdown: `##` headings,
 * `-` list items and blank lines between paragraphs. This turns it into
 * blocks for the page to render as real elements. Nothing here produces
 * HTML, so policy text can never inject markup.
 */

export type PolicyBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] };

export function policyBlocks(body: string): PolicyBlock[] {
  const blocks: PolicyBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flush = () => {
    if (paragraph.length > 0) blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    if (list.length > 0) blocks.push({ type: "list", items: list });
    paragraph = [];
    list = [];
  };

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (line === "") {
      flush();
    } else if (heading) {
      flush();
      blocks.push({ type: "heading", text: heading[1] ?? "" });
    } else if (item) {
      if (paragraph.length > 0) flush();
      list.push(item[1] ?? "");
    } else {
      if (list.length > 0) flush();
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}
