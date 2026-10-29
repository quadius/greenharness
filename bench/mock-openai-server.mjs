#!/usr/bin/env node
/**
 * Scripted OpenAI-compatible chat-completions server for offline tests.
 *
 * It replays a fixed list of assistant steps (tool calls or text), one per agent call, and logs
 * every request so a test can check which model served it, what tool results the model saw,
 * and whether the shared prompt prefix would have hit a KV/prompt cache. Calls without tools
 * (side calls such as title generation) get a fixed reply and do not consume a step. Usage is
 * estimated from the serialized message history (about four characters per token). It is a
 * plumbing double, not a model: use it to verify routing and context edits, never to measure
 * quality.
 *
 * Usage: node bench/mock-openai-server.mjs --script <steps.json> --log <requests.jsonl> [--port 8123]
 */
import { createServer } from 'node:http'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * @typedef {{ tool_calls?: Array<{ name: string, arguments: Record<string, unknown> }>, content?: string }} Step
 * @typedef {{ steps: Step[] }} Script
 */

/**
 * Start the server.
 * @param {{ port?: number, steps: Step[], logPath?: string }} options
 * @returns {Promise<{ url: string, close(): Promise<void>, requests: number }>}
 */
export function startMockServer({ port = 0, steps, logPath }) {
  let requestCount = 0
  let agentCalls = 0
  const previousMessages = new Map()

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'mock only serves POST /v1/chat/completions' }))
      return
    }
    const body = JSON.parse(await readBody(req))
    requestCount += 1
    const index = requestCount - 1
    // Agent calls declare tools; side calls (for example, title generation) do not. Only agent
    // calls consume scripted steps, so a side call cannot shift the script.
    const agentCall = Array.isArray(body.tools) && body.tools.length > 0
    const agentStep = agentCall ? agentCalls : null
    if (agentCall) agentCalls += 1
    const step = agentCall
      ? (agentStep < steps.length ? steps[agentStep] : { content: 'Done.' })
      : { content: 'ok' }
    const toolCalls = (step.tool_calls ?? []).map((call, i) => ({
      id: `call_${index}_${i}`,
      name: call.name,
      arguments: JSON.stringify(call.arguments ?? {}),
    }))

    const serialized = JSON.stringify(body.messages ?? [])
    const model = String(body.model ?? 'unknown')
    const previous = previousMessages.get(model) ?? ''
    const promptTokens = Math.ceil(serialized.length / 4)
    const cachedTokens = Math.ceil(commonPrefixLength(previous, serialized) / 4)
    previousMessages.set(model, serialized)
    const completionText = toolCalls.length > 0 ? JSON.stringify(toolCalls.map(c => c.name)) : (step.content ?? '')
    const completionTokens = Math.max(1, Math.ceil(completionText.length / 4))
    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      prompt_tokens_details: { cached_tokens: cachedTokens },
    }

    const messages = body.messages ?? []
    logRequest(logPath, {
      n: requestCount, agentCall, agentStep: agentCall ? agentStep + 1 : null,
      model, stream: body.stream === true, messageCount: messages.length,
      roles: messages.map(m => m.role),
      noticeCount: messages.filter(m => contentToText(m.content).includes('[model changed:')).length,
      promptTokens, cachedTokens, bodyKeys: Object.keys(body).sort(),
      chatTemplateKwargs: body.chat_template_kwargs ?? null,
      reasoningEffort: body.reasoning_effort ?? body.reasoning?.effort ?? null,
      thinkingBudget: body.thinking_token_budget ?? body.thinking_budget ?? null,
      toolMessages: messages.filter(m => m.role === 'tool').map(m => contentToText(m.content)),
    })

    const finish = toolCalls.length > 0 ? 'tool_calls' : 'stop'
    if (body.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: `chatcmpl-${index}`, object: 'chat.completion', created: now(), model,
        choices: [{
          index: 0, finish_reason: finish,
          message: {
            role: 'assistant', content: step.content ?? null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls.map(toOpenAiToolCall) } : {}),
          },
        }],
        usage,
      }))
      return
    }

    const base = { id: `chatcmpl-${index}`, object: 'chat.completion.chunk', created: now(), model }
    const chunks = [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }]
    if (step.content) chunks.push({ ...base, choices: [{ index: 0, delta: { content: step.content }, finish_reason: null }] })
    toolCalls.forEach((call, i) => chunks.push({
      ...base,
      choices: [{ index: 0, delta: { tool_calls: [{ index: i, ...toOpenAiToolCall(call) }] }, finish_reason: null }],
    }))
    chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })
    chunks.push({ ...base, choices: [], usage })

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      const actualPort = typeof address === 'object' && address !== null ? address.port : port
      resolve({
        url: `http://127.0.0.1:${actualPort}/v1`,
        get requests() { return requestCount },
        close: () => new Promise((done) => {
          server.closeAllConnections?.()
          server.close(() => done())
        }),
      })
    })
  })
}

/**
 * @param {{ id: string, name: string, arguments: string }} call
 */
function toOpenAiToolCall(call) {
  return { id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/**
 * @param {string} a
 * @param {string} b
 */
function commonPrefixLength(a, b) {
  const limit = Math.min(a.length, b.length)
  let i = 0
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i += 1
  return i
}

/**
 * @param {unknown} content
 */
function contentToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => (part && typeof part === 'object' && 'text' in part ? String(part.text) : '')).join('')
  return ''
}

/**
 * @param {string | undefined} path
 * @param {Record<string, unknown>} record
 */
function logRequest(path, record) {
  if (!path) return
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`)
}

function now() {
  return Math.floor(Date.now() / 1000)
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const options = { port: 8123, script: undefined, log: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port') options.port = Number(argv[++i])
    else if (argv[i] === '--script') options.script = argv[++i]
    else if (argv[i] === '--log') options.log = argv[++i]
  }
  return options
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const options = parseArgs(process.argv.slice(2))
  /** @type {Script} */
  const script = options.script ? JSON.parse(readFileSync(options.script, 'utf8')) : { steps: [] }
  const server = await startMockServer({ port: options.port, steps: script.steps, logPath: options.log })
  console.log(`mock OpenAI server on ${server.url} with ${script.steps.length} scripted steps`)
}
