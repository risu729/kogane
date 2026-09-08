import { Component, Suspense, lazy, useId, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchPreview, previewLanguage, PREVIEW_LIMIT } from "./preview-fetch.ts";
import { QueryBoundary } from "./ui.tsx";

const CodeHighlight = lazy(() => import("./code-highlight.tsx"));
const HIGHLIGHT_LIMIT = 100 * 1024;
const HIGHLIGHT_LINE_LIMIT = 10_000;

type PreviewProps = {
  url: string;
  artifactKey: string;
  mediaType: string | null;
  byteSize: number;
  sha256: string;
};

class HighlightBoundary extends Component<
  { text: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? this.props.text : this.props.children;
  }
}

export function EvidencePreview(props: PreviewProps): ReactNode {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const language = previewLanguage(props.mediaType, props.artifactKey);
  if (language === null) {
    return (
      <p className="muted">
        この形式はプレビューに対応していません。ファイルをダウンロードして確認してください。
      </p>
    );
  }
  if (
    !Number.isSafeInteger(props.byteSize) ||
    props.byteSize < 0 ||
    props.byteSize > PREVIEW_LIMIT
  ) {
    return (
      <p className="muted">
        プレビューできるのは512 KiBまでです。このファイルはダウンロードして確認してください。
      </p>
    );
  }
  return (
    <section className="evidence-preview" aria-label="原本のプレビュー">
      <button
        className="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "プレビューを閉じる" : "内容を表示"}
      </button>
      <div id={regionId}>{open ? <PreviewContent {...props} language={language} /> : null}</div>
    </section>
  );
}

function PreviewContent({
  url,
  artifactKey,
  byteSize,
  sha256,
  mediaType,
  language,
}: PreviewProps & { language: "json" | "xml" | "text" }): ReactNode {
  const instanceId = useId();
  const [wrap, setWrap] = useState(true);
  // Mount only after an explicit open. Closing removes the observer, aborts an
  // in-flight fetch and garbage-collects private bytes immediately.
  const query = useQuery({
    queryKey: ["evidence-v1", "preview", url, artifactKey, sha256, byteSize, mediaType, instanceId],
    queryFn: ({ signal }) => fetchPreview(url, signal, sha256, byteSize, mediaType),
    gcTime: 0,
    retry: false,
  });
  return (
    <QueryBoundary query={query} label="原本の内容">
      {(text) => {
        const highlight =
          language !== "text" &&
          byteSize <= HIGHLIGHT_LIMIT &&
          text.split("\n", HIGHLIGHT_LINE_LIMIT + 1).length <= HIGHLIGHT_LINE_LIMIT;
        return (
          <>
            <div className="preview-toolbar">
              <p className="muted">
                保存された内容をテキストとして表示しています。HTMLは実行されません。
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={wrap}
                  onChange={(event) => setWrap(event.target.checked)}
                />
                長い行を折り返す
              </label>
            </div>
            {language !== "text" && !highlight ? (
              <p className="muted">大きなデータのため、色分けせずに全文を表示しています。</p>
            ) : null}
            <pre
              className={`preview-code${wrap ? " is-wrapped" : ""}`}
              tabIndex={0}
              aria-label="原本の内容"
            >
              <code>
                {highlight ? (
                  <HighlightBoundary text={text}>
                    <Suspense fallback={text}>
                      <CodeHighlight text={text} language={language} />
                    </Suspense>
                  </HighlightBoundary>
                ) : (
                  text
                )}
              </code>
            </pre>
          </>
        );
      }}
    </QueryBoundary>
  );
}
