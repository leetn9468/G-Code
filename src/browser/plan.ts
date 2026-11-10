import { z } from 'zod'

const name = z.string().min(1).max(160)
const selector = z.string().min(1).max(500)
const expression = z.string().min(1).max(4000)
const legacyPlanSchema = z.object({
  version: z.literal(1),
  entry: z.string().min(1).max(500).default('index.html'),
  headed: z.boolean().default(false),
  viewport: z.object({ width: z.number().int().min(240).max(2560), height: z.number().int().min(240).max(1600) }).default({ width: 1280, height: 800 }),
  steps: z.array(z.discriminatedUnion('action', [
    z.object({ name, action: z.literal('click'), selector }),
    z.object({ name, action: z.literal('press'), key: z.string().min(1).max(80) }),
    z.object({ name, action: z.literal('assert'), expression, timeout_ms: z.number().int().min(1).max(15000).default(5000) }),
    z.object({ name, action: z.literal('capture'), key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/), expression }),
    z.object({ name, action: z.literal('wait'), ms: z.number().int().min(0).max(5000) }),
    z.object({ name, action: z.literal('screenshot') }),
    z.object({ name, action: z.literal('viewport'), width: z.number().int().min(240).max(2560), height: z.number().int().min(240).max(1600) }),
    z.object({ name, action: z.literal('background'), ms: z.number().int().min(100).max(5000).default(500) }),
  ])).min(1).max(60),
}).strict().refine(value => value.steps.some(step => step.action === 'assert'), 'At least one real assertion is required')
export type BrowserPlan = z.infer<typeof browserPlanSchema>

const viewport = z.object({ width: z.number().int().min(240).max(2560), height: z.number().int().min(240).max(1600) }).strict()
export const expectationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), selector, equals: z.string().min(1).max(2000) }).strict(),
  z.object({ kind: z.literal('value'), selector, equals: z.string().max(2000) }).strict(),
  z.object({ kind: z.literal('visible'), selector, equals: z.boolean() }).strict(),
  z.object({ kind: z.literal('checked'), selector, equals: z.boolean() }).strict(),
  z.object({ kind: z.literal('count'), selector, equals: z.number().int().min(0).max(10000) }).strict(),
  z.object({ kind: z.literal('title'), equals: z.string().min(1).max(500) }).strict(),
  z.object({ kind: z.literal('path'), equals: z.string().regex(/^\/.*$/).max(500) }).strict(),
  z.object({ kind: z.literal('no-horizontal-overflow') }).strict(),
]).describe('text compares the words the element shows: a line break (<br>) and each block\'s edges read as a space, hidden elements left out, each run of whitespace one space and the ends trimmed; equals is read the same way. The selector of text, value, visible and checked must match exactly one element.')
export const structuredStepSchema = z.discriminatedUnion('action', [
  z.object({ name, action: z.literal('click'), selector }).strict(),
  z.object({ name, action: z.literal('fill'), selector, value: z.string().max(4000) }).strict(),
  z.object({ name, action: z.literal('check'), selector, checked: z.boolean() }).strict(),
  z.object({ name, action: z.literal('select'), selector, value: z.string().max(500) }).strict(),
  z.object({ name, action: z.literal('press'), key: z.string().min(1).max(80) }).strict(),
  z.object({ name, action: z.literal('expect'), expected: expectationSchema, timeout_ms: z.number().int().min(1).max(15000).default(5000) }).strict(),
  z.object({ name, action: z.literal('wait'), ms: z.number().int().min(0).max(5000) }).strict(),
  z.object({ name, action: z.literal('screenshot') }).strict(),
  z.object({ name, action: z.literal('viewport'), ...viewport.shape }).strict(),
  z.object({ name, action: z.literal('background'), ms: z.number().int().min(100).max(5000).default(500) }).strict(),
])
export const structuredPlanSchema = z.object({
  version: z.literal(2), entry: z.string().min(1).max(500).default('index.html'),
  seed: z.number().int().min(0).max(4294967295).default(1),
  headed: z.boolean().default(false), viewport: viewport.default({ width: 1280, height: 800 }),
  server: z.object({
    command: z.string().min(1).max(500),
    args: z.array(z.string().max(1000)).max(40).describe('Must contain the literal text {port}: G-Code picks a free loopback port and puts it there. Never hard-code a port. Example: ["-m","http.server","{port}","--bind","127.0.0.1"]'),
    path: z.string().regex(/^\/.*$/).max(500).optional().describe('URL path the browser opens on the server, for example "/menu.html". With a server the browser opens this path, not entry; it may be left out only for an index.html entry, which opens "/".'),
    ready_timeout_ms: z.number().int().min(1000).max(30000).default(15000),
  }).strict().refine(value => value.args.some(arg => arg.includes('{port}')), 'Server args must include {port}; G-Code assigns its own loopback port').optional()
    .describe('Optional development server G-Code starts for the run. Its args must contain {port}.'),
  steps: z.array(structuredStepSchema).min(1).max(60),
}).strict().superRefine((plan, ctx) => {
  if (!plan.steps.some(step => step.action === 'expect')) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one structured expectation is required' })
  const names = new Set<string>()
  for (const step of plan.steps) { if (names.has(step.name)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate step name: ${step.name}` }); names.add(step.name) }
  if (plan.server?.path && (plan.server.path.startsWith('//') || plan.server.path.includes('\\'))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Server path must stay on the assigned origin' })
  // With a server the browser opens server.path, so an entry other than an index page needs its own path.
  if (plan.server && plan.server.path === undefined && !/^index\.html?$/i.test(plan.entry.split(/[\\/]/).at(-1) ?? '')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `With a server the browser opens server.path, not entry. Set server.path to the URL of ${plan.entry} on that server, for example "/${plan.entry.split(/[\\/]/).at(-1)}".` })
  }
})
export const browserPlanSchema = z.union([structuredPlanSchema, legacyPlanSchema])
