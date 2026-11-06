"use client"

import * as React from 'react'
import type { z } from 'zod'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { Label } from '@open-mercato/ui/primitives/label'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { definitionSchema } from '../../data/validators'
import type { StudioDefinition } from './tabs/types'

export type JsonProblemCode =
  | 'syntax'
  | 'currency'
  | 'type'
  | 'too_small'
  | 'too_big'
  | 'format'
  | 'not_allowed'
  | 'unknown_field'
  | 'shape'
  | 'rule'

/** `detail` is the raw parser or zod message, shown only as secondary text next to the translated problem. */
export type JsonApplyProblem = { path: string; code: JsonProblemCode; detail: string }

export type JsonApplyResult = { ok: true; definition: StudioDefinition } | { ok: false; problems: JsonApplyProblem[] }

const ZOD_PROBLEM_CODES: Partial<Record<z.ZodError['issues'][number]['code'], JsonProblemCode>> = {
  invalid_type: 'type',
  too_small: 'too_small',
  too_big: 'too_big',
  invalid_format: 'format',
  invalid_value: 'not_allowed',
  unrecognized_keys: 'unknown_field',
  invalid_union: 'shape',
}

const PROBLEM_MESSAGES: Record<JsonProblemCode, { key: string; fallback: string }> = {
  syntax: { key: 'product_configurator.studio.json.problems.syntax', fallback: 'The text is not valid JSON.' },
  currency: { key: 'product_configurator.studio.json.currencyMismatch', fallback: 'The currency must stay {currency}.' },
  type: { key: 'product_configurator.studio.json.problems.type', fallback: 'This value has the wrong type.' },
  too_small: { key: 'product_configurator.studio.json.problems.tooSmall', fallback: 'This value is too small or too short.' },
  too_big: { key: 'product_configurator.studio.json.problems.tooBig', fallback: 'This value is too large or too long.' },
  format: { key: 'product_configurator.studio.json.problems.format', fallback: 'This value has the wrong format.' },
  not_allowed: { key: 'product_configurator.studio.json.problems.notAllowed', fallback: 'This value is not allowed here.' },
  unknown_field: { key: 'product_configurator.studio.json.problems.unknownField', fallback: 'This field is not part of the definition.' },
  shape: { key: 'product_configurator.studio.json.problems.shape', fallback: 'This entry does not match any allowed shape.' },
  rule: { key: 'product_configurator.studio.json.problems.rule', fallback: 'This value breaks a definition rule.' },
}

/** Parses the JSON text as a whole definition: it must pass `definitionSchema` and keep the model currency. */
export function parseDefinitionJson(text: string, currencyCode: string): JsonApplyResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, problems: [{ path: '', code: 'syntax', detail: error instanceof Error ? error.message : '' }] }
  }
  const parsed = definitionSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        code: ZOD_PROBLEM_CODES[issue.code] ?? 'rule',
        detail: issue.message,
      })),
    }
  }
  if (parsed.data.commercial.currencyCode !== currencyCode) {
    return { ok: false, problems: [{ path: 'commercial.currencyCode', code: 'currency', detail: parsed.data.commercial.currencyCode }] }
  }
  return { ok: true, definition: parsed.data }
}

type DefinitionJsonEditorProps = {
  /** The JSON the editor shows until the admin types; a new value replaces the text when it is not being edited. */
  source: unknown
  currencyCode: string
  readOnly: boolean
  onApply: (definition: StudioDefinition) => void
  /** Reports text typed but not applied yet (`null` when there is none), so the studio guards and copies it. */
  onPendingChange?: (text: string | null) => void
}

export function DefinitionJsonEditor({ source, currencyCode, readOnly, onApply, onPendingChange }: DefinitionJsonEditorProps) {
  const t = useT()
  const sourceText = React.useMemo(() => JSON.stringify(source, null, 2) ?? '', [source])
  const [text, setText] = React.useState(sourceText)
  const [touched, setTouched] = React.useState(false)
  const [problems, setProblems] = React.useState<JsonApplyProblem[]>([])
  const textareaId = React.useId()
  const problemsId = React.useId()
  const pendingText = touched && text !== sourceText ? text : null

  React.useEffect(() => {
    if (touched) return
    setText(sourceText)
  }, [sourceText, touched])

  React.useEffect(() => {
    onPendingChange?.(pendingText)
  }, [onPendingChange, pendingText])

  React.useEffect(() => () => onPendingChange?.(null), [onPendingChange])

  const apply = () => {
    const result = parseDefinitionJson(text, currencyCode)
    if (!result.ok) {
      setProblems(result.problems)
      return
    }
    setProblems([])
    setTouched(false)
    onApply(result.definition)
  }

  const reset = () => {
    setText(sourceText)
    setTouched(false)
    setProblems([])
  }

  const problemMessage = (problem: JsonApplyProblem) => {
    const message = PROBLEM_MESSAGES[problem.code]
    return t(message.key, message.fallback, { currency: currencyCode })
  }

  const canApply = !readOnly && touched

  return (
    <div className="space-y-3" data-testid="studio-json-editor">
      <div className="space-y-1">
        <Label htmlFor={textareaId}>{t('product_configurator.studio.json.label', 'Definition (JSON)')}</Label>
        <p className="text-sm text-muted-foreground">
          {t(
            'product_configurator.studio.json.help',
            'Apply checks the structure and puts the result in the draft. Save draft stores it, with the same lock as the other tabs.',
          )}
        </p>
      </div>
      <Textarea
        id={textareaId}
        className="min-h-96 font-mono text-xs"
        value={text}
        spellCheck={false}
        readOnly={readOnly}
        aria-invalid={problems.length > 0 ? true : undefined}
        aria-describedby={problems.length > 0 ? problemsId : undefined}
        onChange={(event) => {
          setText(event.target.value)
          setTouched(true)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
          event.preventDefault()
          if (canApply) apply()
        }}
      />
      {pendingText !== null ? (
        <p className="text-sm text-muted-foreground" data-testid="studio-json-pending">
          {t('product_configurator.studio.json.pendingHint', 'This text is not in the draft yet. Apply it or reset the text.')}
        </p>
      ) : null}
      {problems.length > 0 ? (
        <Alert status="error" id={problemsId}>
          <AlertTitle>{t('product_configurator.studio.json.invalid', 'The JSON cannot be applied')}</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {problems.slice(0, 20).map((problem, index) => (
                <li key={`${problem.path}-${index}`}>
                  <span>{problemMessage(problem)}</span>
                  {problem.path || problem.detail ? (
                    <span className="block text-xs text-muted-foreground">
                      {problem.path ? <code className="font-mono">{problem.path}</code> : null}
                      {problem.path && problem.detail ? ' ' : null}
                      {problem.detail}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={apply} disabled={!canApply}>
          {t('product_configurator.studio.json.apply', 'Apply to draft')}
        </Button>
        <Button type="button" variant="outline" onClick={reset} disabled={!touched}>
          {t('product_configurator.studio.json.reset', 'Reset text')}
        </Button>
      </div>
    </div>
  )
}
