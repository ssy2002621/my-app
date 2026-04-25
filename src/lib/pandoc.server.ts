import { createServerFn } from '@tanstack/react-start'

type MermaidSvgPayload = {
  source: string
  svg: string
}

type ConvertPayload = {
  markdown: string
  fileName?: string
  mermaidSvgs?: Array<MermaidSvgPayload>
}

type ConvertResult = {
  fileName: string
  mimeType: string
  base64: string
}

const MAX_MARKDOWN_LENGTH = 500_000

function sanitizeFileName(input: string) {
  return input
    .replace(/\.docx$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

function validatePayload(input: unknown): ConvertPayload {
  if (!input || typeof input !== 'object') {
    throw new Error('无效请求：缺少转换参数')
  }

  const data = input as ConvertPayload

  if (typeof data.markdown !== 'string') {
    throw new Error('无效请求：markdown 必须是字符串')
  }

  if (data.markdown.length > MAX_MARKDOWN_LENGTH) {
    throw new Error('Markdown 内容过大，请分段导出')
  }

  if (
    data.fileName !== undefined &&
    (typeof data.fileName !== 'string' || data.fileName.length > 120)
  ) {
    throw new Error('无效请求：fileName 不合法')
  }

  if (data.mermaidSvgs !== undefined) {
    if (!Array.isArray(data.mermaidSvgs)) {
      throw new Error('无效请求：mermaidSvgs 必须是数组')
    }

    for (const item of data.mermaidSvgs) {
      if (!item || typeof item !== 'object') {
        throw new Error('无效请求：mermaidSvgs 项目不合法')
      }
      if (typeof item.source !== 'string' || typeof item.svg !== 'string') {
        throw new Error('无效请求：mermaidSvgs 字段不合法')
      }
    }
  }

  return data
}

async function replaceMermaidBlocksWithImages(
  markdown: string,
  mermaidSvgs: Array<MermaidSvgPayload>,
  tempDir: string,
) {
  const { writeFile } = await import('node:fs/promises')
  const path = await import('node:path')

  const svgMap = new Map<string, string>()
  for (const item of mermaidSvgs) {
    const source = item.source.trim()
    const svg = item.svg.trim()
    if (!source || !svg.startsWith('<svg')) continue
    if (!svgMap.has(source)) {
      svgMap.set(source, svg)
    }
  }

  const regex = /```mermaid[^\n]*\n([\s\S]*?)```/g
  const parts: Array<string> = []
  let lastIndex = 0
  let imageIndex = 0

  for (const match of markdown.matchAll(regex)) {
    const fullMatch = match[0]
    const sourceRaw = match[1] ?? ''
    const source = sourceRaw.trim()
    const matchIndex = match.index ?? 0

    parts.push(markdown.slice(lastIndex, matchIndex))

    const svg = svgMap.get(source)
    if (svg) {
      imageIndex += 1
      const svgPath = path.join(tempDir, `mermaid-${imageIndex}.svg`)
      await writeFile(svgPath, svg, 'utf8')

      const normalizedPath = svgPath.replace(/\\/g, '/')
      parts.push(`\n![Mermaid 图 ${imageIndex}](${normalizedPath})\n`)
    } else {
      parts.push(`\n**Mermaid 图（导出为源码）**\n\n\`\`\`text\n${source}\n\`\`\`\n`)
    }

    lastIndex = matchIndex + fullMatch.length
  }

  parts.push(markdown.slice(lastIndex))
  return parts.join('')
}

export const convertMarkdownToDocx = createServerFn({ method: 'POST' })
  .inputValidator(validatePayload)
  .handler(async ({ data }): Promise<ConvertResult> => {
    const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')

    const execFileAsync = promisify(execFile)

    const tempDir = await mkdtemp(path.join(tmpdir(), 'md-to-docx-'))
    const safeBaseName = sanitizeFileName(data.fileName ?? 'markdown-export')
    const fileName = `${safeBaseName || 'markdown-export'}.docx`

    try {
      const inputMdPath = path.join(tempDir, 'input.md')
      const outputDocxPath = path.join(tempDir, fileName)
      const referenceDocPath = path.join(
        process.cwd(),
        'src/lib/templates/reference-black.docx',
      )

      const markdownWithMermaid = await replaceMermaidBlocksWithImages(
        data.markdown,
        data.mermaidSvgs ?? [],
        tempDir,
      )

      await writeFile(inputMdPath, markdownWithMermaid, 'utf8')

      await execFileAsync(
        'pandoc',
        [
          inputMdPath,
          '--from',
          'markdown+pipe_tables+strikeout+task_lists+autolink_bare_uris+tex_math_dollars+tex_math_single_backslash+raw_html',
          '--to',
          'docx',
          '--output',
          outputDocxPath,
          '--resource-path',
          tempDir,
          '--reference-doc',
          referenceDocPath,
          '--standalone',
        ],
        { maxBuffer: 20 * 1024 * 1024 },
      )

      const docxBuffer = await readFile(outputDocxPath)

      return {
        fileName,
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        base64: docxBuffer.toString('base64'),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Pandoc 导出失败：${message}`)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
