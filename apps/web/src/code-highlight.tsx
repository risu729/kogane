import { use, useMemo, type ReactNode } from "react";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import githubLight from "shiki/themes/github-light.mjs";
import json from "shiki/langs/json.mjs";
import xml from "shiki/langs/xml.mjs";

// This entire module is loaded on demand. XML also colors HTML markup without
// loading embedded JavaScript/CSS grammars or executing any original markup.
const highlighterReady = createHighlighterCore({
  themes: [githubLight],
  langs: [json, xml],
  engine: createJavaScriptRegexEngine(),
});

const TOKEN_CLASSES: Readonly<Record<string, string>> = {
  "#6a737d": "code-comment",
  "#005cc5": "code-constant",
  "#6f42c1": "code-entity",
  "#24292e": "code-text",
  "#22863a": "code-tag",
  "#d73a49": "code-keyword",
  "#032f62": "code-string",
  "#e36209": "code-variable",
  "#b31d28": "code-invalid",
  "#fafbfc": "code-invalid",
  "#f6f8fa": "code-invalid",
  "#586069": "code-comment",
};

export default function CodeHighlight({
  text,
  language,
}: {
  text: string;
  language: "json" | "xml";
}): ReactNode {
  const highlighter = use(highlighterReady);
  return useMemo(() => {
    try {
      const { tokens } = highlighter.codeToTokens(text, { lang: language, theme: "github-light" });
      const output: ReactNode[] = [];
      let cursor = 0;
      for (const line of tokens) {
        for (const token of line) {
          // Restore gaps from the original string to preserve CRLF, whitespace
          // and trailing newlines exactly, including large JSON numbers.
          if (
            token.offset < cursor ||
            text.slice(token.offset, token.offset + token.content.length) !== token.content
          )
            return text;
          if (token.offset > cursor) output.push(text.slice(cursor, token.offset));
          output.push(
            <span
              key={output.length}
              className={TOKEN_CLASSES[token.color?.toLowerCase() ?? ""] ?? "code-text"}
            >
              {token.content}
            </span>,
          );
          cursor = token.offset + token.content.length;
        }
      }
      if (cursor < text.length) output.push(text.slice(cursor));
      return output;
    } catch {
      return text;
    }
  }, [highlighter, text, language]);
}
