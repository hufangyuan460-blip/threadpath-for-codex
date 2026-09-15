import { marked, type Token } from "marked";

export function parseMarkdown(source: string): readonly Token[] {
  return marked.lexer(source, { gfm: true, breaks: true });
}
