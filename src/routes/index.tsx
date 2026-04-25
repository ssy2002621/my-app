import { createFileRoute } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { isValidElement, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import mermaid from 'mermaid'
import 'katex/dist/katex.min.css'
import { convertMarkdownToDocx } from '~/lib/pandoc.server'

export const Route = createFileRoute('/')({
  component: Home,
})

const starterMarkdown = `# Markdown 转 Word（Pandoc）

把左侧内容替换成你从 ChatGPT / Claude / DeepSeek 复制的 Markdown。

## 公式示例

块公式（AI 常见输出）：

\\[
\\Delta I_t(q) = I_{1,t}(q) - I_{2,t}(q), \\quad q \\in [0,1]
\\]

行内公式（AI 常见输出）：\\((\\alpha)^\\alpha\\)

常见裸公式（没加分隔符也会尝试识别）：
f(x; \\alpha, \\beta) = \\frac{\\Gamma(\\alpha+\\beta)}{\\Gamma(\\alpha)\\Gamma(\\beta)} x^{\\alpha-1} (1-x)^{\\beta-1}, \\quad x \\in [0,1]

## 表格示例

| 平台 | 导出建议 |
| --- | --- |
| ChatGPT | 复制回答中的 Markdown |
| Claude | 复制完整回答文本 |
| DeepSeek | 复制 Markdown 模式输出 |
`

let mermaidInitialized = false

function ensureMermaidInitialized() {
  if (mermaidInitialized) return

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: 'default',
  })

  mermaidInitialized = true
}

function normalizeAiMathSyntax(markdown: string) {
  const codeFenceRegex = /```[\s\S]*?```/g
  const segments: Array<string> = []
  let lastIndex = 0

  for (const match of markdown.matchAll(codeFenceRegex)) {
    const block = match[0]
    const index = match.index ?? 0

    segments.push(normalizeMathSegment(markdown.slice(lastIndex, index)))
    segments.push(block)

    lastIndex = index + block.length
  }

  segments.push(normalizeMathSegment(markdown.slice(lastIndex)))
  return segments.join('')
}

function maybeWrapBareLatexLine(line: string) {
  const trimmed = line.trim()
  if (!trimmed) return line

  if (
    trimmed.startsWith('#') ||
    trimmed.startsWith('>') ||
    trimmed.startsWith('|') ||
    trimmed.startsWith('```') ||
    trimmed.includes('`') ||
    /^[-*+]\s/.test(trimmed) ||
    /^\d+\.\s/.test(trimmed)
  ) {
    return line
  }

  if (
    trimmed.includes('$') ||
    trimmed.includes('\\(') ||
    trimmed.includes('\\)') ||
    trimmed.includes('\\[') ||
    trimmed.includes('\\]')
  ) {
    return line
  }

  const hasLatexCommand =
    /\\(alpha|beta|gamma|Gamma|delta|Delta|theta|Theta|lambda|Lambda|mu|nu|pi|Pi|sigma|Sigma|omega|Omega|frac|cdot|times|sum|prod|int|infty|sqrt|left|right|leq|geq|neq|approx|quad|qquad|in|notin|subset|supset|cup|cap|log|ln|sin|cos|tan|exp|min|max)/.test(
      trimmed,
    )
  const hasMathStructure = /[=<>^_{}]/.test(trimmed)

  if (!hasLatexCommand || !hasMathStructure) {
    return line
  }

  const leadingWhitespace = line.match(/^\s*/)?.[0] ?? ''
  return `${leadingWhitespace}$${trimmed}$`
}

function normalizeMathSegment(segment: string) {
  const withNormalizedDelimiters = segment
    .replace(/\\\\\(/g, '\\(')
    .replace(/\\\\\)/g, '\\)')
    .replace(/\\\\\[/g, '\\[')
    .replace(/\\\\\]/g, '\\]')

  const withStandardDelimiters = withNormalizedDelimiters
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, expression: string) => {
      const trimmed = expression.trim()
      if (!trimmed) return _match
      return `$$\n${trimmed}\n$$`
    })
    .replace(/\\\(([\s\S]+?)\\\)/g, (_match, expression: string) => {
      const trimmed = expression.trim()
      if (!trimmed) return _match
      return `$${trimmed}$`
    })

  const lines = withStandardDelimiters.split('\n')
  let inDisplayMathBlock = false

  const normalizedLines = lines.map((line) => {
    const trimmed = line.trim()

    if (trimmed === '$$') {
      inDisplayMathBlock = !inDisplayMathBlock
      return line
    }

    if (inDisplayMathBlock) {
      return line
    }

    return maybeWrapBareLatexLine(line)
  })

  return normalizedLines.join('\n')
}

function extractMermaidSources(markdown: string) {
  const regex = /```mermaid[^\n]*\n([\s\S]*?)```/g
  const results: Array<string> = []

  for (const match of markdown.matchAll(regex)) {
    const source = (match[1] ?? '').trim()
    if (source) {
      results.push(source)
    }
  }

  return results
}

function decodeBase64ToBlob(base64: string, mimeType: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return new Blob([bytes], { type: mimeType })
}

type MermaidBlockProps = {
  code: string
  onSvgRendered: (source: string, svg: string) => void
}

type ManualDownloadLink = {
  url: string
  fileName: string
}

function MermaidBlock({ code, onSvgRendered }: MermaidBlockProps) {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let canceled = false

    const run = async () => {
      try {
        ensureMermaidInitialized()
        const id = `mermaid-${Math.random().toString(36).slice(2, 12)}`
        const { svg: renderedSvg } = await mermaid.render(id, code)

        if (canceled) return

        setSvg(renderedSvg)
        setError(null)
        onSvgRendered(code, renderedSvg)
      } catch (renderError) {
        if (canceled) return
        const message =
          renderError instanceof Error ? renderError.message : String(renderError)
        setError(message)
      }
    }

    setSvg(null)
    setError(null)
    void run()

    return () => {
      canceled = true
    }
  }, [code, onSvgRendered])

  if (error) {
    return (
      <div className="my-4 rounded-md border border-rose-200 bg-rose-50 p-3">
        <p className="mb-2 text-sm font-medium text-rose-700">
          Mermaid 渲染失败，已显示源码。
        </p>
        <pre className="overflow-x-auto whitespace-pre-wrap text-sm text-rose-900">
          {code}
        </pre>
      </div>
    )
  }

  if (!svg) {
    return (
      <div className="my-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-500">
        Mermaid 渲染中...
      </div>
    )
  }

  return (
    <div
      className="my-4 overflow-x-auto rounded-md border border-slate-200 bg-white p-3"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

function Home() {
  const [markdown, setMarkdown] = useState(starterMarkdown)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [downloadHint, setDownloadHint] = useState<string | null>(null)
  const [manualDownload, setManualDownload] = useState<ManualDownloadLink | null>(null)
  const [isDownloading, setIsDownloading] = useState(false)
  const [mermaidSvgMap, setMermaidSvgMap] = useState<Record<string, string>>({})
  const downloadUrlRef = useRef<string | null>(null)

  const exportDocx = useServerFn(convertMarkdownToDocx)

  const normalizedMarkdown = useMemo(
    () => normalizeAiMathSyntax(markdown),
    [markdown],
  )

  const mermaidSources = useMemo(
    () => extractMermaidSources(normalizedMarkdown),
    [normalizedMarkdown],
  )

  const uniqueMermaidSourceCount = useMemo(
    () => new Set(mermaidSources).size,
    [mermaidSources],
  )

  const mermaidPendingCount = useMemo(() => {
    const uniqueSources = new Set(mermaidSources)
    let renderedCount = 0

    for (const source of uniqueSources) {
      if (mermaidSvgMap[source]) {
        renderedCount += 1
      }
    }

    return Math.max(0, uniqueSources.size - renderedCount)
  }, [mermaidSources, mermaidSvgMap])

  useEffect(() => {
    const activeSources = new Set(mermaidSources)

    setMermaidSvgMap((previous) => {
      const next: Record<string, string> = {}
      let changed = false

      for (const [source, svg] of Object.entries(previous)) {
        if (activeSources.has(source)) {
          next[source] = svg
        } else {
          changed = true
        }
      }

      if (!changed && Object.keys(next).length === Object.keys(previous).length) {
        return previous
      }

      return next
    })
  }, [mermaidSources])

  useEffect(() => {
    return () => {
      if (downloadUrlRef.current) {
        URL.revokeObjectURL(downloadUrlRef.current)
      }
    }
  }, [])

  const handleMermaidRendered = (source: string, svg: string) => {
    const normalizedSource = source.trim()
    if (!normalizedSource) return

    setMermaidSvgMap((previous) => {
      if (previous[normalizedSource] === svg) {
        return previous
      }
      return {
        ...previous,
        [normalizedSource]: svg,
      }
    })
  }

  const markdownComponents = useMemo<Components>(
    () => ({
      pre({ children }) {
        if (isValidElement(children) && children.type === MermaidBlock) {
          return <>{children}</>
        }
        return <pre>{children}</pre>
      },
      code({ className, children, ...props }: any) {
        const language = className?.replace('language-', '').trim().toLowerCase()
        const code = String(children ?? '').replace(/\n$/, '')

        if (language === 'mermaid') {
          return (
            <MermaidBlock code={code} onSvgRendered={handleMermaidRendered} />
          )
        }

        return (
          <code className={className} {...props}>
            {children}
          </code>
        )
      },
    }),
    [],
  )

  const handleClear = () => {
    setMarkdown('')
    setDownloadError(null)
    setDownloadHint(null)

    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current)
      downloadUrlRef.current = null
    }
    setManualDownload(null)
  }

  const handleDownload = async () => {
    const normalized = normalizedMarkdown.trim()
    if (!normalized) {
      setDownloadError('请先输入 Markdown 内容')
      return
    }

    setDownloadError(null)
    setDownloadHint(null)
    setIsDownloading(true)

    try {
      const mermaidSvgs = Object.entries(mermaidSvgMap).map(([source, svg]) => ({
        source,
        svg,
      }))

      const result = await exportDocx({
        data: {
          markdown: normalized,
          fileName: 'markdown-export',
          mermaidSvgs,
        },
      })

      const blob = decodeBase64ToBlob(result.base64, result.mimeType)
      const url = URL.createObjectURL(blob)

      if (downloadUrlRef.current) {
        URL.revokeObjectURL(downloadUrlRef.current)
      }
      downloadUrlRef.current = url
      setManualDownload({
        url,
        fileName: result.fileName,
      })

      const link = document.createElement('a')
      link.href = url
      link.download = result.fileName
      document.body.appendChild(link)
      link.click()
      link.remove()

      setDownloadHint('已触发下载；如果浏览器未自动保存，请点击下方“手动下载”。')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setDownloadError(message)
    } finally {
      setIsDownloading(false)
    }
  }

  return (
    <main className="min-h-screen bg-slate-200 p-4 md:p-6">
      <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-3">
        <p className="text-center text-lg font-medium text-slate-900">
          Markdown 转 Word（Pandoc 真转换 · 公式/流程图预览）
        </p>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-300 bg-white p-3 shadow-sm">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-blue-100 px-3 py-1 text-xs font-medium text-blue-700">
                左侧：粘贴 Markdown
              </span>
              <button
                type="button"
                onClick={() => setMarkdown(starterMarkdown)}
                className="rounded-md bg-green-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-600"
              >
                载入示例
              </button>
              <button
                type="button"
                onClick={handleClear}
                className="rounded-md bg-slate-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-600"
              >
                清空
              </button>
              <button
                type="button"
                onClick={() => void handleDownload()}
                disabled={isDownloading}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
              >
                {isDownloading ? 'Pandoc 导出中...' : '下载 .docx'}
              </button>
            </div>

            <textarea
              value={markdown}
              onChange={(event) => setMarkdown(event.target.value)}
              placeholder="在这里粘贴从 AI 对话复制的 Markdown 内容..."
              className="h-[70vh] w-full resize-none rounded-lg border border-slate-300 bg-slate-50 p-4 font-mono text-[15px] leading-7 text-slate-800 outline-none ring-blue-500 focus:ring"
            />

            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <span className="rounded-full bg-slate-100 px-2 py-1">
                公式语法：$...$ / $$...$$ / \(...\) / \[...\]
              </span>
              <span className="rounded-full bg-slate-100 px-2 py-1">
                Mermaid: {uniqueMermaidSourceCount} 个图
              </span>
              {mermaidPendingCount > 0 && (
                <span className="rounded-full bg-amber-100 px-2 py-1 text-amber-700">
                  {mermaidPendingCount} 个流程图渲染中
                </span>
              )}
            </div>

            {downloadError && (
              <p className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">
                {downloadError}
              </p>
            )}

            {downloadHint && !downloadError && (
              <div className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                <p>{downloadHint}</p>
                {manualDownload && (
                  <a
                    href={manualDownload.url}
                    download={manualDownload.fileName}
                    className="mt-1 inline-flex font-semibold underline"
                  >
                    手动下载 {manualDownload.fileName}
                  </a>
                )}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-300 bg-white p-3 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-medium text-violet-700">
                右侧：Word 样式预览（含公式、Mermaid）
              </span>
              <span className="text-xs text-slate-500">实时同步</span>
            </div>

            <div className="h-[70vh] overflow-y-auto rounded-lg border border-slate-200 bg-slate-100 p-4">
              <article
                className="mx-auto min-h-full max-w-[850px] bg-white p-8 text-[16px] leading-7 text-slate-800 shadow-sm
                  [&_.katex-display]:my-4 [&_.katex-display]:overflow-x-auto
                  [&_blockquote]:border-l-4 [&_blockquote]:border-slate-300 [&_blockquote]:pl-4 [&_blockquote]:text-slate-600
                  [&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[0.9em]
                  [&_h1]:mb-4 [&_h1]:text-4xl [&_h1]:font-bold
                  [&_h2]:mb-3 [&_h2]:mt-7 [&_h2]:text-2xl [&_h2]:font-semibold
                  [&_h3]:mb-2 [&_h3]:mt-6 [&_h3]:text-xl [&_h3]:font-semibold
                  [&_li]:ml-6 [&_li]:list-disc [&_ol_li]:list-decimal
                  [&_p]:my-3
                  [&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-slate-900 [&_pre]:p-4 [&_pre]:text-slate-100
                  [&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-slate-300 [&_td]:p-2 [&_th]:border [&_th]:border-slate-300 [&_th]:p-2"
              >
                {normalizedMarkdown.trim().length > 0 ? (
                  <ReactMarkdown
                    components={markdownComponents}
                    remarkPlugins={[remarkGfm, remarkMath]}
                    rehypePlugins={[rehypeKatex]}
                  >
                    {normalizedMarkdown}
                  </ReactMarkdown>
                ) : (
                  <p className="text-slate-400">暂无内容，左侧粘贴 Markdown 后会自动预览。</p>
                )}
              </article>
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}
