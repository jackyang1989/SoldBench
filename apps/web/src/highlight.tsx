import type { ReactNode } from "react";

export type CodeLang = "json" | "bash" | "python" | "ts" | "text";

const KEYWORDS = new Set([
  "import",
  "from",
  "const",
  "let",
  "var",
  "await",
  "async",
  "if",
  "else",
  "return",
  "new",
  "throw",
  "print",
  "true",
  "false",
  "null",
  "None",
  "True",
  "False",
  "curl",
  "function",
]);

function tokenizeLine(line: string, lang: CodeLang, lineKey: string): ReactNode[] {
  if (lang === "text") return [line];

  const commentIdx =
    lang === "bash" || lang === "python"
      ? line.indexOf("#")
      : lang === "ts" || lang === "json"
        ? line.indexOf("//")
        : -1;

  let head = line;
  let tailComment = "";
  if (commentIdx >= 0) {
    // Only split as comment when preceded by start-of-line or whitespace (avoids URLs like https:// or #anchor).
    const before = commentIdx === 0 ? "" : line[commentIdx - 1];
    if (commentIdx === 0 || /\s/.test(before ?? "")) {
      head = line.slice(0, commentIdx);
      tailComment = line.slice(commentIdx);
    }
  }

  const nodes: ReactNode[] = [];
  const tokenRe = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b[A-Za-z_][A-Za-z0-9_]*\b|\b\d+(?:\.\d+)?\b)/g;
  let last = 0;
  let idx = 0;

  for (const match of head.matchAll(tokenRe)) {
    const start = match.index ?? 0;
    const raw = match[0];
    if (start > last) {
      nodes.push(head.slice(last, start));
    }
    if (raw.startsWith('"') || raw.startsWith("'")) {
      nodes.push(
        <span className="tok-s" key={`${lineKey}:s:${idx++}`}>
          {raw}
        </span>,
      );
    } else if (/^\d/.test(raw)) {
      nodes.push(
        <span className="tok-n" key={`${lineKey}:n:${idx++}`}>
          {raw}
        </span>,
      );
    } else if (KEYWORDS.has(raw)) {
      nodes.push(
        <span className="tok-k" key={`${lineKey}:k:${idx++}`}>
          {raw}
        </span>,
      );
    } else {
      nodes.push(raw);
    }
    last = start + raw.length;
  }

  if (last < head.length) {
    nodes.push(head.slice(last));
  }
  if (tailComment) {
    nodes.push(
      <span className="tok-c" key={`${lineKey}:c`}>
        {tailComment}
      </span>,
    );
  }
  return nodes;
}

export function highlightCode(code: string, lang: CodeLang = "json"): ReactNode {
  const lines = code.split("\n");
  let offset = 0;
  return lines.map((line, idx) => {
    const start = offset;
    offset += line.length + 1;
    const key = `L${start}:${line.length}`;
    return (
      <span key={key}>
        {tokenizeLine(line, lang, key)}
        {idx < lines.length - 1 ? "\n" : null}
      </span>
    );
  });
}
