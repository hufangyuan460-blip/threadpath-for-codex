import { memo, useState } from "react";
import type { ReactNode } from "react";
import type { Token, Tokens } from "marked";
import { parseMarkdown } from "./markdown.ts";
import type { Messages } from "./i18n.ts";

function inline(tokens: readonly Token[], keyPrefix: string, m: Messages): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (token.type) {
      case "strong": return <strong key={key}>{inline((token as Tokens.Strong).tokens, key, m)}</strong>;
      case "em": return <em key={key}>{inline((token as Tokens.Em).tokens, key, m)}</em>;
      case "del": return <del key={key}>{inline((token as Tokens.Del).tokens, key, m)}</del>;
      case "codespan": return <code className="markdown-inline-code" key={key}>{token.text}</code>;
      case "br": return <br key={key} />;
      case "link": return <span className="markdown-link" title={m.linkUnavailable} key={key}>{inline((token as Tokens.Link).tokens, key, m)}</span>;
      case "image": return <span className="markdown-image" key={key}>[{token.text || "image"}]</span>;
      case "html": return <span className="markdown-raw" key={key}>{token.raw}</span>;
      case "text": return (token as Tokens.Text).tokens === undefined ? (token as Tokens.Text).text : <span key={key}>{inline((token as Tokens.Text).tokens ?? [], key, m)}</span>;
      case "escape": return token.text;
      default: return token.raw;
    }
  });
}

function blocks(tokens: readonly Token[], m: Messages): ReactNode[] {
  return tokens.flatMap((token, index) => {
    const key = `block-${index}`;
    switch (token.type) {
      case "paragraph": return <p key={key}>{inline((token as Tokens.Paragraph).tokens, key, m)}</p>;
      case "heading": return token.depth <= 3 ? [
        token.depth === 1 ? <h1 key={key}>{inline((token as Tokens.Heading).tokens, key, m)}</h1> : null,
        token.depth === 2 ? <h2 key={key}>{inline((token as Tokens.Heading).tokens, key, m)}</h2> : null,
        token.depth === 3 ? <h3 key={key}>{inline((token as Tokens.Heading).tokens, key, m)}</h3> : null,
      ] : <p key={key}>{inline((token as Tokens.Heading).tokens, key, m)}</p>;
      case "list": {
        const listToken = token as Tokens.List;
        const ListTag = listToken.ordered ? "ol" : "ul";
        return <ListTag key={key} start={listToken.ordered && listToken.start !== "" ? listToken.start : undefined}>{listToken.items.map((item, itemIndex) => <li key={`${key}-item-${itemIndex}`}>{item.task ? <input type="checkbox" checked={item.checked === true} disabled aria-label={item.checked === true ? "completed" : "not completed"} /> : null}{blocks(item.tokens, m)}</li>)}</ListTag>;
      }
      case "blockquote": return <blockquote key={key}>{blocks((token as Tokens.Blockquote).tokens, m)}</blockquote>;
      case "code": return <CodeBlock key={key} token={token as Tokens.Code} m={m} />;
      case "table": { const tableToken = token as Tokens.Table; return <div className="markdown-table-scroll" key={key}><table><thead><tr>{tableToken.header.map((cell, cellIndex) => <th key={`${key}-header-${cellIndex}`} style={{ textAlign: cell.align ?? undefined }}>{inline(cell.tokens, `${key}-header-${cellIndex}`, m)}</th>)}</tr></thead><tbody>{tableToken.rows.map((row, rowIndex) => <tr key={`${key}-row-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${key}-cell-${rowIndex}-${cellIndex}`} style={{ textAlign: cell.align ?? undefined }}>{inline(cell.tokens, `${key}-cell-${rowIndex}-${cellIndex}`, m)}</td>)}</tr>)}</tbody></table></div>; }
      case "hr": return <hr key={key} />;
      case "html": return <p className="markdown-raw" key={key}>{token.raw}</p>;
      case "space": return null;
      default: return <p key={key}>{token.raw}</p>;
    }
  });
}

function CodeBlock({ token, m }: { token: Tokens.Code; m: Messages }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(token.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };
  const language = token.lang?.replace(/[^a-zA-Z0-9_+#.-]/g, "").slice(0, 24) || "code";
  return <div className="markdown-code-block"><div className="markdown-code-toolbar"><span>{language}</span><button type="button" onClick={() => void copy()} aria-label={copied ? m.copied : m.copy}>{copied ? m.copied : m.copy}</button></div><pre><code>{token.text}</code></pre></div>;
}

export const MarkdownMessage = memo(function MarkdownMessage({ text, m }: { text: string; m: Messages }): React.JSX.Element {
  return <div className="markdown-message">{blocks(parseMarkdown(text), m)}</div>;
});
